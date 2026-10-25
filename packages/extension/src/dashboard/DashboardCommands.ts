import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import {
  hostedRepositoryId,
  RepositoryCatalog,
  HostedRepository,
  WatchedRepository,
} from '@duff/core/dashboard-repositories'
import { GitContext } from '@duff/core/git-context'
import { PullRequestState } from '@duff/core/git-hosting-provider'
import { RepositoryDirectory, RepositorySource } from '@duff/core/repository-directory'
import { ReviewWorkspaces } from '@duff/core/review-workspaces'
import { Data, Effect, Option, type Redacted, Schema } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { dashboardHtml } from './DashboardHtml'
import { DashboardState } from './DashboardState'

const Message = Schema.Struct({
  action: Schema.Literals([
    'ready',
    'picker',
    'dashboard',
    'source',
    'browse',
    'suggestion',
    'folders',
    'url',
    'toggle',
    'add',
    'repository',
    'state',
    'refresh',
    'more',
    'pull',
    'review',
    'external',
    'local',
    'remove',
    'connect',
  ]),
  id: Schema.optionalKey(Schema.String),
})

class DashboardEvent extends Data.Class<{
  readonly type: 'state'
  readonly value: DashboardState
}> {}

class DashboardCommands {
  constructor(readonly open: () => void) {}
}

class LocalFolder {
  constructor(
    readonly folder: vscode.Uri,
    readonly children: ReadonlyArray<[string, vscode.FileType]>,
  ) {}
}

