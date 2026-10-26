import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'

import { makeAzureCliAuthenticationLayer } from '@duff/core/azure-cli-authentication'
import { DashboardData } from '@duff/core/dashboard-data'
import { makeGitContextLayer } from '@duff/core/git-context'
import { makeGitHubCredentialsLayer } from '@duff/core/github-credentials'
import { pullRequestsLayer } from '@duff/core/pull-request-providers'
import { PullRequestReview } from '@duff/core/pull-request-review'
import { makeGitReviewLayer } from '@duff/core/review'
import { ReviewSession } from '@duff/core/review-session'
import { makeReviewWorkspacesLayer } from '@duff/core/review-workspaces'
import { ReviewSessions } from '@duff/core/saved-review-sessions'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/http'
import * as vscode from 'vscode'

import { registerDashboardCommands } from './dashboard/DashboardCommands'
import { dashboardDataDirectory } from './dashboard/DataDirectory'
import { makeRepositoryStoreLayer } from './dashboard/RepositoryStore'
import { makeSharedReviewStoreLayer } from './dashboard/SharedReviewStore'
import { registerGitContextCommands } from './git-context/GitContextCommands'
import { authenticationLayer } from './pull-requests/ProviderAuthentication'
import { registerPullRequestCommands } from './pull-requests/PullRequestCommands'
import { registerReviewCommands } from './review/ReviewCommands'
import { makeSavedReviewStoreLayer } from './review/SavedReviewStore'
import { installedObservabilityLayer, observabilityLayer } from './telemetry/Telemetry'

let disposeRuntime: (() => Promise<void>) | undefined

export function activate(context: vscode.ExtensionContext) {
  const dataDirectory = dashboardDataDirectory({
    platform: process.platform,
    homedir: homedir(),
    environment: process.env,
  })

  const folder =
    vscode.workspace.workspaceFolders?.length === 1
      ? vscode.workspace.workspaceFolders[0]?.uri
      : undefined

  const managedPath =
    folder?.scheme === 'file'
      ? relative(join(dataDirectory, 'review-workspaces'), folder.fsPath)
      : undefined

  const managed =
    managedPath !== undefined &&
    managedPath !== '' &&
    !managedPath.startsWith('..') &&
    !isAbsolute(managedPath)

  const telemetry = vscode.workspace.getConfiguration('duff').get<string>('telemetry')

  const observability =
    context.extensionMode === vscode.ExtensionMode.Development
      ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer))
      : context.extensionMode === vscode.ExtensionMode.Production && telemetry === 'local'
        ? installedObservabilityLayer.pipe(Layer.provide(FetchHttpClient.layer))
        : Layer.empty

  const gitContextLayer = makeGitContextLayer(process.env)

  const providers = pullRequestsLayer.pipe(
    Layer.provide(
      authenticationLayer.pipe(
        Layer.provide(
          Layer.merge(
            makeAzureCliAuthenticationLayer(process.env),
            makeGitHubCredentialsLayer(process.env),
          ),
        ),
      ),
    ),
  )

  const sessionLayer = ReviewSession.layer.pipe(
    Layer.provide(Layer.merge(gitContextLayer, providers)),
  )

  const reviewLayer = makeGitReviewLayer(process.env)

  const savedSessions = ReviewSessions.layer.pipe(
    Layer.provide(
      Layer.merge(
        reviewLayer,
        managed && folder
          ? makeSharedReviewStoreLayer(dataDirectory, folder.fsPath)
          : makeSavedReviewStoreLayer(context.storageUri?.fsPath),
      ),
    ),
  )

  const preparation = PullRequestReview.layer.pipe(
    Layer.provide(Layer.mergeAll(reviewLayer, providers, savedSessions)),
  )

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reviewLayer,
      gitContextLayer,
      sessionLayer,
      preparation,
      savedSessions,
      providers,
      DashboardData.layer.pipe(Layer.provide(providers)),
      makeRepositoryStoreLayer(dataDirectory),
      makeReviewWorkspacesLayer(dataDirectory, process.env),
    ).pipe(Layer.provideMerge(observability)),
  )

  disposeRuntime = () => runtime.dispose()
  registerPullRequestCommands(context, runtime)
  const dashboard = registerDashboardCommands(context, runtime)

  const startInspection = (root?: string) =>
    runtime.runFork(Effect.promise(() => gitContext.inspect(root, false)))

  const review = registerReviewCommands(context, runtime, (root) => {
    startInspection(root)
  })

  const gitContext = registerGitContextCommands(context, runtime, review.currentRoot)

  const resetInspection = (reason: 'authentication' | 'configuration') =>
    runtime.runFork(
      Effect.gen(function* () {
        const session = yield* ReviewSession
        const state = yield* session.current()

        if (
          reason === 'authentication' &&
          state._tag === 'Active' &&
          state.rows.some((row) => row.activity === 'Connecting')
        )
          return
        yield* session.clear()

        if (state._tag === 'Active')
          yield* Effect.promise(() => gitContext.inspect(state.directory, false))
        else if (vscode.workspace.workspaceFolders?.length === 1)
          yield* Effect.promise(() => gitContext.inspect(undefined, false))
      }),
    )

  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') resetInspection('authentication')
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      runtime.runFork(
        ReviewSession.use((session) =>
          session.clear().pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (vscode.workspace.workspaceFolders?.length === 1)
                  startInspection(vscode.workspace.workspaceFolders[0]?.uri.fsPath)
              }),
            ),
          ),
        ),
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('duff.automaticDiscovery')) resetInspection('configuration')

      if (event.affectsConfiguration('duff.telemetry'))
        runtime.runFork(
          Effect.promise(async () => {
            const choice = await vscode.window.showInformationMessage(
              'Duff: Reload the window to apply the telemetry setting.',
              'Reload Window',
            )

            if (choice === 'Reload Window')
              await vscode.commands.executeCommand('workbench.action.reloadWindow')
          }),
        )
    }),
  )

  if (vscode.workspace.workspaceFolders?.length === 1) startInspection()
  else if (!vscode.workspace.workspaceFolders?.length) dashboard.open()
}

export async function deactivate() {
  await disposeRuntime?.()
  disposeRuntime = undefined
}
