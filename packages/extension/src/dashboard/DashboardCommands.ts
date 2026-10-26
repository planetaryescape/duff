import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import { DashboardData } from '@duff/core/dashboard-data'
import { DashboardPreferenceChange } from '@duff/core/dashboard-preferences'
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
import { Data, Effect, Option, Schema } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { DashboardActivity, listenForDashboardActivity } from './DashboardActivity'
import { dashboardHtml } from './DashboardHtml'
import { DashboardPagination } from './DashboardPagination'
import { dashboardPullRequestPage } from './DashboardPullRequests'
import { DashboardSelection } from './DashboardSelection'
import { dashboardSelectionData } from './DashboardSelectionData'
import { DashboardState } from './DashboardState'
import { DashboardTasks } from './DashboardTasks'

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
    'details',
    'avatar',
    'review',
    'external',
    'local',
    'remove',
    'connect',
    'preference',
    'rename',
  ]),
  id: Schema.optionalKey(Schema.String),
  change: Schema.optionalKey(DashboardPreferenceChange),
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
  const pagination = new DashboardPagination()
  let page = 1
  let activeSource: RepositorySource | undefined
  let abort = new AbortController()
  let activity: DashboardActivity | undefined
  let tasks: DashboardTasks | undefined
  let generation = 0
  let preparing = false

  const persist = async (change: DashboardPreferenceChange) =>
    runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryCatalog.use((catalog) => catalog.changePreferences(change)),
      undefined,
      tasks?.signal,
    )

  const render = async () => {
    state.selections = [...candidates.values()]
    state.sources = [...sources.values()]
    await panel?.webview.postMessage(new DashboardEvent({ type: 'state', value: state }))
  }

  const selection = new DashboardSelection(state, dashboardSelectionData(runtime), render)

  const rememberNavigation = async () => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)
    const snapshot = pagination.snapshot(state)

    if (!repository || Option.isNone(repository.hosting) || !snapshot) return
    const hosted = repository.hosting.value
    await runOperation(
      runtime,
      'Duff.dashboard',
      DashboardData.use((data) => data.rememberNavigation(hosted, snapshot)),
      undefined,
      abort.signal,
    )
  }

  const reset = () => {
    abort.abort()
    abort = new AbortController()
    selection.cancel()
    state.clearDetails()
    generation++
    state.busy = false
    state.message = ''
    state.error = false
    state.more = false
    pagination.clear()
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

  const refreshCatalog = async (
    options: { readonly signal: AbortSignal } = { signal: abort.signal },
  ) => {
    const current = generation
    const target = panel

    const repositories = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryCatalog.use((store) => store.list()),
      undefined,
      options.signal,
    )

    if (!repositories) return

    const preferences = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryCatalog.use((catalog) => catalog.preferences()),
      undefined,
      options.signal,
    )

    const directory = await runtime.runPromise(RepositoryDirectory, { signal: options.signal })

    if (current !== generation || target !== panel) return

    const removed = state.repositories.filter(
      (previous) => !repositories.some((repository) => repository.id === previous.id),
    )

    if (removed.some((repository) => repository.id === state.repositoryId)) selection.cancel()

    if (removed.length) {
      await runOperation(
        runtime,
        'Duff.dashboard',
        Effect.forEach(
          removed,
          (repository) => {
            const hosted = Option.getOrUndefined(repository.hosting)

            return hosted ? DashboardData.use((data) => data.invalidate(hosted)) : Effect.void
          },
          { concurrency: 1 },
        ),
        undefined,
        options.signal,
      )

      if (current !== generation || target !== panel) return
    }

    if (state.updateRepositories(repositories)) reset()

    if (preferences) state.labels = preferences.repositoryLabels ?? {}
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
    const directory = await runtime.runPromise(RepositoryDirectory, { signal: abort.signal })

    const results = await runtime.runPromise(
      Effect.forEach(
        paths,
        (path) => GitContext.use((git) => git.inspect(path)).pipe(Effect.result),
        { concurrency: 4 },
      ),
      { signal: abort.signal },
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

  const loadDetails = async (id: string, force = false) => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)

    if (!repository || Option.isNone(repository.hosting) || !state.pulls.some((pr) => pr.id === id))
      return
    await selection.load(repository.hosting.value, id, force)
  }

  const loadAvatar = async (id: string) => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)
    const key = state.pulls.find((pr) => pr.id === id)?.authorAvatarKey

    if (
      !repository ||
      Option.isNone(repository.hosting) ||
      !key ||
      Object.prototype.hasOwnProperty.call(state.avatars, key)
    )
      return
    const hosted = repository.hosting.value
    const current = generation

    const result = await runOperation(
      runtime,
      'Duff.dashboard',
      RepositoryDirectory.use((directory) => directory.avatar(hosted, key)).pipe(
        Effect.catch(() => Effect.succeed(Option.none<string>())),
      ),
      undefined,
      abort.signal,
    )

    if (current !== generation || !result) return
    state.avatars = { ...state.avatars, [key]: Option.getOrElse(result, () => '') }
    await render()
  }

  const loadPullRequests = async (
    more = false,
    options: {
      readonly retain?: boolean
      readonly force?: boolean
      readonly restoreFilter?: boolean
    } = {},
  ): Promise<void> => {
    const repository = state.repositories.find((item) => item.id === state.repositoryId)

    if (!repository || Option.isNone(repository.hosting)) return
    const hosted = repository.hosting.value
    let filter = state.filter
    let preferredId = state.pullRequestId

    if (!more && !options.retain) {
      reset()
      state.pulls = []
      state.pullRequestId = ''
      state.avatars = {}
    }

    const current = generation

    if (!more && !options.retain) {
      const navigation = await runOperation(
        runtime,
        'Duff.dashboard',
        DashboardData.use((data) =>
          data.peekNavigation(hosted, options.restoreFilter ? undefined : filter),
        ),
        undefined,
        abort.signal,
      )

      if (current !== generation) return

      if (navigation && Option.isSome(navigation)) {
        pagination.restore(state, navigation.value)
        filter = state.filter
        preferredId = state.pullRequestId
        await render()
        await persist({ _tag: 'SetFilter', repositoryId: repository.id, filter })

        if (current !== generation) return
        await persist({
          _tag: 'SetQuery',
          repositoryId: repository.id,
          query: navigation.value.query,
        })

        if (current !== generation) return
        await persist({
          _tag: 'FocusPullRequest',
          repositoryId: repository.id,
          filter,
          pullRequestId: preferredId,
        })

        if (current !== generation) return
      } else {
        const cached = await runOperation(
          runtime,
          'Duff.dashboard',
          DashboardData.use((data) => data.peekListVersioned(hosted, filter)),
          undefined,
          abort.signal,
        )

        if (current !== generation) return

        if (cached && Option.isSome(cached)) {
          state.pullRequestId = preferredId
          pagination.apply(state, cached.value.page, {
            _tag: 'First',
            revision: cached.value.revision,
          })
        }
      }

      const id = state.pullRequestId

      if (id)
        tasks?.run(async () => {
          if (current === generation && state.pullRequestId === id) await loadDetails(id)
        })
    }

    state.busy = true
    state.message = `Loading ${filter} pull requests…`
    const requestedRevision = pagination.snapshot(state)?.listRevision ?? 0
    await render()

    const result = await runOperation(
      runtime,
      'Duff.loadDashboardPullRequests',
      dashboardPullRequestPage(
        repository,
        hosted,
        filter,
        more
          ? { _tag: 'More', cursor: pagination.cursor, preferredId }
          : { _tag: 'First', preferredId, force: options.force ?? false },
        () => selection.cancel(),
      ),
      async () => {
        if (current !== generation) return
        state.busy = false
        state.message = 'Could not load pull requests. Check the error notification, then retry.'
        state.error = true
        await render()
      },
      abort.signal,
    )

    if (current !== generation) return
    state.busy = false
    state.message = result
      ? ''
      : 'Could not load pull requests. Check access and retry with Refresh or Connect.'
    state.error = !result

    if (result) {
      const selectedId = state.pullRequestId || preferredId

      if (
        !more &&
        state.pullRequestId &&
        state.pullRequestId !== preferredId &&
        !result.page.items.some((pull) => pull.id === state.pullRequestId)
      ) {
        await loadPullRequests(false, { retain: true })

        return
      }

      if (result.moved) {
        state.repositoryId = result.watched.id
        await refreshCatalog()
        state.pulls = []
        state.pullRequestId = ''
        state.avatars = {}
        pagination.clear()
      }

      state.pullRequestId = selectedId

      const applied = pagination.apply(
        state,
        result.page,
        more && !result.moved
          ? { _tag: 'More', revision: requestedRevision }
          : { _tag: 'First', revision: result.revision },
      )

      if (!applied) {
        await render()

        return
      }

      if (!state.more && Option.isSome(pagination.cursor))
        state.message =
          'Loaded pagination limit reached: five pages or 250 pull requests. Refresh starts from the latest first page.'
      await rememberNavigation()

      if (current !== generation) return

      if (!state.pullRequestId) {
        selection.cancel()
        state.clearDetails()
      }
    }

    await render()

    if ((!more || result?.moved) && state.pullRequestId)
      await loadDetails(state.pullRequestId, options.force)
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
    const dashboardSignal = explicit ? undefined : tasks?.signal
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

          const signal = dashboardSignal
            ? AbortSignal.any([controller.signal, dashboardSignal])
            : controller.signal

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
              signal,
            )

            if (prepared && !signal.aborted)
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

  const dispatch = async (message: Schema.Schema.Type<typeof Message>, target = panel) => {
    const { action, id = '' } = message

    if (action === 'ready') {
      const preferences = await runOperation(
        runtime,
        'Duff.dashboard',
        RepositoryCatalog.use((catalog) => catalog.preferences()),
        undefined,
        tasks?.signal,
      )

      if (target !== panel) return

      if (preferences) state.restore(preferences)
      await refreshCatalog()

      if (target !== panel) return
      await loadPullRequests()

      if (target === panel) activity?.ready()
    } else if (action === 'preference' && message.change) {
      const preferences = await persist(message.change)

      if (!preferences) return

      if (target !== panel) return

      if (message.change._tag === 'MoveRepository') {
        await refreshCatalog()
      } else if (
        message.change._tag === 'SetQuery' &&
        message.change.repositoryId === state.repositoryId
      ) {
        state.query = message.change.query
        await rememberNavigation()

        return
      } else if (message.change._tag === 'ResizeColumns') {
        state.columnWidths = message.change.columnWidths

        return
      }
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

      if (!folders || target !== panel) return
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
      const directory = await runtime.runPromise(RepositoryDirectory, { signal: abort.signal })
      const provider = directory.providers.find((item) => item.id === id)

      if (!provider) return

      const scope = await vscode.window.showInputBox({
        title: `Browse ${provider.displayName} repositories`,
        prompt:
          'Collection: owner, organization, or organization/project. Leave empty for your account when supported.',
        ignoreFocusOut: true,
      })

      if (scope === undefined || target !== panel) return

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

      if (!url || target !== panel) return
      const directory = await runtime.runPromise(RepositoryDirectory, { signal: abort.signal })
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
        undefined,
        tasks?.signal,
      )

      if (added) {
        state.checked = []
        state.mode = 'dashboard'
        state.repositoryId = selected[0]?.id ?? ''
        state.pullRequestId = ''
        state.query = ''

        if (state.repositoryId)
          await persist({ _tag: 'FocusRepository', repositoryId: state.repositoryId })
        await refreshCatalog()
        await loadPullRequests()
      }
    } else if (action === 'repository') {
      if (!state.repositories.some((repository) => repository.id === id)) return

      if (id === state.repositoryId) {
        await activity?.check()

        return
      }

      reset()
      state.repositoryId = id
      state.pulls = []
      state.pullRequestId = ''
      state.query = ''
      const current = generation
      await persist({ _tag: 'FocusRepository', repositoryId: id })

      if (target !== panel || state.repositoryId !== id || current !== generation) return
      await loadPullRequests(false, { restoreFilter: true })
    } else if (action === 'state') {
      const filter = Schema.decodeUnknownOption(PullRequestState)(id)

      if (Option.isNone(filter)) return
      reset()
      state.pulls = []
      state.filter = filter.value
      state.pullRequestId = ''
      state.query = ''
      const current = generation
      await persist({ _tag: 'SetFilter', repositoryId: state.repositoryId, filter: filter.value })

      if (target !== panel || current !== generation) return
      await loadPullRequests()
    } else if (action === 'refresh') {
      await loadPullRequests(false, { retain: true, force: true })
    } else if (action === 'more') {
      if (state.busy || !state.more) return

      if (state.mode === 'picker' && activeSource) {
        await browse(activeSource, true)
      } else await loadPullRequests(true)
    } else if (action === 'pull' || action === 'details') {
      if (!state.pulls.some((pull) => pull.id === id)) return
      const current = generation
      state.pullRequestId = id
      await persist({
        _tag: 'FocusPullRequest',
        repositoryId: state.repositoryId,
        filter: state.filter,
        pullRequestId: id,
      })

      if (current !== generation || state.pullRequestId !== id) return
      await rememberNavigation()

      if (current !== generation || state.pullRequestId !== id) return
      await loadDetails(id, action === 'details')
    } else if (action === 'avatar') await loadAvatar(id)
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
    } else if (action === 'rename') {
      const repository = state.repositories.find((item) => item.id === id)

      if (!repository) return

      const value = await vscode.window.showInputBox({
        title: 'Rename repository',
        prompt: `Label for ${repository.name}. Leave empty to show the repository name.`,
        value: state.labels[repository.id] ?? repository.name,
        validateInput: (input) =>
          input.trim().length > 100 ? 'Use 100 characters or fewer.' : undefined,
      })

      if (value === undefined || target !== panel) return

      const preferences = await persist({
        _tag: 'RenameRepository',
        repositoryId: repository.id,
        label: value.trim() === repository.name ? '' : value,
      })

      if (preferences) state.labels = preferences.repositoryLabels ?? {}
    } else if (action === 'remove') {
      const removed = state.repositories.find((repository) => repository.id === id)

      if (removed && Option.isSome(removed.hosting)) {
        const hosted = removed.hosting.value
        selection.cancel()
        await runtime.runPromise(
          DashboardData.use((data) => data.invalidate(hosted)),
          { signal: abort.signal },
        )
      }

      await runOperation(
        runtime,
        'Duff.dashboard',
        RepositoryCatalog.use((store) => store.remove(id)),
        undefined,
        tasks?.signal,
      )
      reset()
      await refreshCatalog()
      await loadPullRequests()
    } else if (action === 'connect') {
      const repository = state.repositories.find((item) => item.id === state.repositoryId)

      if (repository && Option.isSome(repository.hosting)) {
        const hosted = repository.hosting.value
        selection.cancel()
        pagination.clear()
        await runOperation(
          runtime,
          'Duff.dashboard',
          RepositoryDirectory.use((directory) => directory.connect(hosted)),
          undefined,
          tasks?.signal,
        )
        await runtime.runPromise(
          DashboardData.use((data) => data.invalidate(hosted)),
          { signal: abort.signal },
        )

        if (target !== panel) return
        await loadPullRequests()
      }
    }

    await render()
  }

  const handle = async (raw: unknown, target = panel) => {
    if (target !== panel) return
    const message = Schema.decodeUnknownOption(Message)(raw)

    if (Option.isNone(message)) return

    try {
      await dispatch(message.value, target)
    } catch {
      if (target !== panel) return
      state.busy = false
      state.error = true
      state.message =
        'This action could not finish. Your watchlist and review files have been preserved. Retry or reopen the dashboard.'
      await render()
    }
  }

  const attach = (webviewPanel: vscode.WebviewPanel) => {
    activity?.dispose()
    tasks?.dispose()
    reset()
    panel = webviewPanel

    const currentTasks = new DashboardTasks((work, options) => {
      runtime.runFork(work, options)
    })

    tasks = currentTasks

    const currentActivity = new DashboardActivity(
      () => webviewPanel.active,
      () => state.mode === 'dashboard',
      async ({ signal }) => {
        const previous = state.repositoryId
        await refreshCatalog({ signal })

        if (
          signal.aborted ||
          panel !== webviewPanel ||
          !webviewPanel.active ||
          state.mode !== 'dashboard'
        )
          return
        await loadPullRequests(false, {
          retain: previous === state.repositoryId && state.pulls.length > 0,
        })
      },
    )

    activity = currentActivity
    state.mode = 'dashboard'
    panel.webview.options = { enableScripts: true, localResourceRoots: [] }
    panel.webview.html = dashboardHtml(randomUUID())
    context.subscriptions.push(
      panel,
      panel.webview.onDidReceiveMessage((message: unknown) =>
        currentTasks.run(() => handle(message, webviewPanel)),
      ),
      listenForDashboardActivity(panel, vscode.window, currentActivity, (work) =>
        currentTasks.run(work),
      ),
      panel.onDidDispose(() => {
        currentActivity.dispose()
        currentTasks.dispose()

        if (panel !== webviewPanel) return
        panel = undefined
        reset()
      }),
    )
  }

  const open = () => {
    if (panel) {
      panel.reveal()

      return
    }

    attach(
      vscode.window.createWebviewPanel(
        'duff.dashboard',
        'Duff — Pull requests',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
      ),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('duff.dashboard', {
      deserializeWebviewPanel: async (restored) => {
        attach(restored)
      },
    }),
    vscode.commands.registerCommand('duff.dashboard', open),
    vscode.commands.registerCommand('duff.renameRepository', async (raw: unknown) => {
      const target = Schema.decodeUnknownOption(
        Schema.Struct({ repositoryId: Schema.NonEmptyString }),
      )(raw)

      if (Option.isSome(target)) await handle({ action: 'rename', id: target.value.repositoryId })
    }),
    vscode.commands.registerCommand(
      'duff.openReviewWorkspace',
      async (raw: unknown, id: unknown) => {
        const hosted = Schema.decodeUnknownOption(HostedRepository)(raw)
        const number = Schema.decodeUnknownOption(Schema.NonEmptyString)(id)

        if (Option.isSome(hosted) && Option.isSome(number))
          await openReview(number.value, hosted.value)
      },
    ),
    {
      dispose: () => {
        abort.abort()
        activity?.dispose()
        tasks?.dispose()
        selection.dispose()
      },
    },
  )

  return new DashboardCommands(open)
}
