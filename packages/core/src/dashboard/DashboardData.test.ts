import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AuthenticationRequired,
  ChangeStatistics,
  type DiscoveryError,
  GitHostingProvider,
  OpenPullRequest,
  ProviderRepository,
  ProviderUnavailable,
  PullRequestDetails,
  RateLimited,
} from '../pull-requests/GitHostingProvider'
import { DashboardData, RepositoryNavigationSnapshot } from './DashboardData'
import { HostedRepository } from './Repositories'
import { makeRepositoryDirectoryLayer } from './RepositoryDirectory'

const identity = { authority: 'example.test', key: 'owner/repo', displayName: 'Repo' }

const providerIdentity = {
  id: 'test',
  displayName: 'Test',
  authenticationSource: 'github',
} satisfies HostedRepository['provider']

const hosted = HostedRepository.make({
  provider: providerIdentity,
  repository: identity,
  cloneUrl: 'https://example.test/owner/repo',
})

const pull = OpenPullRequest.make({
  id: '1',
  title: 'Title',
  url: 'https://example.test/pr/1',
  draft: false,
  source: {
    _tag: 'Available',
    repository: identity,
    ref: { name: 'refs/heads/topic', revision: Option.some('a'.repeat(40)) },
  },
  target: {
    repository: identity,
    ref: { name: 'refs/heads/main', revision: Option.some('b'.repeat(40)) },
  },
})

const details = PullRequestDetails.make({
  pullRequest: pull,
  description: 'Description',
  filesChanged: Option.none(),
  linesChanged: Option.none(),
})

const statistics = ChangeStatistics.make({
  comparison: {
    providerId: 'test',
    authority: identity.authority,
    targetRepository: identity,
    sourceRepository: identity,
    pullRequestId: '1',
    targetRevision: 'b'.repeat(40),
    sourceRevision: 'a'.repeat(40),
    baseRevision: 'c'.repeat(40),
    mode: 'merge-base-v1',
  },
  filesChanged: Option.some(1),
  lines: { _tag: 'Complete', additions: 3, deletions: 2 },
})

const layer = (
  metadata: (id: string) => Effect.Effect<PullRequestDetails, DiscoveryError>,
  stats: NonNullable<ProviderRepository['getPullRequestStatistics']> = () =>
    Effect.succeed(statistics),
  listing: ProviderRepository['listPullRequests'] = () =>
    Effect.succeed({ items: [pull], next: Option.none() }),
  repositories: ReadonlyArray<HostedRepository> = [hosted],
) =>
  DashboardData.layer.pipe(
    Layer.provide(
      makeRepositoryDirectoryLayer([
        GitHostingProvider.of({
          identity: providerIdentity,
          destination: (identity) =>
            Option.fromUndefinedOr(
              repositories.find(
                (hosted) =>
                  hosted.repository.authority === identity.authority &&
                  hosted.repository.key === identity.key,
              )?.cloneUrl,
            ),
          recognizeRemote: (remote) =>
            Option.map(
              Option.fromUndefinedOr(
                repositories.find((hosted) => hosted.cloneUrl === remote.destination),
              ),
              (hosted) =>
                ProviderRepository.of({
                  identity: hosted.repository,
                  inspectAuthentication: () =>
                    Effect.succeed({ _tag: 'Authenticated', account: Option.none() }),
                  connectAuthentication: () =>
                    Effect.succeed({ _tag: 'Authenticated', account: Option.none() }),
                  getPullRequest: () => Effect.succeed(pull),
                  getPullRequestDetails: metadata,
                  getPullRequestMetadata: metadata,
                  getPullRequestStatistics: stats,
                  getAvatar: () => Effect.succeed(Option.none()),
                  listPullRequests: listing,
                }),
            ),
        }),
      ]),
    ),
  )

