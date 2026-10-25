import {
  DiscussionReview,
  LineRange,
  type DiscussionState,
  type DiscussionThread,
  sameDiscussion,
} from '@duff/core/discussion'
import { type Attempt, type DraftPage } from '@duff/core/discussion-drafts'
import { makeCodeAnchor } from '@duff/core/discussion-placement'
import { Discussions } from '@duff/core/discussions'
import { type PreparedReview } from '@duff/core/pull-request-review'
import { type BranchReview } from '@duff/core/review'
import { Effect, type ManagedRuntime, Match, Option, Stream } from 'effect'
import * as vscode from 'vscode'

import { DiscussionComments } from './DiscussionComments'
import { DiscussionDraftEditor, draftDestination } from './DiscussionDraftEditor'
import { draftDiffAnchor } from './DiscussionDraftNavigation'
import { attemptMessage, discussionFailure } from './DiscussionError'
import { DiscussionView } from './DiscussionView'
import { DiscussionVisibilityPreference } from './DiscussionVisibility'
import { snapshotUri } from './ReviewView'
import { commentableDocument, decodeSnapshotDocument, snapshotDocument } from './SnapshotDocument'

export function discussionReview(prepared: PreparedReview): Option.Option<DiscussionReview> {
  const source = prepared.resolved.pullRequest.source

  if (source._tag !== 'Available') return Option.none()

  return Option.some(
    DiscussionReview.make({
      key: {
        providerId: prepared.selection.provider,
        repository: prepared.selection.repository,
        pullRequestId: prepared.selection.id,
      },
      selection: prepared.selection,
      comparison: {
        providerId: prepared.selection.provider,
        authority: prepared.selection.repository.authority,
        targetRepository: prepared.resolved.pullRequest.target.repository,
        sourceRepository: source.repository,
        pullRequestId: prepared.selection.id,
        targetRevision: prepared.resolved.revisions.target.commit,
        sourceRevision: prepared.review.headCommit,
        baseRevision: prepared.review.baseCommit,
        mode: 'merge-base-v1',
      },
      review: prepared.review,
    }),
  )
}

type DiscussionRuntime = Pick<
  ManagedRuntime.ManagedRuntime<BranchReview | Discussions, never>,
  'runPromise' | 'runPromiseExit' | 'runFork'
>

