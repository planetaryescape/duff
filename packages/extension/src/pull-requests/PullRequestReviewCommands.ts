import { PullRequestReview, type PreparationState } from '@duff/core/pull-request-review'
import { ReviewSession } from '@duff/core/review-session'
import { ReviewSessions } from '@duff/core/saved-review-sessions'
import { type SavedReview } from '@duff/core/saved-reviews'
import { Effect, Fiber, Option, Stream } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { PullRequestItem } from './PullRequestView'

class SavedReviewChoice implements vscode.QuickPickItem {
  readonly label: string
  readonly description: string
  readonly detail: string

  constructor(readonly saved: SavedReview) {
    this.label = `PR #${saved.selection.id}: ${saved.resolved.pullRequest.title}`
    this.description = `${saved.selection.provider} · ${saved.viewed.length}/${saved.review.files.length} viewed`
    this.detail = saved.selection.repository.key
  }
}

export function registerPullRequestReviewCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
  render: (state: PreparationState) => Promise<void>,
) {
  let restored = false

  const subscription = runtime.runFork(
    PullRequestReview.use((service) =>
      service.changes.pipe(
        Stream.runForEach((state) =>
          Effect.promise(async () => {
            await vscode.commands.executeCommand(
              'setContext',
              'duff.prReview',
              Option.isSome(state.accepted),
            )
            await vscode.commands.executeCommand(
              'setContext',
              'duff.prPreparation',
              state.activity._tag,
            )
            await render(state)
          }),
        ),
      ),
    ),
  )

  const repository = runtime.runFork(
    ReviewSession.use((session) =>
      session.changes.pipe(
        Stream.runForEach((state) =>
          PullRequestReview.use((service) =>
            Effect.gen(function* () {
              yield* service.repositoryChanged(
                state._tag === 'Active' ? Option.some(state.directory) : Option.none(),
                state._tag === 'Active'
                  ? Option.map(state.snapshot, (snapshot) => snapshot.root)
                  : Option.none(),
              )

              if (!restored && state._tag === 'Active' && Option.isSome(state.snapshot)) {
                restored = true
                const root = state.snapshot.value.root
                yield* Effect.promise(() =>
                  runOperation(runtime, 'Duff.preparePullRequest', service.restore(root)),
                )
              }
            }),
          ),
        ),
      ),
    ),
  )

  const chooseSaved = async (forget: boolean) => {
    const catalog = await runOperation(
      runtime,
      'Duff.preparePullRequest',
      ReviewSessions.use((service) => service.list()),
    )

    if (!catalog) return
    const current = await runtime.runPromise(PullRequestReview.use((service) => service.current()))

    const choices = catalog.sessions
      .filter((saved) => saved.review.root === Option.getOrUndefined(current.root))
      .map((saved) => new SavedReviewChoice(saved))

    if (choices.length === 0) {
      await vscode.window.showInformationMessage(
        'Duff: No saved PR reviews for this repository yet. Select a pull request to start one.',
      )

      return
    }

    const choice = await vscode.window.showQuickPick(choices, {
      title: forget ? 'Forget Saved Review' : 'Resume Saved Review',
      placeHolder: forget
        ? 'Choose saved progress to remove · your checkout and provider are unchanged'
        : 'Most recently reviewed first · resumes without contacting the provider',
    })

    if (!choice) return

    if (forget) {
      const confirmed = await vscode.window.showWarningMessage(
        `Forget saved progress for PR #${choice.saved.selection.id}? Its Duff-owned Git pins will be released. No provider state or checkout files will change.`,
        { modal: true },
        'Forget Review',
      )

      if (confirmed !== 'Forget Review') return
    }

    await runOperation(
      runtime,
      'Duff.preparePullRequest',
      Effect.gen(function* () {
        const service = yield* PullRequestReview

        if (!forget) {
          yield* service.resume(choice.saved.key)

          return
        }

        yield* service.cancel()
        const state = yield* service.current()

        if (Option.isSome(state.accepted) && state.accepted.value.saved.key === choice.saved.key)
          yield* service.exit()
        yield* ReviewSessions.use((sessions) => sessions.forget(choice.saved.key))
      }),
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('duff.resumeReview', () => chooseSaved(false)),
    vscode.commands.registerCommand('duff.forgetReview', () => chooseSaved(true)),
    {
      dispose: () => {
        runtime.runFork(Fiber.interrupt(subscription))
        runtime.runFork(Fiber.interrupt(repository))
      },
    },
    vscode.commands.registerCommand('duff.reviewPullRequest', async (item: unknown) => {
      if (!(item instanceof PullRequestItem)) return
      await runOperation(
        runtime,
        'Duff.preparePullRequest',
        Effect.gen(function* () {
          const session = yield* ReviewSession
          const state = yield* session.current()

          if (
            state._tag !== 'Active' ||
            state.inspection !== 'Ready' ||
            Option.isNone(state.snapshot) ||
            state.snapshot.value.root !== item.root
          )
            return
          const service = yield* PullRequestReview
          yield* service.repositoryChanged(
            Option.some(state.directory),
            Option.some(state.snapshot.value.root),
          )
          yield* service.start(state.snapshot.value, item.selection)
        }),
      )
      await vscode.commands.executeCommand('duff.files.focus')
    }),
    vscode.commands.registerCommand('duff.fetchReviewRevisions', async () => {
      const before = await runtime.runPromise(PullRequestReview.use((service) => service.current()))

      if (before.activity._tag !== 'AwaitingFetch') return

      const choice = await vscode.window.showWarningMessage(
        'Duff needs missing PR commits. Fetch only the pinned source/target revisions using your existing Git credentials? This may download their history and update only refs/duff/reviews/source and target. No checkout, tags, FETCH_HEAD or remote-tracking branches are changed. API credentials are not used for Git.',
        { modal: true },
        'Fetch Revisions',
      )

      await runOperation(
        runtime,
        'Duff.preparePullRequest',
        PullRequestReview.use((service) =>
          Effect.gen(function* () {
            const current = yield* service.current()

            if (current.activity !== before.activity) return

            if (choice === 'Fetch Revisions') yield* service.allowFetch()
            else yield* service.cancel()
          }),
        ),
      )
    }),
    vscode.commands.registerCommand('duff.cancelPullRequestReview', () =>
      runOperation(
        runtime,
        'Duff.preparePullRequest',
        PullRequestReview.use((service) => service.cancel()),
      ),
    ),
    vscode.commands.registerCommand('duff.exitPullRequestReview', () =>
      runOperation(
        runtime,
        'Duff.preparePullRequest',
        PullRequestReview.use((service) => service.exit()),
      ),
    ),
    vscode.commands.registerCommand('duff.refreshPullRequestReview', () =>
      runOperation(
        runtime,
        'Duff.preparePullRequest',
        Effect.gen(function* () {
          const service = yield* PullRequestReview
          const current = yield* service.current()
          const session = yield* ReviewSession
          const state = yield* session.current()

          if (
            Option.isNone(current.accepted) ||
            state._tag !== 'Active' ||
            Option.isNone(state.snapshot) ||
            state.snapshot.value.root !== current.accepted.value.review.root
          )
            return
          yield* service.start(state.snapshot.value, current.accepted.value.selection, 'update')
        }),
      ),
    ),
    vscode.commands.registerCommand('duff.openPullRequestBrowser', async (item: unknown) => {
      if (item instanceof PullRequestItem)
        await vscode.env.openExternal(vscode.Uri.parse(item.pullRequest.url))
    }),
  )
}
