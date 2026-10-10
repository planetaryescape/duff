import {
  Cause,
  Context,
  Effect,
  FiberMap,
  Layer,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'

import {
  GitContext,
  type GitContextError,
  type GitContextSnapshot,
} from '../git-context/GitContext'
import { type DiscoveryError } from '../pull-requests/GitHostingProvider'
import {
  type DiscoveryNotice,
  type GroupId,
  type GroupResult,
  PullRequests,
  type RepositoryGroup,
} from '../pull-requests/PullRequests'

type Ready = Extract<GroupResult, { readonly _tag: 'Ready' }>

export type SessionProblem = DiscoveryError | 'InspectionFailed' | 'UnexpectedFailure'

export interface GroupRow {
  readonly group: RepositoryGroup
  readonly activity: 'Idle' | 'LoadingMore' | 'Connecting' | 'Cooldown'
  readonly content:
    | { readonly _tag: 'Loading' }
    | { readonly _tag: 'Ready'; readonly data: Ready }
    | { readonly _tag: 'Refreshing'; readonly data: Ready }
    | { readonly _tag: 'Stale'; readonly data: Ready; readonly error: SessionProblem }
    | { readonly _tag: 'Failed'; readonly error: SessionProblem }
}

export type ReviewState =
  | { readonly _tag: 'Idle' }
  | {
      readonly _tag: 'Active'
      readonly directory: string
      readonly inspection: 'Inspecting' | 'Ready' | 'Failed'
      readonly snapshot: Option.Option<GitContextSnapshot>
      readonly inspectionError: Option.Option<GitContextError>
      readonly discovering: boolean
      readonly problem: Option.Option<'UnexpectedFailure'>
      readonly rows: ReadonlyArray<GroupRow>
      readonly notices: ReadonlyArray<DiscoveryNotice>
    }

export class ReviewSession extends Context.Service<
  ReviewSession,
  {
    readonly changes: Stream.Stream<ReviewState>
    readonly current: () => Effect.Effect<ReviewState>
    readonly selectRepository: (
      directory: string,
      options: { readonly discover: boolean },
    ) => Effect.Effect<void>
    readonly clear: () => Effect.Effect<void>
    readonly loadMore: (id: GroupId) => Effect.Effect<void>
    readonly connect: (id: GroupId) => Effect.Effect<void>
  }
>()('duff/review-session/ReviewSession') {
  static readonly layer = Layer.effect(
    ReviewSession,
    Effect.gen(function* () {
      const git = yield* GitContext
      const prs = yield* PullRequests
      const state = yield* SubscriptionRef.make<ReviewState>({ _tag: 'Idle' })
      const work = yield* FiberMap.make<string, void>()
      const gate = yield* Semaphore.make(1)

      const updateRow = (id: GroupId, update: (row: GroupRow) => GroupRow) =>
        SubscriptionRef.update(state, (state) =>
          state._tag === 'Active'
            ? { ...state, rows: state.rows.map((row) => (row.group.id === id ? update(row) : row)) }
            : state,
        )

      const dataOf = (row: GroupRow) =>
        'data' in row.content ? Option.some(row.content.data) : Option.none<Ready>()

      const failed = (row: GroupRow, error: SessionProblem): GroupRow => {
        const data = dataOf(row)

        return {
          ...row,
          activity: 'Idle',
          content: Option.isSome(data)
            ? { _tag: 'Stale', data: { ...data.value, hasMore: false }, error }
            : { _tag: 'Failed', error },
        }
      }

      const supervise = (operation: string, effect: Effect.Effect<void>) =>
        effect.pipe(
          Effect.onExit((exit) => {
            if (exit._tag === 'Success' || Cause.hasInterruptsOnly(exit.cause)) return Effect.void

            return SubscriptionRef.update(state, (state): ReviewState =>
              state._tag === 'Active'
                ? {
                    ...state,
                    discovering: false,
                    problem: Option.some('UnexpectedFailure'),
                    rows: state.rows.map((row) => failed(row, 'UnexpectedFailure')),
                  }
                : state,
            ).pipe(
              Effect.andThen(
                Effect.logWarning('Operation failed').pipe(
                  Effect.annotateLogs({ operation, outcome: 'failure' }),
                ),
              ),
            )
          }),
          Effect.interruptible,
        )

      const accept = (row: GroupRow, result: GroupResult, append: boolean): GroupRow => {
        const old = dataOf(row)

        if (result._tag === 'Failed')
          return {
            ...row,
            activity: 'Idle',
            content: Option.isSome(old)
              ? {
                  _tag: 'Stale',
                  data: {
                    ...old.value,
                    hasMore:
                      append &&
                      !['AuthenticationRequired', 'InvalidContinuation'].includes(
                        result.error._tag,
                      ) &&
                      old.value.hasMore,
                  },
                  error: result.error,
                }
              : { _tag: 'Failed', error: result.error },
          }

        const items =
          append && Option.isSome(old)
            ? [
                ...new Map(
                  [...old.value.items, ...result.items].map((pr) => [
                    JSON.stringify([
                      pr.target.repository.authority,
                      pr.target.repository.key,
                      pr.id,
                    ]),
                    pr,
                  ]),
                ).values(),
              ]
            : result.items

        return { ...row, activity: 'Idle', content: { _tag: 'Ready', data: { ...result, items } } }
      }

      const discover = Effect.fn('ReviewSession.discover')(function* (
        snapshot: GitContextSnapshot,
      ) {
        yield* prs.discover(snapshot).pipe(
          Stream.runForEach((event) =>
            SubscriptionRef.update(state, (state) => {
              if (state._tag !== 'Active') return state

              if (event._tag === 'Started')
                return {
                  ...state,
                  discovering: true,
                  notices: event.notices,
                  rows: event.groups.map((group): GroupRow => {
                    const old = state.rows.find((row) => row.group.key === group.key)
                    const data = old ? dataOf(old) : Option.none<Ready>()

                    return {
                      group,
                      activity: 'Idle',
                      content: Option.isSome(data)
                        ? { _tag: 'Refreshing', data: data.value }
                        : { _tag: 'Loading' },
                    }
                  }),
                }

              return {
                ...state,
                rows: state.rows.map((row) =>
                  row.group.id === event.result.group.id ? accept(row, event.result, false) : row,
                ),
              }
            }),
          ),
        )
        yield* SubscriptionRef.update(state, (state) =>
          state._tag === 'Active' ? { ...state, discovering: false } : state,
        )
      })

      const clear = Effect.fn('ReviewSession.clear')(
        function* () {
          yield* FiberMap.clear(work)
          yield* SubscriptionRef.set(state, { _tag: 'Idle' })
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const selectRepository = Effect.fn('ReviewSession.selectRepository')(
        function* (directory: string, options: { readonly discover: boolean }) {
          yield* FiberMap.clear(work)
          const old = yield* SubscriptionRef.get(state)
          const retain = old._tag === 'Active' && old.directory === directory && options.discover
          yield* SubscriptionRef.set(state, {
            _tag: 'Active',
            directory,
            inspection: 'Inspecting',
            snapshot: Option.none(),
            inspectionError: Option.none(),
            discovering: options.discover,
            problem: Option.none(),
            rows: retain
              ? old.rows.map((row): GroupRow => {
                  const data = dataOf(row)

                  return {
                    ...row,
                    activity: 'Idle',
                    content: Option.isSome(data)
                      ? { _tag: 'Refreshing', data: data.value }
                      : { _tag: 'Loading' },
                  }
                })
              : [],
            notices: [],
          })
          yield* FiberMap.run(
            work,
            'inspection',
            supervise(
              'ReviewSession.inspect',
              Effect.gen(function* () {
                const inspected = yield* Effect.result(git.inspect(directory))

                if (inspected._tag === 'Failure') {
                  yield* SubscriptionRef.update(state, (state): ReviewState =>
                    state._tag === 'Active'
                      ? {
                          ...state,
                          inspection: 'Failed',
                          inspectionError: Option.some(inspected.failure),
                          discovering: false,
                          rows: state.rows.map((row) => failed(row, 'InspectionFailed')),
                        }
                      : state,
                  )

                  return
                }

                yield* SubscriptionRef.update(state, (state): ReviewState =>
                  state._tag === 'Active'
                    ? { ...state, inspection: 'Ready', snapshot: Option.some(inspected.success) }
                    : state,
                )

                if (options.discover) yield* discover(inspected.success)
              }),
            ),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const loadMore = Effect.fn('ReviewSession.loadMore')(
        function* (id: GroupId) {
          const current = yield* SubscriptionRef.get(state)

          if (
            current._tag !== 'Active' ||
            current.inspection !== 'Ready' ||
            current.rows.some((row) => row.activity === 'Connecting')
          )
            return
          const row = current.rows.find((row) => row.group.id === id)

          if (!row || row.activity !== 'Idle' || row.content._tag === 'Refreshing') return
          const data = dataOf(row)

          if (Option.isNone(data) || !data.value.hasMore) return
          yield* updateRow(id, (row) => ({ ...row, activity: 'LoadingMore' }))
          yield* FiberMap.run(
            work,
            id,
            supervise(
              'ReviewSession.loadMore',
              Effect.gen(function* () {
                const result = yield* prs.loadMore(id)
                yield* updateRow(id, (row) => accept(row, result, true))

                if (
                  result._tag === 'Failed' &&
                  result.error._tag === 'RateLimited' &&
                  Option.isSome(result.error.retryAfterSeconds)
                ) {
                  yield* updateRow(id, (row) => ({ ...row, activity: 'Cooldown' }))
                  yield* Effect.sleep(result.error.retryAfterSeconds.value * 1000)
                  yield* updateRow(id, (row) => ({ ...row, activity: 'Idle' }))
                }
              }).pipe(
                Effect.catchTag('GroupNotFound', () =>
                  updateRow(id, (row) => ({ ...row, activity: 'Idle' })),
                ),
              ),
            ),
            { onlyIfMissing: true },
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const connect = Effect.fn('ReviewSession.connect')(
        function* (id: GroupId) {
          const current = yield* SubscriptionRef.get(state)

          if (
            current._tag !== 'Active' ||
            current.inspection !== 'Ready' ||
            Option.isNone(current.snapshot) ||
            current.rows.some((row) => row.activity === 'Connecting')
          )
            return
          const row = current.rows.find((row) => row.group.id === id)

          if (!row || row.activity !== 'Idle') return
          const snapshot = current.snapshot.value
          yield* FiberMap.clear(work)
          yield* SubscriptionRef.update(state, (state) =>
            state._tag === 'Active'
              ? {
                  ...state,
                  discovering: false,
                  rows: state.rows.map((row) => failed(row, 'InspectionFailed')),
                }
              : state,
          )
          yield* updateRow(id, (row) => ({ ...row, activity: 'Connecting' }))
          yield* FiberMap.run(
            work,
            'connection',
            supervise(
              'ReviewSession.connect',
              Effect.gen(function* () {
                const result = yield* Effect.result(prs.connect(id))

                if (result._tag === 'Failure') {
                  const error = result.failure

                  if (error._tag !== 'GroupNotFound')
                    yield* updateRow(id, (row) =>
                      accept(row, { _tag: 'Failed', group: row.group, error }, false),
                    )

                  return
                }

                yield* discover(snapshot)
              }),
            ),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      return ReviewSession.of({
        changes: SubscriptionRef.changes(state),
        current: () => SubscriptionRef.get(state),
        selectRepository,
        clear,
        loadMore,
        connect,
      })
    }),
  )
}
