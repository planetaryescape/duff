import { type PullRequestState } from '@duff/core/git-hosting-provider'
import { GroupId } from '@duff/core/pull-requests'
import { ReviewSession, type ReviewState } from '@duff/core/review-session'
import { Effect, Fiber, Option, Schema, Stream } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { providerError } from './ProviderError'
import {
  canConnectProvider,
  PullRequestItem,
  pullRequestLabel,
  pullRequestStateLabels,
  PullRequestView,
} from './PullRequestView'

type SearchItem = vscode.QuickPickItem & {
  readonly command?: {
    readonly command: string
    readonly title: string
    readonly arguments?: ReadonlyArray<unknown>
  }
}

export function registerPullRequestCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
) {
  const provider = new PullRequestView()
  const view = vscode.window.createTreeView('duff.providers', { treeDataProvider: provider })
  let search: vscode.QuickPick<SearchItem> | undefined

  const updateSearch = (state: ReviewState) => {
    if (!search) return
    search.busy =
      state._tag === 'Active' &&
      (state.discovering ||
        state.inspection === 'Inspecting' ||
        state.rows.some((row) => row.activity !== 'Idle'))
    const items: SearchItem[] = []

    if (state._tag === 'Active') {
      const ready = state.inspection === 'Ready' && Option.isSome(state.snapshot)
      const busy = !ready || state.rows.some((row) => row.activity === 'Connecting')

      const root = Option.getOrElse(
        Option.map(state.snapshot, (snapshot) => snapshot.root),
        () => state.directory,
      )

      for (const row of state.rows) {
        if ('data' in row.content) {
          for (const pr of row.content.data.items) {
            const item = new PullRequestItem(root, row, pr)
            items.push({
              label: `#${pr.id} ${pr.title}`,
              description: `${row.group.repository.displayName} · ${pullRequestLabel(pr)}`,
              detail: `${pr.source._tag === 'Available' ? pr.source.ref.name.replace('refs/heads/', '') : 'Source unavailable'} → ${pr.target.ref.name.replace('refs/heads/', '')}${row.content._tag === 'Ready' ? '' : ' · Previous results'}`,
              command: ready
                ? {
                    command: 'duff.reviewPullRequest',
                    title: 'Review Pull Request',
                    arguments: [item],
                  }
                : undefined,
            })
          }

          if (
            !busy &&
            row.activity === 'Idle' &&
            row.content._tag !== 'Refreshing' &&
            row.content.data.hasMore
          )
            items.push({
              label: '$(list-unordered) Load More Pull Requests',
              description: row.group.repository.displayName,
              detail: `Search covers loaded ${state.pullRequestState} PRs. Load the next page to search more.`,
              alwaysShow: true,
              command: {
                command: 'duff.loadMoreProviders',
                title: 'Load More',
                arguments: [row.group.id],
              },
            })
        }

        if (row.content._tag === 'Failed' || row.content._tag === 'Stale')
          items.push({
            label: row.group.repository.displayName,
            detail: providerError(row.content.error),
            alwaysShow: true,
          })

        if (canConnectProvider(row, busy))
          items.push({
            label:
              row.group.provider.authenticationSource === 'github'
                ? '$(account) Use VS Code account…'
                : '$(account) Connect Provider…',
            description: row.group.repository.displayName,
            alwaysShow: true,
            command: {
              command: 'duff.connectProvider',
              title: 'Connect Provider',
              arguments: [row.group.id],
            },
          })
      }
    }

    items.push({
      label: '$(filter) Show Open / Merged / Closed…',
      detail: 'Choose which pull requests to browse.',
      alwaysShow: true,
      command: {
        command: 'duff.filterPullRequests',
        title: 'Filter Pull Requests',
      },
    })
    items.push({
      label: '$(refresh) Check Pull Requests',
      detail: 'Refresh discovery for the selected local repository.',
      alwaysShow: true,
      command: {
        command: 'duff.inspectContext',
        title: 'Check Pull Requests',
        arguments: ['manual'],
      },
    })
    search.items = items
  }

  const subscription = runtime.runFork(
    ReviewSession.use((session) =>
      session.changes.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            provider.setState(state)
            updateSearch(state)
            view.description =
              state._tag === 'Active' ? pullRequestStateLabels[state.pullRequestState] : 'Open'

            if (search)
              search.placeholder = `Search loaded ${state._tag === 'Active' ? state.pullRequestState : 'open'} PRs by title, #number, repository, or branch`
            view.message =
              state._tag === 'Idle'
                ? undefined
                : Option.isSome(state.problem)
                  ? 'Unexpected operation failure. Refresh to retry.'
                  : state.inspection === 'Failed'
                    ? 'Local inspection failed. Refresh to retry.'
                    : state.discovering
                      ? `Loading ${state.pullRequestState} pull requests…`
                      : undefined
          }),
        ),
      ),
    ),
  )

  context.subscriptions.push(
    provider,
    view,
    {
      dispose: () => {
        search?.dispose()
        runtime.runFork(Fiber.interrupt(subscription))
      },
    },
    vscode.commands.registerCommand('duff.searchPullRequests', async () => {
      if (search) {
        search.show()

        return
      }

      const picker = vscode.window.createQuickPick<SearchItem>()
      search = picker
      picker.title = 'Search Pull Requests'
      picker.placeholder = 'Search loaded PRs by title, #number, repository, or branch'
      picker.matchOnDescription = true
      picker.matchOnDetail = true

      const accept = picker.onDidAccept(async () => {
        const selected = picker.selectedItems[0]

        if (!selected?.command) return
        const command = selected.command

        if (
          command.command === 'duff.reviewPullRequest' ||
          command.command === 'duff.filterPullRequests'
        )
          picker.hide()
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []))
      })

      const hide = picker.onDidHide(() => {
        if (search === picker) search = undefined
        accept.dispose()
        hide.dispose()
        picker.dispose()
      })

      const state = await runtime.runPromise(ReviewSession.use((session) => session.current()))
      updateSearch(state)
      picker.show()

      if (state._tag === 'Idle' || (state.rows.length === 0 && !state.discovering))
        await vscode.commands.executeCommand('duff.inspectContext', 'manual')
    }),
    vscode.commands.registerCommand('duff.refreshProviders', async () => {
      await vscode.commands.executeCommand('duff.inspectContext', 'manual')
      await vscode.commands.executeCommand('duff.providers.focus')
    }),
    vscode.commands.registerCommand('duff.filterPullRequests', async () => {
      const selected = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { readonly state: PullRequestState }
      >(
        [
          { label: 'Open', state: 'open' },
          { label: 'Merged', state: 'merged' },
          { label: 'Closed', description: 'Closed without merging', state: 'closed' },
        ],
        { title: 'Show Pull Requests', placeHolder: 'Open, merged, or closed without merging' },
      )

      if (!selected) return
      let state = await runtime.runPromise(ReviewSession.use((session) => session.current()))

      if (state._tag === 'Idle') {
        await vscode.commands.executeCommand('duff.inspectContext', 'manual')
        state = await runtime.runPromise(ReviewSession.use((session) => session.current()))
      }

      if (state._tag !== 'Active') return
      const directory = state.directory
      await runOperation(
        runtime,
        'Duff.discoverProviders',
        ReviewSession.use((session) =>
          session.selectRepository(directory, { discover: true, state: selected.state }),
        ),
      )
      await vscode.commands.executeCommand('duff.providers.focus')
    }),
    vscode.commands.registerCommand('duff.loadMoreProviders', (value: unknown) => {
      const id = Schema.decodeUnknownOption(GroupId)(value)

      if (Option.isSome(id))
        return runOperation(
          runtime,
          'Duff.loadMoreProviders',
          ReviewSession.use((session) => session.loadMore(id.value)),
        )
    }),
    vscode.commands.registerCommand('duff.connectProvider', async (value: unknown) => {
      const id = Schema.decodeUnknownOption(GroupId)(value)

      if (Option.isNone(id)) return

      const state = await runtime.runPromise(ReviewSession.use((session) => session.current()))

      const group =
        state._tag === 'Active'
          ? state.rows.find((row) => row.group.id === id.value)?.group
          : undefined

      if (!group) return
      const cli = group.provider.authenticationSource === 'azure-cli'
      const action = cli ? 'Recheck Azure CLI' : 'Continue to Sign In'

      const choice = await vscode.window.showInformationMessage(
        cli
          ? 'Duff will recheck your existing Azure CLI login. It will not open Microsoft sign-in, run az login, or change your CLI account. Duff only reads pull requests.'
          : 'Duff checks GH_TOKEN, GITHUB_TOKEN and GitHub CLI first. Only when those credentials are absent will it request a VS Code GitHub session. Sign-in can grant broad repository read/write permissions. Duff only reads pull requests.',
        { modal: true },
        action,
      )

      if (choice === action)
        await runOperation(
          runtime,
          'Duff.connectProvider',
          ReviewSession.use((session) => session.connect(id.value)),
        )
    }),
  )
}