it.effect(
  'uses one freshness policy at 59/60 seconds; manual refresh and metadata do not suppress first statistics',
  () => {
    let metadataCalls = 0
    let statisticsCalls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.metadata(hosted, '1')
      expect(Option.getOrThrow(yield* data.peekMetadata(hosted, '1')).description).toBe(
        'Description',
      )
      yield* data.statistics(hosted, pull)
      expect(statisticsCalls).toBe(1)
      yield* TestClock.adjust('59 seconds')
      yield* data.metadata(hosted, '1')
      expect(metadataCalls).toBe(1)
      yield* TestClock.adjust('1 second')
      yield* data.metadata(hosted, '1')
      expect(metadataCalls).toBe(2)
      yield* data.metadata(hosted, '1', true)
      yield* data.statistics(hosted, pull, true)
      expect(metadataCalls).toBe(3)
      expect(statisticsCalls).toBe(1)
    }).pipe(
      Effect.provide(
        layer(
          () => {
            metadataCalls++

            return Effect.succeed(details)
          },
          () => {
            statisticsCalls++

            return Effect.succeed(statistics)
          },
        ),
      ),
    )
  },
)

it.effect('retries unavailable statistics after 60s or manual refresh without caching zero', () => {
  let calls = 0

  return Effect.gen(function* () {
    const data = yield* DashboardData
    const first = yield* data.statistics(hosted, pull)
    expect(first.lines._tag).toBe('Unavailable')
    yield* data.metadata(hosted, '1')
    yield* data.statistics(hosted, pull)
    expect(calls).toBe(1)
    yield* TestClock.adjust('60 seconds')
    yield* data.statistics(hosted, pull)
    expect(calls).toBe(2)
    yield* data.statistics(hosted, pull, true)
    expect(calls).toBe(3)
  }).pipe(
    Effect.provide(
      layer(
        () => Effect.succeed(details),
        () => {
          calls++

          return Effect.succeed(
            ChangeStatistics.make({
              comparison: statistics.comparison,
              filesChanged: Option.some(1),
              lines: { _tag: 'Unavailable', reason: 'incomplete-response' },
            }),
          )
        },
      ),
    ),
  )
})

it.effect(
  'retains stale metadata after typed failures and respects retry-after even for manual refresh',
  () => {
    let calls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.metadata(hosted, '1')
      yield* data.metadata(hosted, '1', true).pipe(Effect.result)
      expect(calls).toBe(2)
      yield* data.metadata(hosted, '1', true).pipe(Effect.result)
      expect(calls).toBe(2)
      expect(Option.isSome(yield* data.peekMetadata(hosted, '1'))).toBe(true)
      yield* TestClock.adjust('119 seconds')
      yield* data.metadata(hosted, '1', true).pipe(Effect.result)
      expect(calls).toBe(2)
      yield* TestClock.adjust('1 second')
      yield* data.metadata(hosted, '1', true).pipe(Effect.result)
      expect(calls).toBe(3)
    }).pipe(
      Effect.provide(
        layer(() => {
          calls++

          return calls === 1
            ? Effect.succeed(details)
            : Effect.fail(new RateLimited({ retryAfterSeconds: Option.some(120) }))
        }),
      ),
    )
  },
)

it.effect(
  'shares concurrent automatic/manual work and cancels transport when its last caller leaves',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let calls = 0
      yield* Effect.gen(function* () {
        const data = yield* DashboardData
        const first = yield* data.metadata(hosted, '1').pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        const second = yield* data.metadata(hosted, '1', true).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        expect(calls).toBe(1)
        yield* Fiber.interrupt(first)
        expect(yield* Deferred.isDone(interrupted)).toBe(false)
        yield* Deferred.succeed(complete, undefined)
        expect((yield* Fiber.join(second)).description).toBe('Description')
        const pending = yield* data.metadata(hosted, '2').pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(pending)
        expect(yield* Deferred.isDone(interrupted)).toBe(true)
      }).pipe(
        Effect.provide(
          layer((id) =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(started, undefined)

              if (id === '2') return yield* Effect.never
              else yield* Deferred.await(complete)

              return details
            }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          ),
        ),
      )
    }),
)

it.effect(
  'keeps auth failures typed, retries after local age, and invalidates retained metadata',
  () => {
    let calls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      expect(yield* data.metadata(hosted, '1').pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'AuthenticationRequired' },
      })
      yield* data.metadata(hosted, '1').pipe(Effect.result)
      expect(calls).toBe(1)
      yield* TestClock.adjust('60 seconds')
      yield* data.metadata(hosted, '1')
      yield* data.invalidate(hosted)
      expect(Option.isNone(yield* data.peekMetadata(hosted, '1'))).toBe(true)
      yield* data.metadata(hosted, '1')
      expect(calls).toBe(3)
    }).pipe(
      Effect.provide(
        layer(() => {
          calls++

          return calls === 1 ? Effect.fail(new AuthenticationRequired()) : Effect.succeed(details)
        }),
      ),
    )
  },
)

