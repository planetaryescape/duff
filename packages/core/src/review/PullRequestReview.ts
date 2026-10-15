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

export class PreparedReview extends Data.Class<{
  readonly selection: PullRequestSelection
  readonly resolved: ResolvedPullRequest
  readonly review: Review
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
  | { readonly _tag: 'Failed'; readonly error: DiscoveryError | ReviewError }

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
    ) => Effect.Effect<void>
    readonly allowFetch: () => Effect.Effect<void>
    readonly cancel: () => Effect.Effect<void>
    readonly exit: () => Effect.Effect<void>
  }
>()('duff/PullRequestReview') {
  static readonly layer = Layer.effect(
    PullRequestReview,
    Effect.gen(function* () {
      const prs = yield* PullRequests
      const git = yield* BranchReview

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

      const activity = (activity: PreparationActivity) =>
        SubscriptionRef.update(
          state,
          (old) => new PreparationState({ root: old.root, accepted: old.accepted, activity }),
        )

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

        yield* SubscriptionRef.update(
          state,
          (old) =>
            new PreparationState({
              root: old.root,
              activity: Activity.Idle(),
              accepted: Option.some(
                new PreparedReview({ selection, resolved, review: result.success }),
              ),
            }),
        )
      })

      const run = (work: Effect.Effect<void, DiscoveryError | ReviewError>) =>
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
        function* (snapshot: GitContextSnapshot, selection: PullRequestSelection) {
          const old = yield* SubscriptionRef.get(state)

          if (Option.getOrUndefined(old.root) !== snapshot.root) return
          yield* FiberMap.clear(jobs)
          yield* activity(Activity.Preparing({ selection }))
          yield* run(
            Effect.gen(function* () {
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

      return PullRequestReview.of({
        changes: SubscriptionRef.changes(state),
        current: () => SubscriptionRef.get(state),
        start,
        allowFetch,
        cancel,
        exit,
        repositoryChanged,
      })
    }),
  )
}
