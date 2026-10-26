import {
  Context,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Schema,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from 'effect'

import {
  type AttemptId,
  type CodeAnchor,
  DiscussionCommandRejected,
  DiscussionLimitExceeded,
  discussionPolicy,
  type DiscussionKey,
  type DiscussionReadError,
  type DiscussionReview,
  DiscussionSnapshot,
  type DiscussionWriteError,
  type DiscussionWriteRejected,
  type DiscussionState,
  type DraftId,
  DraftStorageError,
  type ProviderDiscussion,
  type ProviderReceipt,
  type Resolution,
  type ThreadKey,
  sameComparison,
  sameDiscussion,
  validDiscussionBody,
} from '../pull-requests/Discussion'
import { InvalidProviderResponse } from '../pull-requests/GitHostingProvider'
import { PullRequests } from '../pull-requests/PullRequests'
import { BranchReview } from './BranchReview'
import {
  Attempt,
  type AttemptIntent,
  DiscussionDraftStore,
  DiscussionIds,
  Draft,
  type DraftPage,
  DraftRecoveryPage,
  type DraftSave,
  type DraftVersion,
  transitionAttempt,
} from './DiscussionDrafts'
import { reviewMatches, validateCodeAnchor, validateDiscussionThreads } from './DiscussionPlacement'

export class Discussions extends Context.Service<
  Discussions,
  {
    readonly changes: Stream.Stream<DiscussionState>
    readonly current: () => Effect.Effect<DiscussionState>
    readonly activate: (review: Option.Option<DiscussionReview>) => Effect.Effect<void>
    readonly refresh: () => Effect.Effect<void>
    readonly allDrafts: (
      cursor: Option.Option<string>,
    ) => Effect.Effect<DraftRecoveryPage, DraftStorageError>
    readonly drafts: (
      key: DiscussionKey,
      cursor: Option.Option<string>,
    ) => Effect.Effect<DraftPage, DraftStorageError>
    readonly draft: (id: DraftId) => Effect.Effect<Option.Option<Draft>, DraftStorageError>
    readonly start: (
      review: DiscussionReview,
      anchor: CodeAnchor,
    ) => Effect.Effect<Draft, DraftStorageError | DiscussionCommandRejected>
    readonly startReply: (
      thread: ThreadKey,
    ) => Effect.Effect<Draft, DraftStorageError | DiscussionCommandRejected>
    readonly save: (input: DraftSave) => Effect.Effect<Draft, DraftStorageError>
    readonly discard: (input: DraftVersion) => Effect.Effect<void, DraftStorageError>
    readonly send: (
      input: DraftVersion,
    ) => Effect.Effect<Attempt, DraftStorageError | DiscussionCommandRejected>
    readonly setResolution: (input: {
      readonly thread: ThreadKey
      readonly expected: Resolution
      readonly desired: 'resolved' | 'open'
    }) => Effect.Effect<Attempt, DraftStorageError | DiscussionCommandRejected>
    readonly attempt: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, DraftStorageError>
    readonly acknowledgeUncertain: (id: AttemptId) => Effect.Effect<void, DraftStorageError>
  }
>()('duff/Discussions') {
  static readonly layer = Layer.effect(
    Discussions,
    Effect.gen(function* () {
      const prs = yield* PullRequests
      const git = yield* BranchReview
      const store = yield* DiscussionDraftStore
      const ids = yield* DiscussionIds
      const state = yield* SubscriptionRef.make<DiscussionState>({ _tag: 'Inactive' })
      const reads = yield* FiberMap.make<string, void>()
      const writes = yield* FiberMap.make<string, Attempt, DraftStorageError>()
      const gate = yield* Semaphore.make(1)
      let generation = 0

      const validate = (review: DiscussionReview, anchor: CodeAnchor) =>
        validateCodeAnchor(review, anchor).pipe(Effect.provideService(BranchReview, git))

      const active = Effect.fn('Discussions.active')(function* (key: DiscussionKey) {
        const current = yield* SubscriptionRef.get(state)

        if (current._tag === 'Inactive' || !sameDiscussion(current.review.key, key))
          return yield* new DiscussionCommandRejected({ reason: 'inactive' })

        return current.review
      })

      const readSnapshot = Effect.fn('Discussions.readSnapshot')(
        function* (
          review: DiscussionReview,
        ): Effect.fn.Return<DiscussionSnapshot, DiscussionReadError> {
          const provider = yield* prs.discussion(review.selection)
          const snapshot = yield* provider.read(review)

          if (!sameDiscussion(snapshot.key, review.key)) return yield* new InvalidProviderResponse()

          if (snapshot.threads.some((thread) => !sameDiscussion(thread.key.discussion, review.key)))
            return yield* new InvalidProviderResponse()

          const threads = yield* validateDiscussionThreads(review, snapshot.threads).pipe(
            Effect.provideService(BranchReview, git),
          )

          return DiscussionSnapshot.make({
            key: snapshot.key,
            threads,
            completeness: snapshot.completeness,
          })
        },
        Effect.timeoutOrElse({
          duration: discussionPolicy.refreshTimeout,
          orElse: () => Effect.fail(new DiscussionLimitExceeded()),
        }),
      )

      const launch = Effect.fn('Discussions.launch')(function* (
        review: DiscussionReview,
        previous?: DiscussionSnapshot,
      ) {
        const currentGeneration = ++generation
        yield* SubscriptionRef.set(
          state,
          previous
            ? { _tag: 'Refreshing', review, snapshot: previous }
            : { _tag: 'Loading', review },
        )
        yield* FiberMap.run(
          reads,
          'read',
          Effect.gen(function* () {
            const result = yield* Effect.result(readSnapshot(review))

            if (generation !== currentGeneration) return
            yield* SubscriptionRef.set(
              state,
              result._tag === 'Success'
                ? { _tag: 'Ready', review, snapshot: result.success }
                : previous
                  ? { _tag: 'Stale', review, snapshot: previous, error: result.failure }
                  : { _tag: 'Failed', review, error: result.failure },
            )
          }),
        )
      })

      const activate = Effect.fn('Discussions.activate')(function* (
        review: Option.Option<DiscussionReview>,
      ) {
        generation++
        yield* FiberMap.clear(reads)

        if (Option.isNone(review)) {
          yield* SubscriptionRef.set(state, { _tag: 'Inactive' })

          return
        }

        if (!reviewMatches(review.value)) {
          yield* SubscriptionRef.set(state, {
            _tag: 'Failed',
            review: review.value,
            error: new InvalidProviderResponse(),
          })

          return
        }

        yield* launch(review.value)
      }, gate.withPermits(1))

      const refresh = Effect.fn('Discussions.refresh')(function* () {
        const current = yield* SubscriptionRef.get(state)

        if (current._tag === 'Inactive') return
        yield* launch(current.review, 'snapshot' in current ? current.snapshot : undefined)
      }, gate.withPermits(1))

      const start = Effect.fn('Discussions.start')(function* (
        review: DiscussionReview,
        anchor: CodeAnchor,
      ) {
        const current = yield* active(review.key)

        if (!sameComparison(current.comparison, review.comparison))
          return yield* new DiscussionCommandRejected({ reason: 'stale-command' })

        if (
          anchor.range.start !== anchor.range.end ||
          (review.key.providerId === 'github' && anchor.side !== 'head')
        )
          return yield* new DiscussionCommandRejected({ reason: 'invalid-anchor' })
        const checked = yield* validate(review, anchor)

        const provider = yield* prs
          .discussion(review.selection)
          .pipe(Effect.mapError(() => new DiscussionCommandRejected({ reason: 'invalid-anchor' })))

        yield* provider
          .checkCreate(review, checked)
          .pipe(Effect.mapError(() => new DiscussionCommandRejected({ reason: 'invalid-anchor' })))

        const draft = Draft.make({
          id: yield* ids.draft(),
          key: review.key,
          origin: review,
          target: { _tag: 'NewThread', anchor: checked },
          version: 1,
          body: '',
        })

        return yield* store.create(draft)
      })

      const startReply = Effect.fn('Discussions.startReply')(function* (key: ThreadKey) {
        const review = yield* active(key.discussion)

        const snapshot = yield* readSnapshot(review).pipe(
          Effect.mapError(() => new DiscussionCommandRejected({ reason: 'stale-command' })),
        )

        const thread = snapshot.threads.find((thread) => thread.key.id === key.id)

        if (!thread || thread.reply._tag === 'Unavailable')
          return yield* new DiscussionCommandRejected({ reason: 'stale-command' })

        return yield* store.create(
          Draft.make({
            id: yield* ids.draft(),
            key: review.key,
            origin: review,
            target: { _tag: 'Reply', thread: key },
            version: 1,
            body: '',
          }),
        )
      })

      const execute = Effect.fn('Discussions.execute')(function* (
        intent: AttemptIntent,
        operation: Effect.Effect<ProviderReceipt, DiscussionWriteError>,
        preflight: Effect.Effect<void, DiscussionWriteRejected>,
      ) {
        const checked = yield* preflight.pipe(Effect.result)

        if (checked._tag === 'Failure') {
          const rejected = Attempt.make({
            _tag: 'Rejected',
            intent,
            reason: checked.failure.reason,
          })

          yield* store.finish(rejected).pipe(Effect.uninterruptible)

          return rejected
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const dispatched = yield* store.dispatch(intent.id)
            yield* transitionAttempt({ _tag: 'Prepared', intent }, dispatched)

            const result = yield* restore(operation).pipe(
              Effect.result,
              Effect.onInterrupt(() =>
                store.finish({ _tag: 'Uncertain', intent }).pipe(Effect.catch(() => Effect.void)),
              ),
            )

            const attempt = Attempt.make(
              result._tag === 'Success'
                ? { _tag: 'Confirmed', intent, receipt: result.success }
                : result.failure._tag === 'DiscussionWriteRejected'
                  ? { _tag: 'Rejected', intent, reason: result.failure.reason }
                  : { _tag: 'Uncertain', intent },
            )

            yield* transitionAttempt(dispatched, attempt)
            yield* store.finish(attempt)

            return attempt
          }),
        )
      })

      const runWrite = Effect.fn('Discussions.runWrite')(function* (
        intent: AttemptIntent,
        operation: Effect.Effect<ProviderReceipt, DiscussionWriteError>,
        preflight: Effect.Effect<void, DiscussionWriteRejected>,
      ) {
        yield* store.prepare(intent).pipe(Effect.uninterruptible)
        const fiber = yield* FiberMap.run(writes, intent.id, execute(intent, operation, preflight))

        return yield* Fiber.join(fiber)
      })

      const send = Effect.fn('Discussions.send')(function* (input: DraftVersion) {
        const draft = yield* store.get(input.id)

        if (Option.isNone(draft) || draft.value.version !== input.expectedVersion)
          return yield* new DiscussionCommandRejected({ reason: 'unsaved' })
        const value = draft.value

        if (!validDiscussionBody(value.body))
          return yield* new DiscussionCommandRejected({ reason: 'invalid-body' })

        if (value.target._tag === 'NewThread') yield* validate(value.origin, value.target.anchor)

        const provider = yield* prs
          .discussion(value.origin.selection)
          .pipe(Effect.mapError(() => new DiscussionCommandRejected({ reason: 'stale-command' })))

        const id = yield* ids.attempt()
        const intent: AttemptIntent = { id, key: value.key, input: { _tag: 'Draft', draft: value } }

        return yield* runWrite(
          intent,
          Effect.suspend(() =>
            value.target._tag === 'NewThread'
              ? provider.create({
                  attempt: id,
                  review: value.origin,
                  anchor: value.target.anchor,
                  body: value.body,
                })
              : provider.reply({ attempt: id, thread: value.target.thread, body: value.body }),
          ),
          Effect.suspend(() =>
            value.target._tag === 'NewThread'
              ? provider.checkCreate(value.origin, value.target.anchor)
              : Effect.void,
          ),
        )
      })

      const setResolution = Effect.fn('Discussions.setResolution')(function* (input: {
        readonly thread: ThreadKey
        readonly expected: Resolution
        readonly desired: 'resolved' | 'open'
      }) {
        const review = yield* active(input.thread.discussion)

        const provider: ProviderDiscussion = yield* prs
          .discussion(review.selection)
          .pipe(Effect.mapError(() => new DiscussionCommandRejected({ reason: 'stale-command' })))

        const id = yield* ids.attempt()
        const command = { ...input, attempt: id }

        const intent: AttemptIntent = {
          id,
          key: review.key,
          input: { _tag: 'Resolution', command },
        }

        return yield* runWrite(
          intent,
          Effect.suspend(() => provider.setResolution(command)),
          Effect.void,
        )
      })

      const allDrafts = Effect.fn('Discussions.allDrafts')(function* (
        cursor: Option.Option<string>,
      ) {
        const page = yield* store.listAll(cursor)

        return yield* Schema.decodeUnknownEffect(DraftRecoveryPage)(page).pipe(
          Effect.mapError(() => new DraftStorageError({ reason: 'invalid' })),
        )
      })

      return Discussions.of({
        changes: SubscriptionRef.changes(state),
        current: () => SubscriptionRef.get(state),
        activate,
        refresh,
        allDrafts,
        drafts: store.list,
        draft: store.get,
        start,
        startReply,
        save: store.save,
        discard: store.discard,
        send,
        setResolution,
        attempt: store.getAttempt,
        acknowledgeUncertain: store.acknowledgeUncertain,
      })
    }),
  )
}