it.effect('does not cache transient failure as a complete comparison', () => {
  let calls = 0

  return Effect.gen(function* () {
    const data = yield* DashboardData
    yield* data.statistics(hosted, pull).pipe(Effect.result)
    yield* data.statistics(hosted, pull, true)
    expect(calls).toBe(2)
  }).pipe(
    Effect.provide(
      layer(
        () => Effect.succeed(details),
        () => {
          calls++

          return calls === 1 ? Effect.fail(new ProviderUnavailable()) : Effect.succeed(statistics)
        },
      ),
    ),
  )
})

const revisionSelection = (
  id: string,
  sourceRevision = 'a'.repeat(40),
  targetRevision = 'b'.repeat(40),
) =>
  OpenPullRequest.make({
    id,
    title: 'Title',
    url: 'https://example.test/pr/1',
    draft: false,
    source: {
      _tag: 'Available',
      repository: identity,
      ref: { name: 'refs/heads/topic', revision: Option.some(sourceRevision) },
    },
    target: {
      repository: identity,
      ref: { name: 'refs/heads/main', revision: Option.some(targetRevision) },
    },
  })

const statisticsFor = (expected: OpenPullRequest) => {
  if (expected.source._tag !== 'Available') return Effect.die('Expected source')

  return Effect.succeed(
    ChangeStatistics.make({
      comparison: {
        providerId: 'test',
        authority: expected.target.repository.authority,
        targetRepository: expected.target.repository,
        sourceRepository: expected.source.repository,
        pullRequestId: expected.id,
        sourceRevision: Option.getOrThrow(expected.source.ref.revision),
        targetRevision: Option.getOrThrow(expected.target.ref.revision),
        baseRevision: 'c'.repeat(40),
        mode: 'merge-base-v1',
      },
      filesChanged: Option.some(1),
      lines: { _tag: 'Complete', additions: 3, deletions: 2 },
    }),
  )
}

it.effect(
  'keys statistics by immutable source and target and evicts completed comparisons at 100',
  () => {
    let calls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.statistics(hosted, pull)
      yield* data.statistics(hosted, revisionSelection('1', 'd'.repeat(40)))
      yield* data.statistics(hosted, revisionSelection('1', 'a'.repeat(40), 'e'.repeat(40)))
      expect(calls).toBe(3)
      yield* data.statistics(hosted, pull)
      expect(calls).toBe(3)

      for (let id = 2; id <= 101; id++)
        yield* data.statistics(hosted, revisionSelection(String(id)))
      yield* data.statistics(hosted, pull)
      expect(calls).toBe(104)
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(details),
          (expected) => {
            calls++

            return statisticsFor(expected)
          },
        ),
      ),
    )
  },
)

it.effect('an invalidation prevents late completion from repopulating cached values', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const data = yield* DashboardData
      const pending = yield* data.metadata(hosted, '1').pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* data.invalidate(hosted)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(pending)
      expect(Option.isNone(yield* data.peekMetadata(hosted, '1'))).toBe(true)
    }).pipe(
      Effect.provide(
        layer(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as(details),
          ),
        ),
      ),
    )
  }),
)

it.effect('restores PR A metadata and complete statistics immediately after selecting B', () => {
  let metadataCalls = 0
  let statisticsCalls = 0

  return Effect.gen(function* () {
    const data = yield* DashboardData
    const second = revisionSelection('2')
    yield* data.metadata(hosted, '1')
    yield* data.statistics(hosted, pull)
    yield* data.metadata(hosted, '2')
    yield* data.statistics(hosted, second)

    expect(Option.getOrThrow(yield* data.peekMetadata(hosted, '1'))).toEqual(details)
    expect(Option.getOrThrow(yield* data.peekStatistics(hosted, pull))).toEqual(statistics)
    yield* data.metadata(hosted, '1')
    yield* data.statistics(hosted, pull)
    expect(metadataCalls).toBe(2)
    expect(statisticsCalls).toBe(2)

    for (let id = 3; id <= 21; id++) yield* data.metadata(hosted, String(id))
    expect(Option.isNone(yield* data.peekMetadata(hosted, '2'))).toBe(true)
    expect(Option.isSome(yield* data.peekMetadata(hosted, '1'))).toBe(true)
  }).pipe(
    Effect.provide(
      layer(
        (id) => {
          metadataCalls++

          return Effect.succeed(
            PullRequestDetails.make({ ...details, pullRequest: revisionSelection(id) }),
          )
        },
        (expected) => {
          statisticsCalls++

          return statisticsFor(expected)
        },
      ),
    ),
  )
})