export function registerDiscussionCommands(
  context: vscode.ExtensionContext,
  runtime: DiscussionRuntime,
) {
  const comments = new DiscussionComments()
  const view = new DiscussionView()
  const editor = new DiscussionDraftEditor(runtime, context)
  const visibility = new DiscussionVisibilityPreference(context.workspaceState)
  let active: Option.Option<DiscussionReview> = Option.none()
  let state: DiscussionState = { _tag: 'Inactive' }
  let page: DraftPage | undefined
  let localError: string | undefined
  let disposed = false
  let generation = 0
  let recoveryGeneration = 0

  const render = () => {
    if (disposed) return

    if ('snapshot' in state)
      comments.render(state.review, state.snapshot, visibility.current() === 'shown')
    else comments.clear()
    view.render(state, page, localError)
  }

  const run = async <A, E>(work: Effect.Effect<A, E, Discussions>) => {
    const exit = await runtime.runPromiseExit(work)

    if (exit._tag === 'Success') return exit.value
    runtime.runFork(
      Effect.promise(async () => {
        await vscode.window.showErrorMessage(`Duff: ${discussionFailure(exit.cause)}`)
      }),
    )

    return undefined
  }

  const loadDrafts = async (more = false) => {
    if (more && (!page || Option.isNone(page.next))) return
    const request = ++recoveryGeneration
    const currentGeneration = generation

    const cursor = more && page ? page.next : Option.none<string>()

    const exit = await runtime.runPromiseExit(
      Discussions.use((service) => service.allDrafts(cursor)),
    )

    if (generation !== currentGeneration || request !== recoveryGeneration) return

    if (exit._tag === 'Success') {
      const loaded = exit.value
      page =
        more && page
          ? {
              drafts: [...page.drafts, ...loaded.drafts],
              attempts: [...page.attempts, ...loaded.attempts],
              next: loaded.next,
            }
          : loaded
      localError = undefined
      editor.setRecoveryAttempts(page.attempts)
    } else localError = discussionFailure(exit.cause)
    render()
    await vscode.commands.executeCommand(
      'setContext',
      'duff.discussionHasMore',
      page !== undefined && Option.isSome(page.next),
    )
  }

  const updateActive = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri

    const decoded =
      uri?.scheme === 'duff-snapshot' ? decodeSnapshotDocument(uri.query) : Option.none()

    const eligible =
      Option.isSome(active) &&
      Option.isSome(decoded) &&
      commentableDocument(decoded.value, active.value)

    await vscode.commands.executeCommand('setContext', 'duff.commentableSnapshot', eligible)
    await vscode.commands.executeCommand(
      'setContext',
      'duff.commentsShown',
      visibility.current() === 'shown',
    )
  }

  const thread = (value: unknown): DiscussionThread | undefined => {
    const inline = comments.owns(value) ? comments.lookup(value) : undefined

    if (inline) return inline

    if (view.owns(value) && 'comments' in value.value) return value.value

    return undefined
  }

  const outcome = async (attempt: Attempt | undefined) => {
    if (!attempt) {
      await loadDrafts()

      return
    }

    let notice = attemptMessage(attempt)

    if (attempt._tag === 'Confirmed' && attempt.intent.input._tag === 'Draft') {
      try {
        await editor.refresh(attempt.intent.input.draft.id)
      } catch {
        notice +=
          ' The local draft view could not refresh. Do not resend. Keep any dirty text and inspect the saved attempt after storage recovers.'
      }
    }

    if (
      attempt._tag === 'Confirmed' &&
      Option.isSome(active) &&
      sameDiscussion(attempt.intent.key, active.value.key)
    )
      await run(Discussions.use((service) => service.refresh()))
    await loadDrafts()
    await vscode.window.showInformationMessage(`Duff: ${notice}`)
  }

  const currentUri = (value: unknown) =>
    value instanceof vscode.Uri && value.scheme === 'duff-draft'
      ? value
      : vscode.window.activeTextEditor?.document.uri

  const register = (id: string, action: (value: unknown) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (value: unknown) => {
      try {
        return await action(value)
      } catch {
        await vscode.window.showErrorMessage(
          'Duff: Discussion action did not complete. Keep any dirty draft text. Inspect saved attempts before sending again.',
        )

        return undefined
      }
    })

  context.subscriptions.push(
    comments,
    view,
    new vscode.Disposable(() => {
      disposed = true
    }),
    vscode.window.onDidChangeActiveTextEditor(() => runtime.runFork(Effect.promise(updateActive))),
    register('duff.refreshComments', async () => {
      await run(Discussions.use((service) => service.refresh()))
      await loadDrafts()
    }),
    register('duff.loadMoreDiscussion', async () => loadDrafts(true)),
    register('duff.toggleComments', async () => {
      const exit = await runtime.runPromiseExit(visibility.toggle())

      if (exit._tag === 'Failure') {
        await vscode.window.showErrorMessage(
          'Duff: Could not remember comments visibility. The current choice is unchanged.',
        )

        return
      }

      render()
      await updateActive()
    }),
    register('duff.startDiscussionThread', async () => {
      const origin = active
      const selected = vscode.window.activeTextEditor

      if (Option.isNone(origin) || !selected || selected.document.uri.scheme !== 'duff-snapshot')
        return
      const document = decodeSnapshotDocument(selected.document.uri.query)

      if (
        Option.isNone(document) ||
        document.value._tag !== 'PrReview' ||
        !commentableDocument(document.value, origin.value)
      )
        return
      const envelope = document.value
      const selection = selected.selection

      const end =
        selection.end.line > selection.start.line && selection.end.character === 0
          ? selection.end.line
          : selection.end.line + 1

      if (
        selection.start.line + 1 !== end ||
        (origin.value.key.providerId === 'github' && envelope.side === 'base')
      ) {
        await vscode.window.showInformationMessage(
          'Duff: New threads support one selected line only. GitHub supports only the current head side. No selection was truncated or moved.',
        )

        return
      }

      const change = origin.value.review.files.find((file) => file.path === envelope.logicalPath)

      if (!change) return
      const range = LineRange.make({ start: selection.start.line + 1, end })

      const exit = await runtime.runPromiseExit(
        makeCodeAnchor(origin.value, change, envelope.side, range).pipe(
          Effect.flatMap((anchor) =>
            Discussions.use((service) => service.start(origin.value, anchor)),
          ),
        ),
      )

      if (exit._tag === 'Failure') {
        await vscode.window.showErrorMessage(`Duff: ${discussionFailure(exit.cause)}`)

        return
      }

      await editor.open(exit.value)
      await loadDrafts()
    }),
    register('duff.replyDiscussionThread', async (value) => {
      const target = thread(value)

      if (!target || target.reply._tag === 'Unavailable') return
      const draft = await run(Discussions.use((service) => service.startReply(target.key)))

      if (draft) {
        await editor.open(draft)
        await loadDrafts()
      }
    }),
    register('duff.resolveDiscussionThread', async (value) => {
      const target = thread(value)

      if (target?.resolution._tag !== 'Open' || target.resolve._tag === 'Unavailable') return
      await outcome(
        await run(
          Discussions.use((service) =>
            service.setResolution({
              thread: target.key,
              expected: target.resolution,
              desired: 'resolved',
            }),
          ),
        ),
      )
    }),
    register('duff.reopenDiscussionThread', async (value) => {
      const target = thread(value)

      if (target?.resolution._tag !== 'Resolved' || target.reopen._tag === 'Unavailable') return
      await outcome(
        await run(
          Discussions.use((service) =>
            service.setResolution({
              thread: target.key,
              expected: target.resolution,
              desired: 'open',
            }),
          ),
        ),
      )
    }),
    register('duff.openDiscussionDraft', async (value) => {
      if (view.owns(value) && 'body' in value.value) await editor.open(value.value)
    }),
    register('duff.sendDiscussionDraft', async (value) => {
      const uri = currentUri(value)

      if (uri?.scheme !== 'duff-draft') return
      const draft = await editor.current(uri)

      const confirm = await vscode.window.showWarningMessage(
        `Send comment to ${draftDestination(draft)}?`,
        { modal: true },
        'Send',
      )

      if (confirm !== 'Send') return
      const latest = await editor.current(uri)

      if (latest.version !== draft.version) {
        await vscode.window.showInformationMessage(
          'Duff: Draft changed during confirmation. Review the latest text, then Send again.',
        )

        return
      }

      await outcome(
        await run(
          Discussions.use((service) =>
            service.send({ id: draft.id, expectedVersion: draft.version }),
          ),
        ),
      )
    }),
    register('duff.copyDiscussionDraft', async (value) => {
      const uri = currentUri(value)

      if (uri?.scheme === 'duff-draft') await editor.copy(uri)
    }),
    register('duff.discardDiscussionDraft', async (value) => {
      const uri = currentUri(value)

      if (uri?.scheme !== 'duff-draft') return
      const draft = await editor.current(uri)

      if (
        draft.body.length > 0 &&
        (await vscode.window.showWarningMessage(
          'Discard this saved draft? This cannot be undone.',
          { modal: true },
          'Discard',
        )) !== 'Discard'
      )
        return

      const discarded = await run(
        Discussions.use((service) =>
          service.discard({ id: draft.id, expectedVersion: draft.version }).pipe(Effect.as(true)),
        ),
      )

      if (discarded) await editor.refresh(draft.id)
      await loadDrafts()
    }),
    register('duff.returnToDiscussionDiff', async (value) => {
      const uri = currentUri(value)

      if (uri?.scheme !== 'duff-draft') return
      const draft = await editor.destination(uri)
      const checked = await runtime.runPromiseExit(draftDiffAnchor(draft, state))

      if (checked._tag === 'Failure') {
        await vscode.window.showInformationMessage(
          'Duff: Return to Diff needs current exact placement and an available originating immutable comparison. This draft remains editable and recoverable.',
        )

        return
      }

      const change = checked.value.change
      const base = snapshotDocument(draft.origin, change, 'base')
      const head = snapshotDocument(draft.origin, change, 'head')
      await vscode.commands.executeCommand(
        'vscode.diff',
        snapshotUri(base.snapshot, base),
        snapshotUri(head.snapshot, head),
        change.path,
        { preview: false },
      )
    }),
    register('duff.inspectDiscussionThread', async (value) => {
      const target = thread(value)

      if (!target) return

      const document = await vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: target.comments
          .map(
            (comment) =>
              `${comment.author}${comment.publication === 'pending' ? ' (Pending review, not published)' : ''}\n${comment.deleted ? '[Deleted comment]' : comment.body}\n`,
          )
          .join('\n'),
      })

      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      })

      const choices = [
        target.reply._tag !== 'Unavailable' ? 'Reply in Draft Editor' : undefined,
        target.resolution._tag === 'Open' && target.resolve._tag !== 'Unavailable'
          ? 'Resolve'
          : undefined,
        target.resolution._tag === 'Resolved' && target.reopen._tag !== 'Unavailable'
          ? 'Reopen'
          : undefined,
        Option.isSome(target.providerPage) ? 'Open Provider Page' : undefined,
      ].filter((choice) => choice !== undefined)

      const action = await vscode.window.showQuickPick(choices, {
        title: target.comments
          .map((comment) => `${comment.author}: ${comment.body}`)
          .join('\n')
          .slice(0, 2000),
        placeHolder:
          target.anchor._tag === 'Unplaced' ? `Unplaced: ${target.anchor.reason}` : 'PR thread',
      })

      if (action === 'Open Provider Page' && Option.isSome(target.providerPage)) {
        const url = vscode.Uri.parse(target.providerPage.value)

        if (
          url.scheme === 'https' &&
          url.authority === target.key.discussion.repository.authority &&
          !url.authority.includes('@')
        )
          await vscode.env.openExternal(url)
      } else if (action)
        await vscode.commands.executeCommand(
          Match.value(action).pipe(
            Match.when('Resolve', () => 'duff.resolveDiscussionThread'),
            Match.when('Reopen', () => 'duff.reopenDiscussionThread'),
            Match.orElse(() => 'duff.replyDiscussionThread'),
          ),
          value,
        )
    }),
    register('duff.inspectDiscussionAttempt', async (value) => {
      if (!view.owns(value) || !('intent' in value.value)) return
      const attempt = value.value

      const confirmed = await vscode.window.showWarningMessage(
        `${attemptMessage(attempt)} Acknowledging releases the destination reservation. A later explicit Send may duplicate a posted comment.`,
        { modal: true },
        'Acknowledge Possible Duplicate',
      )

      if (confirmed === 'Acknowledge Possible Duplicate') {
        await run(Discussions.use((service) => service.acknowledgeUncertain(attempt.intent.id)))
        await loadDrafts()
      }
    }),
  )
  runtime.runFork(
    Discussions.use((service) =>
      Stream.runForEach(service.changes, (next) =>
        Effect.sync(() => {
          state = next
          render()
        }),
      ),
    ),
  )

  runtime.runFork(Effect.promise(() => loadDrafts()))

  return new DiscussionRegistration(
    async (review: Option.Option<DiscussionReview>) => {
      generation++
      active = review
      state = Option.isSome(active)
        ? { _tag: 'Loading', review: active.value }
        : { _tag: 'Inactive' }
      page = undefined
      localError = undefined
      render()
      await run(Discussions.use((service) => service.activate(active)))
      await updateActive()
      await loadDrafts()
    },
    () => active,
  )
}

class DiscussionRegistration {
  constructor(
    readonly accept: (review: Option.Option<DiscussionReview>) => Promise<void>,
    readonly current: () => Option.Option<DiscussionReview>,
  ) {}
}
