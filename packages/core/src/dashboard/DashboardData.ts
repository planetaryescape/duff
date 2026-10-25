import {
  Cache,
  Clock,
  Context,
  Effect,
  Equal,
  Hash,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from 'effect'

import {
  type ChangeStatistics,
  type ComparisonChanged,
  type DiscoveryError,
  InvalidProviderResponse,
  OpenPullRequest,
  type PullRequestDetails,
  RateLimited,
  PullRequestState,
  ChangeCount,
} from '../pull-requests/GitHostingProvider'
import { type HostedRepository } from './Repositories'
import { RepositoryDirectory, RepositoryPullRequestPage } from './RepositoryDirectory'

export const DashboardListResult = Schema.Struct({
  page: RepositoryPullRequestPage,
  revision: ChangeCount,
})

export interface DashboardListResult extends Schema.Schema.Type<typeof DashboardListResult> {}

export const RepositoryNavigationSnapshot = Schema.Struct({
  filter: PullRequestState,
  pulls: Schema.Array(OpenPullRequest).check(Schema.isMaxLength(250)),
  cursor: Schema.Option(Schema.Redacted(Schema.String)),
  pullRequestId: Schema.String,
  pages: ChangeCount.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5)),
  query: Schema.String.check(Schema.isMaxLength(1000)),
  listRevision: ChangeCount,
})

export interface RepositoryNavigationSnapshot extends Schema.Schema.Type<
  typeof RepositoryNavigationSnapshot
> {}

interface Attempt<A, E> {
  readonly result: Result.Result<A, E>
  readonly retryAt: number
  readonly rateLimitUntil: number
}

class ResourceKey<Input> implements Equal.Equal {
  constructor(
    readonly identity: string,
    readonly input: Input,
  ) {}

  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof ResourceKey && this.identity === other.identity
  }

  [Hash.symbol](): number {
    return Hash.string(this.identity)
  }
}

class Resource<A, E, Key = string> {
  constructor(
    readonly get: (key: Key, force?: boolean) => Effect.Effect<A, E>,
    readonly peek: (key: Key) => Effect.Effect<Option.Option<A>>,
    readonly clear: () => Effect.Effect<void>,
  ) {}
}

class RepositoryData {
  constructor(
    readonly metadata: Resource<PullRequestDetails, DiscoveryError>,
    readonly listing: Resource<DashboardListResult, DiscoveryError>,
    readonly statistics: Resource<
      ChangeStatistics,
      DiscoveryError | ComparisonChanged,
      ResourceKey<OpenPullRequest>
    >,
    readonly navigation: Cache.Cache<PullRequestState, RepositoryNavigationSnapshot>,
    readonly lastFilter: Ref.Ref<Option.Option<PullRequestState>>,
  ) {}
}

const makeResource = Effect.fn('DashboardData.makeResource')(function* <
  Key,
  A,
  E extends { readonly _tag: string },
>(
  capacity: number,
  lookup: (key: Key) => Effect.Effect<A, E>,
  immutable: (value: A) => boolean,
  retain: (value: A) => boolean = () => true,
) {
  const attempts = yield* Cache.make<Key, Attempt<A, E>>({
    capacity,
    lookup: () => Effect.die(new Error('Missing dashboard attempt.')),
  })

  const values = yield* Cache.make<Key, A>({
    capacity,
    lookup: () => Effect.die(new Error('Missing dashboard value.')),
  })

  const generation = yield* Ref.make(0)

  const active = yield* Cache.makeWith(
    Effect.fn('DashboardData.load')(function* (key: Key) {
      const started = yield* Ref.get(generation)
      const result = yield* lookup(key).pipe(Effect.result)
      const now = yield* Clock.currentTimeMillis

      const limited =
        Result.isFailure(result) && result.failure._tag === 'RateLimited'
          ? Schema.decodeUnknownOption(RateLimited)(result.failure)
          : Option.none()

      const rateLimitUntil =
        now +
        (Option.isSome(limited) && Option.isSome(limited.value.retryAfterSeconds)
          ? limited.value.retryAfterSeconds.value * 1000
          : 0)

      const retryAt = Math.max(now + 60_000, rateLimitUntil)

      if (started === (yield* Ref.get(generation))) {
        yield* Cache.set(attempts, key, { result, retryAt, rateLimitUntil })

        if (Result.isSuccess(result) && retain(result.success))
          yield* Cache.set(values, key, result.success)
      }

      return yield* Result.isSuccess(result)
        ? Effect.succeed(result.success)
        : Effect.fail(result.failure)
    }),
    { capacity, timeToLive: () => 0 },
  )

  return new Resource(
    Effect.fn('DashboardData.get')(function* (key: Key, force = false) {
      const running = yield* Cache.getOption(active, key)

      if (Option.isSome(running)) return running.value

      const previous = yield* Cache.getOption(attempts, key)

      if (Option.isSome(previous)) {
        const { result, retryAt, rateLimitUntil } = previous.value
        const now = yield* Clock.currentTimeMillis

        if (
          Result.isFailure(result) &&
          result.failure._tag === 'RateLimited' &&
          now < rateLimitUntil
        )
          return yield* Effect.fail(result.failure)

        if ((Result.isSuccess(result) && immutable(result.success)) || (!force && now < retryAt))
          return yield* Result.isSuccess(result)
            ? Effect.succeed(result.success)
            : Effect.fail(result.failure)
      }

      return yield* Cache.get(active, key)
    }),
    (key: Key) => Cache.getOption(values, key),
    Effect.fn('DashboardData.clear')(function* () {
      yield* Ref.update(generation, (value) => value + 1)
      yield* Cache.invalidateAll(attempts)
      yield* Cache.invalidateAll(values)
      yield* Cache.invalidateAll(active)
    }),
  )
})