it.effect(
  'ignores URL, ref and repository presentation changes without dropping lookup inputs',
  () => {
    const inputs: OpenPullRequest[] = []

    const presentation = OpenPullRequest.make({
      ...pull,
      title: 'Renamed PR',
      url: 'https://example.test/renamed/pr/1',
      source: {
        _tag: 'Available',
        repository: { ...identity, displayName: 'Renamed source' },
        ref: { name: 'refs/heads/renamed-topic', revision: Option.some('a'.repeat(40)) },
      },
      target: {
        repository: { ...identity, displayName: 'Renamed target' },
        ref: { name: 'refs/heads/renamed-main', revision: Option.some('b'.repeat(40)) },
      },
    })

    const renamed = HostedRepository.make({
      ...hosted,
      provider: { ...providerIdentity, displayName: 'Renamed provider' },
      repository: { ...identity, displayName: 'Renamed repository' },
    })

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.statistics(hosted, pull)
      expect(Option.getOrThrow(yield* data.peekStatistics(renamed, presentation))).toEqual(
        statistics,
      )
      yield* data.statistics(renamed, presentation, true)
      expect(inputs).toEqual([pull])

      const revised = OpenPullRequest.make({
        ...presentation,
        source: {
          _tag: 'Available',
          repository: presentation.target.repository,
          ref: { name: 'refs/heads/renamed-topic', revision: Option.some('d'.repeat(40)) },
        },
      })

      yield* data.statistics(renamed, revised)
      expect(inputs).toEqual([pull, revised])
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(details),
          (expected) => {
            inputs.push(expected)

            return statisticsFor(expected)
          },
        ),
      ),
    )
  },
)

it.effect(
  'distinguishes source repository keys and authorities with equal comparison revisions',
  () => {
    let calls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.statistics(hosted, pull)

      for (const source of [
        { ...identity, key: 'fork/source' },
        { ...identity, authority: 'other.test' },
      ]) {
        const expected = OpenPullRequest.make({
          ...pull,
          source: {
            _tag: 'Available',
            repository: source,
            ref: { name: 'refs/heads/topic', revision: Option.some('a'.repeat(40)) },
          },
        })

        yield* data.statistics(hosted, expected)
        expect(
          Option.getOrThrow(yield* data.peekStatistics(hosted, expected)).comparison
            .sourceRepository,
        ).toEqual(source)
      }

      expect(calls).toBe(3)
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(details),
          (expected) => {
            calls++

            return statisticsFor(expected)
          },
        ),
      ),
    )
  },
)

