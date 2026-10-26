import { DashboardData } from '@duff/core/dashboard-data'
import { defaultDashboardPreferences } from '@duff/core/dashboard-preferences'
import {
  HostedRepository,
  RepositoryCatalog,
  WatchedRepository,
} from '@duff/core/dashboard-repositories'
import {
  GitHostingProvider,
  OpenPullRequest,
  ProviderRepository,
  PullRequestDetails,
} from '@duff/core/git-hosting-provider'
import {
  makeRepositoryDirectoryLayer,
  RepositoryDirectory,
  RepositoryPullRequestPage,
  RepositorySource,
} from '@duff/core/repository-directory'
import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'

import { dashboardPullRequestPage } from './DashboardPullRequests'

const hosted = HostedRepository.make({
  provider: { id: 'fixture', displayName: 'Fixture', authenticationSource: 'github' },
  repository: { authority: 'example.test', key: 'repo', displayName: 'repo' },
  cloneUrl: 'https://example.test/repo.git',
})

const watched = WatchedRepository.make({
  id: 'repo',
  name: 'repo',
  hosting: Option.some(hosted),
  localPaths: [],
})

const pull = OpenPullRequest.make({
  id: 'selected',
  title: 'Selected PR',
  url: 'https://example.test/pr/selected',
  draft: false,
  source: {
    _tag: 'Available',
    repository: hosted.repository,
    ref: { name: 'refs/heads/topic', revision: Option.some('a'.repeat(40)) },
  },
  target: {
    repository: hosted.repository,
    ref: { name: 'refs/heads/main', revision: Option.some('b'.repeat(40)) },
  },
})

it.effect(
  'recovers the persisted selection with metadata only and keeps pagination independent of selected statistics',
  () => {
    const metadataRequests: string[] = []
    const pages: string[] = []
    let closed = false

    const directory = makeRepositoryDirectoryLayer([
      GitHostingProvider.of({
        identity: hosted.provider,
        destination: () => Option.some(hosted.cloneUrl),
        recognizeRemote: () =>
          Option.some(
            ProviderRepository.of({
              identity: hosted.repository,
              inspectAuthentication: () =>
                Effect.succeed({ _tag: 'Authenticated', account: Option.none() }),
              connectAuthentication: () =>
                Effect.succeed({ _tag: 'Authenticated', account: Option.none() }),
              getPullRequest: () => Effect.succeed(pull),
              getPullRequestDetails: () =>
                Effect.die(new Error('Recovery must not request combined details')),
              getPullRequestMetadata: (id) => {
                metadataRequests.push(id)

                return Effect.succeed(
                  PullRequestDetails.make({
                    pullRequest: { ...pull, state: closed ? 'closed' : 'open' },
                    description: 'Recovered',
                    filesChanged: Option.none(),
                    linesChanged: Option.none(),
                  }),
                )
              },
              getPullRequestStatistics: () =>
                Effect.die(new Error('Listing must not request statistics')),
              getAvatar: () => Effect.succeed(Option.none()),
              listPullRequests: ({ cursor }) => {
                pages.push(Option.isSome(cursor) ? 'more' : 'first')

                if (closed) return Effect.succeed({ items: [], next: Option.none() })

                return Effect.succeed({
                  items: [{ ...pull, id: Option.isSome(cursor) ? 'page-two' : 'page-one' }],
                  next: Option.isSome(cursor)
                    ? Option.none()
                    : Option.some(Redacted.make('next-page')),
                })
              },
            }),
          ),
      }),
    ])

    const catalog = RepositoryCatalog.of({
      list: () => Effect.succeed([watched]),
      preferences: () => Effect.succeed(defaultDashboardPreferences),
      changePreferences: () => Effect.succeed(defaultDashboardPreferences),
      add: () => Effect.void,
      remove: () => Effect.void,
      relocate: () => Effect.die(new Error('Unexpected relocation')),
    })

    return Effect.gen(function* () {
      const first = yield* dashboardPullRequestPage(
        watched,
        hosted,
        'open',
        {
          _tag: 'First',
          preferredId: 'selected',
          force: false,
        },
        () => {},
      )

      expect(first.page.items.map((item) => item.id)).toEqual(['selected', 'page-one'])
      expect(metadataRequests).toEqual(['selected'])

      const second = yield* dashboardPullRequestPage(
        watched,
        hosted,
        'open',
        {
          _tag: 'More',
          cursor: first.page.next,
          preferredId: 'selected',
        },
        () => {},
      )

      expect(second.page.items.map((item) => item.id)).toEqual(['page-two'])
      expect(Option.isNone(second.page.next)).toBe(true)
      expect(metadataRequests).toEqual(['selected'])
      expect(pages).toEqual(['first', 'more'])

      const cached = yield* dashboardPullRequestPage(
        watched,
        hosted,
        'open',
        {
          _tag: 'First',
          preferredId: 'selected',
          force: false,
        },
        () => {},
      )

      expect(cached.page.items.map((item) => item.id)).toEqual(['selected', 'page-one'])
      expect(pages).toEqual(['first', 'more'])
      expect(metadataRequests).toEqual(['selected'])
      expect(cached.revision).toBe(first.revision)
      closed = true

      const refreshed = yield* dashboardPullRequestPage(
        watched,
        hosted,
        'open',
        { _tag: 'First', preferredId: 'selected', force: true },
        () => {},
      )

      expect(refreshed.revision).toBeGreaterThan(first.revision)
      expect(refreshed.page.items).toEqual([])
      expect(Option.isNone(refreshed.page.next)).toBe(true)
      expect(pages).toEqual(['first', 'more', 'first'])
      expect(metadataRequests).toEqual(['selected', 'selected'])
    }).pipe(
      Effect.provideService(RepositoryCatalog, catalog),
      Effect.provide(DashboardData.layer.pipe(Layer.provideMerge(directory))),
    )
  },
)