const Listing = Schema.Struct({ state: Schema.Literals(['open', 'merged', 'closed']) })

export class DashboardData extends Context.Service<
  DashboardData,
  {
    readonly metadata: (
      hosted: HostedRepository,
      id: string,
      force?: boolean,
    ) => Effect.Effect<PullRequestDetails, DiscoveryError>
    readonly peekMetadata: (
      hosted: HostedRepository,
      id: string,
    ) => Effect.Effect<Option.Option<PullRequestDetails>>
    readonly statistics: (
      hosted: HostedRepository,
      expected: OpenPullRequest,
      force?: boolean,
    ) => Effect.Effect<ChangeStatistics, DiscoveryError | ComparisonChanged>
    readonly peekStatistics: (
      hosted: HostedRepository,
      expected: OpenPullRequest,
    ) => Effect.Effect<Option.Option<ChangeStatistics>>
    readonly rememberNavigation: (
      hosted: HostedRepository,
      snapshot: RepositoryNavigationSnapshot,
    ) => Effect.Effect<void, InvalidProviderResponse>
    readonly peekNavigation: (
      hosted: HostedRepository,
      filter?: PullRequestState,
    ) => Effect.Effect<Option.Option<RepositoryNavigationSnapshot>>
    readonly list: (
      hosted: HostedRepository,
      state: PullRequestState,
      force?: boolean,
    ) => Effect.Effect<RepositoryPullRequestPage, DiscoveryError>
    readonly peekList: (
      hosted: HostedRepository,
      state: PullRequestState,
    ) => Effect.Effect<Option.Option<RepositoryPullRequestPage>>
    readonly listVersioned: (
      hosted: HostedRepository,
      state: PullRequestState,
      force?: boolean,
    ) => Effect.Effect<DashboardListResult, DiscoveryError>
    readonly peekListVersioned: (
      hosted: HostedRepository,
      state: PullRequestState,
    ) => Effect.Effect<Option.Option<DashboardListResult>>
    readonly invalidate: (hosted: HostedRepository) => Effect.Effect<void>
  }