it.effect('invalidating B retains A and prevents obsolete B work from replacing a new result', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()

    const second = HostedRepository.make({
      ...hosted,
      repository: { ...identity, key: 'owner/second' },
      cloneUrl: 'https://example.test/owner/second',
    })

    const secondPull = OpenPullRequest.make({
      ...pull,
      target: { ...pull.target, repository: second.repository },
    })

    const cachedSecondPull = OpenPullRequest.make({ ...secondPull, id: '2' })

    let secondCalls = 0

    yield* Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.metadata(hosted, '1')
      yield* data.statistics(hosted, pull)
      yield* data.statistics(second, cachedSecondPull)
      const pending = yield* data.statistics(second, secondPull).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* data.invalidate(
        HostedRepository.make({
          ...second,
          repository: { ...second.repository, displayName: 'Renamed second repository' },
        }),
      )
      expect(Option.getOrThrow(yield* data.peekMetadata(hosted, '1'))).toEqual(details)
      expect(Option.getOrThrow(yield* data.peekStatistics(hosted, pull))).toEqual(statistics)
      expect(Option.isNone(yield* data.peekStatistics(second, secondPull))).toBe(true)
      expect(Option.isNone(yield* data.peekStatistics(second, cachedSecondPull))).toBe(true)
      const current = yield* data.statistics(second, secondPull)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(pending)
      expect(Option.getOrThrow(yield* data.peekStatistics(second, secondPull))).toEqual(current)
      expect(current.lines).toEqual({ _tag: 'Complete', additions: 9, deletions: 2 })
      expect(Option.getOrThrow(yield* data.peekStatistics(hosted, pull))).toEqual(statistics)
      yield* data.statistics(hosted, pull)
      expect(secondCalls).toBe(2)
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(details),
          (expected) =>
            Effect.gen(function* () {
              const value = yield* statisticsFor(expected)

              if (expected.target.repository.key !== second.repository.key) return value

              if (expected.id !== secondPull.id) return value
              secondCalls++

              if (secondCalls === 1) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(finish)

                return value
              }

              return ChangeStatistics.make({
                ...value,
                lines: { _tag: 'Complete', additions: 9, deletions: 2 },
              })
            }),
          undefined,
          [hosted, second],
        ),
      ),
    )
  }),
)

it.effect(
  'restores loaded pages, filter, selected PR, query and continuation without provider calls',
  () =>
    Effect.gen(function* () {
      const data = yield* DashboardData

      const open = RepositoryNavigationSnapshot.make({
        filter: 'open',
        pulls: [pull, revisionSelection('2')],
        cursor: Option.some(Redacted.make('cursor')),
        pullRequestId: '2',
        pages: 2,
        query: 'feature',
        listRevision: 0,
      })

      const closed = RepositoryNavigationSnapshot.make({
        filter: 'closed',
        pulls: [pull],
        cursor: Option.none(),
        pullRequestId: '1',
        pages: 1,
        query: '',
        listRevision: 0,
      })

      yield* data.rememberNavigation(hosted, open)
      yield* data.rememberNavigation(hosted, closed)
      expect(Option.getOrThrow(yield* data.peekNavigation(hosted))).toEqual(closed)
      expect(Option.getOrThrow(yield* data.peekNavigation(hosted, 'open'))).toEqual(open)
      yield* data.invalidate(hosted)
      expect(Option.isNone(yield* data.peekNavigation(hosted))).toBe(true)
    }).pipe(Effect.provide(layer(() => Effect.die('Unexpected metadata request')))),
)

it.effect('rejects oversized, duplicate, mismatched or unrelated navigation selections', () =>
  Effect.gen(function* () {
    const data = yield* DashboardData

    for (const snapshot of [
      {
        filter: 'open',
        pulls: [pull],
        cursor: Option.none(),
        pullRequestId: '1',
        pages: 6,
        query: '',
        listRevision: 0,
      },
      {
        filter: 'open',
        pulls: Array.from({ length: 251 }, (_, index) => revisionSelection(String(index))),
        cursor: Option.none(),
        pullRequestId: '',
        pages: 5,
        query: '',
        listRevision: 0,
      },
      {
        filter: 'open',
        pulls: [pull, pull],
        cursor: Option.none(),
        pullRequestId: '1',
        pages: 1,
        query: '',
        listRevision: 0,
      },
      {
        filter: 'open',
        pulls: [pull],
        cursor: Option.none(),
        pullRequestId: '999',
        pages: 1,
        query: '',
        listRevision: 0,
      },
    ] satisfies ReadonlyArray<RepositoryNavigationSnapshot>) {
      expect(yield* data.rememberNavigation(hosted, snapshot).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidProviderResponse' },
      })
    }

    expect(Option.isNone(yield* data.peekNavigation(hosted))).toBe(true)
  }).pipe(Effect.provide(layer(() => Effect.die('Unexpected metadata request')))),
)

