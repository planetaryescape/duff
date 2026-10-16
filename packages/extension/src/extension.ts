import { makeAzureCliAuthenticationLayer } from '@duff/core/azure-cli-authentication'
import { makeGitContextLayer } from '@duff/core/git-context'
import { pullRequestsLayer } from '@duff/core/pull-request-providers'
import { PullRequestReview } from '@duff/core/pull-request-review'
import { makeGitReviewLayer } from '@duff/core/review'
import { ReviewSession } from '@duff/core/review-session'
import { ReviewSessions } from '@duff/core/saved-review-sessions'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/http'
import * as vscode from 'vscode'

import { registerGitContextCommands } from './git-context/GitContextCommands'
import { authenticationLayer } from './pull-requests/ProviderAuthentication'
import { registerPullRequestCommands } from './pull-requests/PullRequestCommands'
import { registerReviewCommands } from './review/ReviewCommands'
import { makeSavedReviewStoreLayer } from './review/SavedReviewStore'
import { observabilityLayer } from './telemetry/Telemetry'

let disposeRuntime: (() => Promise<void>) | undefined

export function activate(context: vscode.ExtensionContext) {
  const observability =
    context.extensionMode === vscode.ExtensionMode.Development
      ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer))
      : Layer.empty

  const gitContextLayer = makeGitContextLayer(process.env)

  const providers = pullRequestsLayer.pipe(
    Layer.provide(
      authenticationLayer.pipe(Layer.provide(makeAzureCliAuthenticationLayer(process.env))),
    ),
  )

  const sessionLayer = ReviewSession.layer.pipe(
    Layer.provide(Layer.merge(gitContextLayer, providers)),
  )

  const reviewLayer = makeGitReviewLayer(process.env)

  const savedSessions = ReviewSessions.layer.pipe(
    Layer.provide(Layer.merge(reviewLayer, makeSavedReviewStoreLayer(context.storageUri?.fsPath))),
  )

  const preparation = PullRequestReview.layer.pipe(
    Layer.provide(Layer.mergeAll(reviewLayer, providers, savedSessions)),
  )

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(reviewLayer, gitContextLayer, sessionLayer, preparation, savedSessions).pipe(
      Layer.provideMerge(observability),
    ),
  )

  disposeRuntime = () => runtime.dispose()
  registerPullRequestCommands(context, runtime)

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
    }),
  )

  if (vscode.workspace.workspaceFolders?.length === 1) startInspection()
}

export async function deactivate() {
  await disposeRuntime?.()
  disposeRuntime = undefined
}