/** Owns the webview, native dialogs and cancellable workflows, never provider-specific routing. */
export function registerDashboardCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
) {
  let panel: vscode.WebviewPanel | undefined
  const state = new DashboardState()
  const candidates = new Map<string, WatchedRepository>()
  const local = new Map<string, WatchedRepository>()
  const sources = new Map<string, RepositorySource>()
  let cursor: Option.Option<Redacted.Redacted> = Option.none()
  let page = 1
  let activeSource: RepositorySource | undefined
  let abort = new AbortController()
  let generation = 0
  let preparing = false

  const render = async () => {
    state.selections = [...candidates.values()]
    state.sources = [...sources.values()]
    await panel?.webview.postMessage(new DashboardEvent({ type: 'state', value: state }))
  }

  const reset = () => {
    abort.abort()
    abort = new AbortController()
    generation++
    state.busy = false
    state.message = ''
    state.error = false
    state.more = false
    cursor = Option.none()
    page = 1
  }

  const remember = (repository: WatchedRepository) => {
    const previous = candidates.get(repository.id)

    const item = WatchedRepository.make({
      id: repository.id,
      name: repository.name,
      hosting: repository.hosting,
      localPaths: [...new Set([...(previous?.localPaths ?? []), ...repository.localPaths])],
    })

    candidates.set(item.id, item)

    return item
  }

  const fromHosted = (repository: HostedRepository) =>
    WatchedRepository.make({
      id: hostedRepositoryId(repository),
      name: repository.repository.displayName,
      hosting: Option.some(repository),
      localPaths: [],
    })

  const refreshCatalog = async () => {
    const repositories = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryCatalog.use((store) => store.list()),
    )

    if (!repositories) return

    if (state.updateRepositories(repositories)) reset()

    const directory = await runtime.runPromise(RepositoryDirectory)
    state.providers = directory.providers

    for (const item of repositories) {
      if (Option.isSome(item.hosting)) {
        const source = directory.suggest(item.hosting.value)
        sources.set(source.id, source)
      }
    }

    await render()
  }

  const inspectLocal = async (paths: ReadonlyArray<string>) => {
    const current = generation
    const directory = await runtime.runPromise(RepositoryDirectory)

    const results = await runtime.runPromise(
      Effect.forEach(
        paths,
        (path) => GitContext.use((git) => git.inspect(path)).pipe(Effect.result),
        { concurrency: 4 },
      ),
    )

    if (current !== generation) return []
    const inspected = new Map<string, WatchedRepository>()
    let found = 0

    for (const result of results) {
      if (result._tag === 'Failure') continue
      const snapshot = result.success
      const recognized: HostedRepository[] = []

      for (const remote of snapshot.remotes) {
        const hosted = directory.recognize(remote.destination)

        if (
          Option.isSome(hosted) &&
          !recognized.some((item) => hostedRepositoryId(item) === hostedRepositoryId(hosted.value))
        )
          recognized.push(hosted.value)
      }

      if (!recognized.length) {
        const repository = remember(
          WatchedRepository.make({
            id: `local:${snapshot.root}`,
            name: basename(snapshot.root),
            hosting: Option.none(),
            localPaths: [snapshot.root],
          }),
        )

        local.set(repository.id, repository)
        inspected.set(repository.id, repository)
      }

      for (const hosted of recognized) {
        const source = directory.suggest(hosted)
        sources.set(source.id, source)

        const repository = remember(
          WatchedRepository.make({
            id: hostedRepositoryId(hosted),
            name: hosted.repository.displayName,
            hosting: Option.some(hosted),
            localPaths: [snapshot.root],
          }),
        )

        local.set(repository.id, repository)
        inspected.set(repository.id, repository)
      }

      found++
    }

    state.candidates = [...local.values()]
    state.message = found
      ? ''
      : 'No Git repositories found. Choose repository folders or a parent containing them.'

    return [...inspected.values()]
  }

  const loadPullRequests = async (more = false) => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)

    if (!repository || Option.isNone(repository.hosting)) return
    const hosted = repository.hosting.value
    const filter = state.filter

    if (!more) {
      reset()
      state.pulls = []
      state.pullRequestId = ''
    }

    const current = generation
    state.busy = true
    state.message = `Loading ${filter} pull requests…`
    await render()

    const result = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryDirectory.use((directory) =>
        directory.list(hosted, filter, more ? cursor : Option.none()),
      ),
      undefined,
      abort.signal,
    )

    if (current !== generation) return
    state.busy = false
    state.message = result
      ? ''
      : 'Could not load pull requests. Check access and retry with Refresh or Connect.'
    state.error = !result

    if (result) {
      const items = new Map(state.pulls.map((pr) => [pr.id, pr]))

      for (const pr of result.items) items.set(pr.id, pr)
      state.pulls = [...items.values()]
      cursor = result.next
      state.more = Option.isSome(cursor)
      state.pullRequestId ||= state.pulls[0]?.id ?? ''
    }

    await render()
  }

  const browse = async (source: RepositorySource, more = false) => {
    if (!more) {
      reset()
      state.candidates = []
    }

    activeSource = source
    state.sourceId = source.id
    state.sourceLabel = source.label
    const current = generation
    const requestedPage = more ? page + 1 : 1
    state.busy = true
    state.message = 'Loading repositories…'
    await render()

    const result = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryDirectory.use((directory) =>
        directory.browse(source.providerId, source.scope, requestedPage, 'connect'),
      ),
      undefined,
      abort.signal,
    )

    if (current !== generation) return
    state.busy = false
    state.message = result
      ? ''
      : 'Could not browse this source. Check the collection and provider access, then select it again to retry.'
    state.error = !result

    if (result) {
      page = requestedPage
      const visible = new Map(state.candidates.map((item) => [item.id, item]))

      for (const hosted of result.items) {
        const repository = remember(fromHosted(hosted))
        visible.set(repository.id, repository)
      }

      state.candidates = [...visible.values()]
      state.more = result.hasMore
    }

    await render()
  }

  const openReview = async (id: string, explicit?: HostedRepository) => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)

    const hosted = explicit ?? (repository ? Option.getOrUndefined(repository.hosting) : undefined)

    if (!hosted || preparing) return
    preparing = true

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Duff: Preparing isolated review workspace',
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController()
          const listener = token.onCancellationRequested(() => controller.abort())

          if (token.isCancellationRequested) controller.abort()

          try {
            progress.report({
              message: 'Resolving pinned revisions and downloading missing Git objects…',
            })

            const prepared = await runOperation(
              runtime,
              'Duff.prepareWorkspace',
              Effect.gen(function* () {
                const directory = yield* RepositoryDirectory
                const resolved = yield* directory.resolve(hosted, id)
                const workspaces = yield* ReviewWorkspaces

                return yield* workspaces.prepare(resolved)
              }),
              undefined,
              controller.signal,
            )

            if (prepared && !controller.signal.aborted)
              await vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(prepared.directory),
                { forceNewWindow: true },
              )
          } finally {
            listener.dispose()
          }
        },
      )
    } finally {
      preparing = false
    }
  }

  const dispatch = async (message: Schema.Schema.Type<typeof Message>) => {
    const { action, id = '' } = message

    if (action === 'ready') {
      await refreshCatalog()
      await loadPullRequests()
    } else if (action === 'picker') {
      reset()
      state.mode = 'picker'
      state.sourceId = 'local'
      await inspectLocal(
        (vscode.workspace.workspaceFolders ?? [])
          .filter((folder) => folder.uri.scheme === 'file')
          .map((folder) => folder.uri.fsPath),
      )
    } else if (action === 'dashboard') {
      reset()
      state.mode = 'dashboard'
      await refreshCatalog()
      await loadPullRequests()
    } else if (action === 'folders') {
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: true,
        title: 'Choose repositories or parent folders',
      })

      if (!folders) return
      reset()
      state.sourceId = 'local'
      state.busy = true
      const current = generation
      state.message = 'Inspecting selected folders…'
      await render()
      const paths: string[] = []

      const listings = await Promise.all(
        folders.map(
          async (folder) =>
            new LocalFolder(folder, await vscode.workspace.fs.readDirectory(folder)),
        ),
      )

      if (current !== generation) return

      for (const { folder, children } of listings) {
        paths.push(folder.fsPath)

        for (const [name, type] of children.slice(0, 500))
          if (
            type === vscode.FileType.Directory &&
            !name.startsWith('.') &&
            name !== 'node_modules'
          )
            paths.push(vscode.Uri.joinPath(folder, name).fsPath)
      }

      const inspected = await inspectLocal(paths)

      if (current !== generation) return
      state.selectRepositories(inspected)
      state.busy = false
    } else if (action === 'source') {
      reset()
      state.sourceId = 'local'
      state.candidates = [...local.values()]
    } else if (action === 'browse') {
      const directory = await runtime.runPromise(RepositoryDirectory)
      const provider = directory.providers.find((item) => item.id === id)

      if (!provider) return

      const scope = await vscode.window.showInputBox({
        title: `Browse ${provider.displayName} repositories`,
        prompt:
          'Collection: owner, organization, or organization/project. Leave empty for your account when supported.',
        ignoreFocusOut: true,
      })

      if (scope === undefined) return

      const source = RepositorySource.make({
        id: `${id}:${scope}`,
        providerId: id,
        scope,
        label: scope ? `${provider.displayName} · ${scope}` : provider.displayName,
      })

      sources.set(source.id, source)
      await browse(source)
    } else if (action === 'suggestion') {
      const source = sources.get(id)

      if (source) await browse(source)
    } else if (action === 'url') {
      const url = await vscode.window.showInputBox({
        title: 'Add repository by URL',
        prompt: 'Repository URL or Git remote destination',
      })

      if (!url) return
      const directory = await runtime.runPromise(RepositoryDirectory)
      const hosted = directory.recognize(url.trim())

      if (Option.isNone(hosted)) {
        state.message = 'This repository URL is not supported by an installed provider.'
        state.error = true
      } else {
        const repository = remember(fromHosted(hosted.value))
        state.candidates = [
          repository,
          ...state.candidates.filter((item) => item.id !== repository.id),
        ]
        state.selectRepositories([repository])
      }
    } else if (action === 'toggle') {
      if (!candidates.has(id)) return

      state.checked = state.checked.includes(id)
        ? state.checked.filter((item) => item !== id)
        : [...state.checked, id]
    } else if (action === 'add') {
      const selected = state.checked.flatMap((id) => {
        const item = candidates.get(id)

        return item ? [item] : []
      })

      if (!selected.length) return

      const added = await runOperation(
        runtime,
        'Duff.dashboard',
        RepositoryCatalog.use((store) => store.add(selected).pipe(Effect.as(true))),
      )

      if (added) {
        state.checked = []
        state.mode = 'dashboard'
        state.repositoryId = selected[0]?.id ?? ''
        await refreshCatalog()
        await loadPullRequests()
      }
    } else if (action === 'repository') {
      reset()
      state.repositoryId = id
      state.pulls = []
      state.pullRequestId = ''
      await loadPullRequests()
    } else if (action === 'state') {
      const filter = Schema.decodeUnknownOption(PullRequestState)(id)

      if (Option.isNone(filter)) return
      state.filter = filter.value
      await loadPullRequests()
    } else if (action === 'refresh') await loadPullRequests()
    else if (action === 'more') {
      if (state.busy || !state.more) return

      if (state.mode === 'picker' && activeSource) {
        await browse(activeSource, true)
      } else await loadPullRequests(true)
    } else if (action === 'pull') state.pullRequestId = id
    else if (action === 'review') await openReview(id)
    else if (action === 'external') {
      const pr = state.pulls.find((item) => item.id === id)

      if (pr) await vscode.env.openExternal(vscode.Uri.parse(pr.url))
    } else if (action === 'local') {
      const repository = state.repositories.find((item) => item.id === id)
      const path = repository?.localPaths[0]

      if (path)
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), {
          forceNewWindow: true,
        })
    } else if (action === 'remove') {
      await runOperation(
        runtime,
        'Duff.dashboard',
        RepositoryCatalog.use((store) => store.remove(id)),
      )
      reset()
      await refreshCatalog()
      await loadPullRequests()
    } else if (action === 'connect') {
      const repository = state.repositories.find((item) => item.id === state.repositoryId)

      if (repository && Option.isSome(repository.hosting)) {
        const hosted = repository.hosting.value
        await runOperation(
          runtime,
          'Duff.dashboard',
          RepositoryDirectory.use((directory) => directory.connect(hosted)),
        )
        await loadPullRequests()
      }
    }

    await render()
  }

  const handle = async (raw: unknown) => {
    const message = Schema.decodeUnknownOption(Message)(raw)

    if (Option.isNone(message)) return

    try {
      await dispatch(message.value)
    } catch {
      state.busy = false
      state.error = true
      state.message =
        'This action could not finish. Your watchlist and review files have been preserved. Retry or reopen the dashboard.'
      await render()
    }
  }

  const open = () => {
    if (panel) {
      panel.reveal()

      return
    }

    panel = vscode.window.createWebviewPanel(
      'duff.dashboard',
      'Duff — Pull requests',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    )
    panel.webview.html = dashboardHtml(randomUUID())
    context.subscriptions.push(
      panel,
      panel.webview.onDidReceiveMessage((message: unknown) =>
        runtime.runFork(Effect.promise(() => handle(message))),
      ),
      panel.onDidDispose(() => {
        panel = undefined
        reset()
      }),
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('duff.dashboard', open),
    vscode.commands.registerCommand(
      'duff.openReviewWorkspace',
      async (raw: unknown, id: unknown) => {
        const hosted = Schema.decodeUnknownOption(HostedRepository)(raw)
        const number = Schema.decodeUnknownOption(Schema.NonEmptyString)(id)

        if (Option.isSome(hosted) && Option.isSome(number))
          await openReview(number.value, hosted.value)
      },
    ),
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused && panel)
        runtime.runFork(
          Effect.promise(async () => {
            const previous = state.repositoryId
            await refreshCatalog()

            if (previous !== state.repositoryId && state.mode === 'dashboard')
              await loadPullRequests()
          }),
        )
    }),
    { dispose: () => abort.abort() },
  )

  return new DashboardCommands(open)
}