it.effect(
  'bounds repository data to 20 repositories and isolates equal PR IDs across repository keys',
  () =>
    Effect.gen(function* () {
      const data = yield* DashboardData

      const empty = RepositoryNavigationSnapshot.make({
        filter: 'open',
        pulls: [],
        cursor: Option.none(),
        pullRequestId: '',
        pages: 1,
        query: '',
        listRevision: 0,
      })

      yield* data.metadata(hosted, '1')
      yield* data.statistics(hosted, pull)
      yield* data.rememberNavigation(
        hosted,
        RepositoryNavigationSnapshot.make({
          filter: 'open',
          pulls: [pull],
          cursor: Option.none(),
          pullRequestId: '1',
          pages: 1,
          query: '',
          listRevision: 0,
        }),
      )

      const repositories = Array.from({ length: 20 }, (_, index) =>
        HostedRepository.make({
          provider: providerIdentity,
          repository: {
            authority: identity.authority,
            key: `owner/repo-${index}`,
            displayName: `Repo ${index}`,
          },
          cloneUrl: `https://example.test/owner/repo-${index}`,
        }),
      )

      for (const repository of repositories) yield* data.rememberNavigation(repository, empty)
      expect(Option.isNone(yield* data.peekNavigation(hosted))).toBe(true)
      expect(Option.isNone(yield* data.peekMetadata(hosted, '1'))).toBe(true)
      expect(Option.isNone(yield* data.peekStatistics(hosted, pull))).toBe(true)
      const last = repositories[19]

      if (!last) return yield* Effect.die('Expected repository')
      expect(Option.getOrThrow(yield* data.peekNavigation(last)).pullRequestId).toBe('')
    }).pipe(Effect.provide(layer(() => Effect.succeed(details)))),
)

it.effect('peeks matching completed totals immediately while stale metadata is revalidated', () => {
  let calls = 0

  return Effect.gen(function* () {
    const data = yield* DashboardData
    expect(Option.isNone(yield* data.peekStatistics(hosted, pull))).toBe(true)
    yield* data.metadata(hosted, '1')
    yield* data.statistics(hosted, pull)
    yield* TestClock.adjust('60 seconds')
    expect(Option.getOrThrow(yield* data.peekStatistics(hosted, pull)).lines).toEqual({
      _tag: 'Complete',
      additions: 3,
      deletions: 2,
    })
    expect(
      Option.isNone(yield* data.peekStatistics(hosted, revisionSelection('1', 'd'.repeat(40)))),
    ).toBe(true)
    expect(calls).toBe(1)
    yield* data.invalidate(hosted)
    expect(Option.isNone(yield* data.peekStatistics(hosted, pull))).toBe(true)
  }).pipe(
    Effect.provide(
      layer(
        () => Effect.succeed(details),
        () => {
          calls++

          return Effect.succeed(statistics)
        },
      ),
    ),
  )
})

it.effect(
  'exposes list provenance without another clock and rejects snapshots from superseded first pages',
  () => {
    let calls = 0

    return Effect.gen(function* () {
      const data = yield* DashboardData
      const first = yield* data.listVersioned(hosted, 'open')

      const navigation = RepositoryNavigationSnapshot.make({
        filter: 'open',
        pulls: [pull, revisionSelection('2')],
        cursor: Option.some(Redacted.make('after-second-page')),
        pullRequestId: '2',
        pages: 2,
        query: '',
        listRevision: first.revision,
      })

      yield* data.rememberNavigation(hosted, navigation)
      yield* TestClock.adjust('59 seconds')
      expect((yield* data.listVersioned(hosted, 'open')).revision).toBe(first.revision)
      expect(Option.getOrThrow(yield* data.peekNavigation(hosted)).pages).toBe(2)
      expect(calls).toBe(1)
      yield* TestClock.adjust('1 second')
      const refreshed = yield* data.listVersioned(hosted, 'open')
      expect(refreshed.revision).toBeGreaterThan(first.revision)
      expect(calls).toBe(2)
      expect(yield* data.rememberNavigation(hosted, navigation).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidProviderResponse' },
      })
      expect(Option.getOrThrow(yield* data.peekListVersioned(hosted, 'open')).revision).toBe(
        refreshed.revision,
      )
      expect((yield* data.list(hosted, 'open')).items).toEqual(refreshed.page.items)
      yield* data.listVersioned(hosted, 'open', true)
      expect(calls).toBe(3)
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(details),
          undefined,
          () => {
            calls++

            return Effect.succeed({ items: [pull], next: Option.none() })
          },
        ),
      ),
    )
  },
)