it.effect(
  'cancels obsolete selection work before relocation and establishes canonical list revision provenance',
  () => {
    const canonical = HostedRepository.make({
      provider: hosted.provider,
      repository: { ...hosted.repository, key: 'renamed' },
      cloneUrl: 'https://example.test/renamed.git',
    })

    const relocated = WatchedRepository.make({
      id: 'renamed',
      name: 'renamed',
      hosting: Option.some(canonical),
      localPaths: [],
    })

    let cancelled = false
    const canonicalReads: boolean[] = []

    const directory = Layer.succeed(
      RepositoryDirectory,
      RepositoryDirectory.of({
        providers: [hosted.provider],
        recognize: () => Option.none(),
        suggest: () =>
          RepositorySource.make({
            id: 'fixture',
            providerId: 'fixture',
            scope: '',
            label: 'Fixture',
          }),
        browse: () => Effect.die(new Error('Unexpected browsing')),
        list: (repository) => {
          if (repository.repository.key === canonical.repository.key) canonicalReads.push(cancelled)

          return Effect.succeed(
            RepositoryPullRequestPage.make({
              items: [{ ...pull, target: { ...pull.target, repository: canonical.repository } }],
              next: Option.none(),
              hosting: canonical,
            }),
          )
        },
        metadata: () => Effect.die(new Error('Unexpected metadata recovery')),
        details: () => Effect.die(new Error('Unexpected combined details')),
        statistics: () => Effect.die(new Error('Unexpected statistics')),
        avatar: () => Effect.succeed(Option.none()),
        connect: () => Effect.void,
        resolve: () => Effect.die(new Error('Unexpected review resolution')),
      }),
    )

    const catalog = RepositoryCatalog.of({
      list: () => Effect.succeed([watched]),
      preferences: () => Effect.succeed(defaultDashboardPreferences),
      changePreferences: () => Effect.succeed(defaultDashboardPreferences),
      add: () => Effect.void,
      remove: () => Effect.void,
      relocate: () => Effect.succeed(relocated),
    })

    return Effect.gen(function* () {
      const data = yield* DashboardData
      yield* data.listVersioned(hosted, 'open')
      yield* data.listVersioned(hosted, 'open', true)

      const result = yield* dashboardPullRequestPage(
        watched,
        hosted,
        'open',
        { _tag: 'First', preferredId: '', force: false },
        () => {
          cancelled = true
        },
      )

      const current = yield* data.listVersioned(canonical, 'open')
      expect(result.moved).toBe(true)
      expect(result.watched).toEqual(relocated)
      expect(result.revision).toBe(current.revision)
      expect(canonicalReads).toEqual([true])
      expect(Option.isNone(yield* data.peekList(hosted, 'open'))).toBe(true)
    }).pipe(
      Effect.provideService(RepositoryCatalog, catalog),
      Effect.provide(DashboardData.layer.pipe(Layer.provideMerge(directory))),
    )
  },
)