>()('duff/dashboard/DashboardData') {
  static readonly layer = Layer.effect(
    DashboardData,
    Effect.gen(function* () {
      const directory = yield* RepositoryDirectory

      const repositories = yield* Cache.make({
        capacity: 20,
        lookup: Effect.fn('DashboardData.repository')(function* (
          key: ResourceKey<HostedRepository>,
        ) {
          const hosted = key.input

          const metadata = yield* makeResource(
            20,
            (id: string) => directory.metadata(hosted, id),
            () => false,
          )

          const listRevision = yield* Ref.make(0)

          const listing = yield* makeResource(
            3,
            Effect.fn('DashboardData.listRepository')(function* (key: string) {
              const { state } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Listing))(
                key,
              ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

              const result = yield* directory.list(hosted, state, Option.none())

              if (result.items.length > 50) return yield* new InvalidProviderResponse()

              const revision = yield* Ref.updateAndGet(listRevision, (value) => value + 1)

              return DashboardListResult.make({ page: result, revision })
            }),
            () => false,
          )

          const navigation = yield* Cache.make<PullRequestState, RepositoryNavigationSnapshot>({
            capacity: 3,
            lookup: () => Effect.die(new Error('Missing navigation snapshot.')),
          })

          const lastFilter = yield* Ref.make(Option.none<PullRequestState>())

          const statistics = yield* makeResource(
            100,
            (key: ResourceKey<OpenPullRequest>) => directory.statistics(hosted, key.input),
            (value) => value.lines._tag === 'Complete',
            (value) => value.lines._tag === 'Complete',
          )

          return new RepositoryData(metadata, listing, statistics, navigation, lastFilter)
        }),
      })

      const repositoryIdentity = (repository: HostedRepository['repository']) => [
        repository.authority,
        repository.key,
      ]

      const repositoryKey = (hosted: HostedRepository) =>
        new ResourceKey(
          JSON.stringify([hosted.provider.id, repositoryIdentity(hosted.repository)]),
          hosted,
        )

      const statisticsKey = (expected: OpenPullRequest) =>
        new ResourceKey(
          JSON.stringify([
            expected.id,
            expected.source._tag === 'Available'
              ? [repositoryIdentity(expected.source.repository), expected.source.ref.revision]
              : expected.source._tag,
            repositoryIdentity(expected.target.repository),
            expected.target.ref.revision,
          ]),
          expected,
        )

      return DashboardData.of({
        metadata: Effect.fn('DashboardData.metadata')(function* (hosted, id, force) {
          const repository = yield* Cache.get(repositories, repositoryKey(hosted))

          return yield* repository.metadata.get(id, force)
        }),
        peekMetadata: Effect.fn('DashboardData.peekMetadata')(function* (hosted, id) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          return Option.isSome(repository)
            ? yield* repository.value.metadata.peek(id)
            : Option.none()
        }),
        list: Effect.fn('DashboardData.list')(function* (hosted, state, force) {
          const repository = yield* Cache.get(repositories, repositoryKey(hosted))

          return (yield* repository.listing.get(JSON.stringify({ state }), force)).page
        }),
        peekList: Effect.fn('DashboardData.peekList')(function* (hosted, state) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          return Option.isSome(repository)
            ? Option.map(
                yield* repository.value.listing.peek(JSON.stringify({ state })),
                (value) => value.page,
              )
            : Option.none()
        }),
        listVersioned: Effect.fn('DashboardData.listVersioned')(function* (hosted, state, force) {
          const repository = yield* Cache.get(repositories, repositoryKey(hosted))

          return yield* repository.listing.get(JSON.stringify({ state }), force)
        }),
        peekListVersioned: Effect.fn('DashboardData.peekListVersioned')(function* (hosted, state) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          return Option.isSome(repository)
            ? yield* repository.value.listing.peek(JSON.stringify({ state }))
            : Option.none()
        }),
        statistics: Effect.fn('DashboardData.statistics')(function* (hosted, expected, force) {
          const repository = yield* Cache.get(repositories, repositoryKey(hosted))

          return yield* repository.statistics.get(statisticsKey(expected), force)
        }),
        peekStatistics: Effect.fn('DashboardData.peekStatistics')(function* (hosted, expected) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          return Option.isSome(repository)
            ? Option.filter(
                yield* repository.value.statistics.peek(statisticsKey(expected)),
                (value) => value.lines._tag === 'Complete',
              )
            : Option.none()
        }),
        rememberNavigation: Effect.fn('DashboardData.rememberNavigation')(
          function* (hosted, snapshot) {
            const value = yield* RepositoryNavigationSnapshot.makeEffect(snapshot).pipe(
              Effect.mapError(() => new InvalidProviderResponse()),
            )

            if (
              value.pullRequestId !== '' &&
              !value.pulls.some((pull) => pull.id === value.pullRequestId)
            )
              return yield* new InvalidProviderResponse()

            if (
              value.pulls.some(
                (pull) =>
                  pull.target.repository.authority !== hosted.repository.authority ||
                  pull.target.repository.key !== hosted.repository.key ||
                  (pull.state !== undefined && pull.state !== value.filter),
              ) ||
              new Set(value.pulls.map((pull) => pull.id)).size !== value.pulls.length
            )
              return yield* new InvalidProviderResponse()
            const repository = yield* Cache.get(repositories, repositoryKey(hosted))
            const listing = yield* repository.listing.peek(JSON.stringify({ state: value.filter }))

            if (Option.isSome(listing) && listing.value.revision !== value.listRevision)
              return yield* new InvalidProviderResponse()
            yield* Cache.set(repository.navigation, value.filter, value)
            yield* Ref.set(repository.lastFilter, Option.some(value.filter))
          },
        ),
        peekNavigation: Effect.fn('DashboardData.peekNavigation')(function* (hosted, filter) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          if (Option.isNone(repository)) return Option.none()

          const selected =
            filter === undefined ? yield* Ref.get(repository.value.lastFilter) : Option.some(filter)

          return Option.isSome(selected)
            ? yield* Cache.getOption(repository.value.navigation, selected.value)
            : Option.none()
        }),
        invalidate: Effect.fn('DashboardData.invalidate')(function* (hosted) {
          const repository = yield* Cache.getOption(repositories, repositoryKey(hosted))

          if (Option.isSome(repository)) {
            yield* repository.value.metadata.clear()
            yield* repository.value.listing.clear()
            yield* repository.value.statistics.clear()
            yield* Cache.invalidateAll(repository.value.navigation)
            yield* Ref.set(repository.value.lastFilter, Option.none())
          }

          yield* Cache.invalidate(repositories, repositoryKey(hosted))
        }),
      })
    }),
  )
}
