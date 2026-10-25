import {
  Context,
  Data,
  Effect,
  FiberMap,
  Layer,
  Option,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import { type DiscoveryError } from '../pull-requests/GitHostingProvider'
import {
  PullRequests,
  type PullRequestSelection,
  type ResolvedPullRequest,
} from '../pull-requests/PullRequests'
import { BranchReview, type Review, type ReviewError } from './BranchReview'
import { ReviewSessions, reviewSessionKey } from './ReviewSessions'
import { type SavedReview, type ReviewStorageError } from './SavedReviews'

export class PreparedReview extends Data.Class<{
  readonly selection: PullRequestSelection
  readonly resolved: ResolvedPullRequest
  readonly review: Review
  readonly saved: SavedReview
}> {}

export type PreparationActivity =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Preparing'; readonly selection: PullRequestSelection }
  | {
      readonly _tag: 'AwaitingFetch'
      readonly selection: PullRequestSelection
      readonly resolved: ResolvedPullRequest
      readonly root: string
    }
  | { readonly _tag: 'Failed'; readonly error: DiscoveryError | ReviewError | ReviewStorageError }

const Activity = Data.taggedEnum<PreparationActivity>()

export class PreparationState extends Data.Class<{
  readonly root: Option.Option<string>
  readonly activity: PreparationActivity
  readonly accepted: Option.Option<PreparedReview>
}> {}

export class PullRequestReview extends Context.Service<
  PullRequestReview,
  {
    readonly changes: Stream.Stream<PreparationState>
    readonly current: () => Effect.Effect<PreparationState>
    readonly repositoryChanged: (
      directory: Option.Option<string>,
      root: Option.Option<string>,
    ) => Effect.Effect<void>
    readonly start: (
      snapshot: GitContextSnapshot,
      selection: PullRequestSelection,
      mode?: 'resume' | 'update',
    ) => Effect.Effect<void>
    readonly allowFetch: () => Effect.Effect<void>
    readonly cancel: () => Effect.Effect<void>
    readonly exit: () => Effect.Effect<void, ReviewStorageError>
    readonly restore: (root: string) => Effect.Effect<void, ReviewStorageError | ReviewError>
    readonly openPrepared: (
      selection: PullRequestSelection,
      resolved: ResolvedPullRequest,
      review: Review,
    ) => Effect.Effect<void, ReviewStorageError | ReviewError>
    readonly resume: (key: string) => Effect.Effect<void, ReviewStorageError | ReviewError>
    readonly mark: (
      review: Review,
      paths: ReadonlyArray<string>,
      viewed: boolean,
    ) => Effect.Effect<void, ReviewStorageError | ReviewError>
  }
>()('duff/PullRequestReview') {
  static readonly layer = Layer.effect(
    PullRequestReview,
    Effect.gen(function* () {
      const prs = yield* PullRequests
      const git = yield* BranchReview
      const sessions = yield* ReviewSessions

      const state = yield* SubscriptionRef.make(
        new PreparationState({
          root: Option.none(),
          activity: Activity.Idle(),
          accepted: Option.none(),
        }),
      )

      const jobs = yield* FiberMap.make<string, void>()
      const gate = yield* Semaphore.make(1)
      let directory: Option.Option<string> = Option.none()
      let durableActive = false

      const list = Effect.fn('PullRequestReview.list')(function* () {
        const catalog = yield* sessions.list()
        durableActive = Option.isSome(catalog.active)

        return catalog
      }, Effect.uninterruptible)

      const activity = (activity: PreparationActivity) =>
        SubscriptionRef.update(
          state,
          (old) => new PreparationState({ root: old.root, accepted: old.accepted, activity }),
        )

      const accepted = (saved: SavedReview) =>
        new PreparedReview({
          selection: saved.selection,
          resolved: saved.resolved,
          review: saved.review,
          saved,
        })

      const prepare = Effect.fn('PullRequestReview.prepare')(function* (
        root: string,
        selection: PullRequestSelection,
        resolved: ResolvedPullRequest,
        permission: 'local-only' | 'fetch',
      ) {
        const result = yield* Effect.result(git.prepare(root, resolved.revisions, permission))

        if (result._tag === 'Failure') {
          if (result.failure._tag === 'FetchRequired') {
            yield* activity(Activity.AwaitingFetch({ root, selection, resolved }))

            return
          }

          return yield* result.failure
        }

        // Once persistence begins, cancellation waits for publication too. Otherwise
        // a cancelled job could change the durable active session without its view.
        yield* Effect.gen(function* () {
          const saved = yield* sessions.accept(selection, resolved, result.success)
          durableActive = true
          yield* SubscriptionRef.update(
            state,
            (old) =>
              new PreparationState({
                root: old.root,
                activity: Activity.Idle(),
                accepted: Option.some(accepted(saved)),
              }),
          )
        }).pipe(Effect.uninterruptible)
      })

      const run = (work: Effect.Effect<void, DiscoveryError | ReviewError | ReviewStorageError>) =>
        FiberMap.run(
          jobs,
          'prepare',
          work.pipe(
            Effect.catch((error) => activity(Activity.Failed({ error }))),
            Effect.interruptible,
          ),
        ).pipe(Effect.asVoid)

      const cancel = Effect.fn('PullRequestReview.cancel')(
        function* () {
          yield* FiberMap.clear(jobs)
          yield* activity(Activity.Idle())
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const exit = Effect.fn('PullRequestReview.exit')(
        function* () {
          yield* FiberMap.clear(jobs)

          if (durableActive) yield* sessions.leave()
          durableActive = false
          yield* SubscriptionRef.update(
            state,
            (old) =>
              new PreparationState({
                root: old.root,
                activity: Activity.Idle(),
                accepted: Option.none(),
              }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const repositoryChanged = Effect.fn('PullRequestReview.repositoryChanged')(
        function* (selected: Option.Option<string>, root: Option.Option<string>) {
          const old = yield* SubscriptionRef.get(state)
          const sameDirectory = Option.getOrUndefined(directory) === Option.getOrUndefined(selected)
          directory = selected

          if (sameDirectory && Option.isSome(selected) && Option.isNone(root)) return

          if (sameDirectory && Option.getOrUndefined(old.root) === Option.getOrUndefined(root))
            return
          yield* FiberMap.clear(jobs)
          yield* SubscriptionRef.set(
            state,
            new PreparationState({ root, activity: Activity.Idle(), accepted: Option.none() }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const start = Effect.fn('PullRequestReview.start')(
        function* (
          snapshot: GitContextSnapshot,
          selection: PullRequestSelection,
          mode: 'resume' | 'update' = 'resume',
        ) {
          const old = yield* SubscriptionRef.get(state)

          if (Option.getOrUndefined(old.root) !== snapshot.root) return
          yield* FiberMap.clear(jobs)
          yield* activity(Activity.Preparing({ selection }))
          yield* run(
            Effect.gen(function* () {
              const saved = (yield* list()).sessions.find(
                (item) => item.key === reviewSessionKey(snapshot.root, selection),
              )

              if (saved && mode === 'resume') {
                yield* Effect.gen(function* () {
                  const resumed = yield* sessions.resume(saved.key)
                  durableActive = true
                  yield* SubscriptionRef.update(
                    state,
                    (current) =>
                      new PreparationState({
                        root: current.root,
                        activity: Activity.Idle(),
                        accepted: Option.some(accepted(resumed)),
                      }),
                  )
                }).pipe(Effect.uninterruptible)

                return
              }

              const resolved = yield* prs.resolve(snapshot, selection)
              yield* prepare(snapshot.root, selection, resolved, 'local-only')
            }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const allowFetch = Effect.fn('PullRequestReview.allowFetch')(
        function* () {
          const old = yield* SubscriptionRef.get(state)

          if (old.activity._tag !== 'AwaitingFetch') return
          const { root, selection, resolved } = old.activity
          yield* FiberMap.clear(jobs)
          yield* activity(Activity.Preparing({ selection }))
          yield* run(prepare(root, selection, resolved, 'fetch'))
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const resume = Effect.fn('PullRequestReview.resume')(function* (key: string) {
        const current = yield* SubscriptionRef.get(state)
        const savedSession = (yield* list()).sessions.find((item) => item.key === key)

        if (savedSession && savedSession.review.root !== Option.getOrUndefined(current.root)) return
        yield* FiberMap.clear(jobs)
        const saved = yield* sessions.resume(key)
        durableActive = true
        yield* SubscriptionRef.set(
          state,
          new PreparationState({
            root: current.root,
            activity: Activity.Idle(),
            accepted: Option.some(accepted(saved)),
          }),
        )
      })

      const restore = Effect.fn('PullRequestReview.restore')(
        function* (root: string) {
          const current = yield* list()

          const saved = current.sessions.find(
            (item) =>
              item.key === Option.getOrUndefined(current.active) && item.review.root === root,
          )

          if (saved) yield* resume(saved.key)
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const mark = Effect.fn('PullRequestReview.mark')(
        function* (review: Review, paths: ReadonlyArray<string>, viewed: boolean) {
          const current = yield* SubscriptionRef.get(state)

          if (Option.isNone(current.accepted)) return

          const saved = yield* sessions.progress(
            current.accepted.value.saved.key,
            review,
            paths,
            viewed,
          )

          yield* SubscriptionRef.update(state, (old) =>
            old.accepted === current.accepted
              ? new PreparationState({
                  root: old.root,
                  activity: old.activity,
                  accepted: Option.some(accepted(saved)),
                })
              : old,
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const openPrepared = Effect.fn('PullRequestReview.openPrepared')(
        function* (selection: PullRequestSelection, resolved: ResolvedPullRequest, review: Review) {
          yield* FiberMap.clear(jobs)
          const saved = yield* sessions.accept(selection, resolved, review)
          directory = Option.some(review.root)
          durableActive = true
          yield* SubscriptionRef.set(
            state,
            new PreparationState({
              root: Option.some(review.root),
              activity: Activity.Idle(),
              accepted: Option.some(accepted(saved)),
            }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      return PullRequestReview.of({
        changes: SubscriptionRef.changes(state),
        current: () => SubscriptionRef.get(state),
        start,
        allowFetch,
        cancel,
        exit,
        repositoryChanged,
        restore,
        openPrepared,
        resume: (key) => resume(key).pipe(gate.withPermits(1), Effect.uninterruptible),
        mark,
      })
    }),
  )
}
