import { GroupId } from '@duff/core/pull-requests'
import { ReviewSession } from '@duff/core/review-session'
import { Effect, Fiber, Option, Schema, Stream } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { PullRequestView } from './PullRequestView'

export function registerPullRequestCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
) {
  const provider = new PullRequestView()
  const view = vscode.window.createTreeView('duff.providers', { treeDataProvider: provider })

  const subscription = runtime.runFork(
    ReviewSession.use((session) =>
      session.changes.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            provider.setState(state)
            view.message =
              state._tag === 'Idle'
                ? undefined
                : Option.isSome(state.problem)
                  ? 'Unexpected operation failure. Refresh to retry.'
                  : state.inspection === 'Failed'
                    ? 'Local inspection failed. Refresh to retry.'
                    : state.discovering
                      ? 'Discovering open pull requests…'
                      : state.rows.length || state.notices.length
                        ? 'Explicit refresh · no Git changes'
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
        runtime.runFork(Fiber.interrupt(subscription))
      },
    },
    vscode.commands.registerCommand('duff.refreshProviders', async () => {
      await vscode.commands.executeCommand('duff.inspectContext', 'manual')
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
          : 'Provider sign-in can grant broad repository read/write permissions. Duff only reads pull requests and never changes Git or provider data.',
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
