import { expect, it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'

import { makeAzureDevOpsHttp } from '../pull-requests/azure-devops/AzureDevOpsHttp'
import { makeGitHubHttp } from '../pull-requests/github/GitHubHttp'
import { ProviderAuthentication } from '../pull-requests/ProviderAuthentication'
import { ProviderHttp } from '../pull-requests/ProviderHttp'
import { HostedRepository } from './Repositories'
import { makeRepositoryDirectoryLayer, RepositoryDirectory } from './RepositoryDirectory'

const pull = {
  number: 17,
  title: 'Fork change',
  draft: false,
  state: 'open',
  merged_at: null,
  head: { ref: 'topic', sha: 'a'.repeat(40), repo: { owner: { login: 'fork' }, name: 'source' } },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { owner: { login: 'owner' }, name: 'repo' } },
}

const session = {
  id: 'session',
  token: Redacted.make('api-secret'),
  account: Option.none(),
}

const make = Effect.fn('RepositoryDirectoryTest.make')(function* (
  http: Pick<ProviderHttp['Service'], 'get'>,
  authentication: ProviderAuthentication['Service'] = {
    session: () => Effect.succeed(Option.none()),
  },
) {
  const providers = yield* Effect.all([makeGitHubHttp, makeAzureDevOpsHttp]).pipe(
    Effect.provideService(ProviderHttp, { ...http, post: () => Effect.die('Unexpected POST') }),
    Effect.provideService(ProviderAuthentication, authentication),
  )

  return makeRepositoryDirectoryLayer(providers)
})

const recognized = Effect.fn('RepositoryDirectoryTest.recognized')(function* (
  directory: RepositoryDirectory['Service'],
  url: string = 'git@github.com:Owner/Repo.git',
) {
  const hosted = directory.recognize(url)

  if (Option.isNone(hosted)) return yield* Effect.die('Expected recognized repository')

  return hosted.value
})

it.effect(
  'recognizes and suggests sources without authentication or HTTP; rejects credential-bearing and unsafe URLs',
  () =>
    Effect.gen(function* () {
      const layer = yield* make(
        { get: () => Effect.die('Unexpected HTTP') },
        { session: () => Effect.die('Unexpected authentication') },
      )

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        expect(directory.providers.map((provider) => provider.id)).toEqual([
          'github',
          'azure-devops',
        ])
        const github = yield* recognized(directory)
        expect(github.cloneUrl).toBe('https://github.com/owner/repo.git')
        expect(directory.suggest(github)).toMatchObject({ providerId: 'github', scope: 'owner' })

        const azure = yield* recognized(
          directory,
          'https://dev.azure.com/Org/My%20Project/_git/Repo',
        )

        expect(directory.suggest(azure)).toMatchObject({
          providerId: 'azure-devops',
          scope: 'org/my project',
        })

        for (const url of [
          'https://token@github.com/owner/repo',
          'https://github.com/owner/../repo',
          'https://github.com/owner/repo?token=secret',
          'https://dev.azure.com/org/%2e%2e/_git/repo',
          'https://evil.invalid/owner/repo',
        ])
          expect(Option.isNone(directory.recognize(url))).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
)

it.effect(
  'browses public users and organizations anonymously with bound page URLs and canonical clone destinations',
  () =>
    Effect.gen(function* () {
      const urls: string[] = []

      const layer = yield* make({
        get: (url, token) => {
          urls.push(url)
          expect(Option.isNone(token)).toBe(true)

          return Effect.succeed({
            body: url.endsWith('/users/owner')
              ? { type: 'User' }
              : url.endsWith('/users/org')
                ? { type: 'Organization' }
                : [
                    {
                      owner: { login: 'Owner' },
                      name: 'Repo',
                      clone_url: 'https://evil.invalid/token',
                    },
                  ],
            headers: { link: '<https://evil.invalid/never-follow>; rel="next"' },
          })
        },
      })

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        const first = yield* directory.browse('github', 'owner', 1, 'silent')
        expect(first.items[0]?.cloneUrl).toBe('https://github.com/owner/repo.git')
        expect(first.hasMore).toBe(true)
        yield* directory.browse('github', 'org', 2, 'silent')
        expect(urls).toEqual([
          'https://api.github.com/users/owner',
          'https://api.github.com/users/owner/repos?sort=full_name&direction=asc&per_page=30&page=1',
          'https://api.github.com/users/org',
          'https://api.github.com/orgs/org/repos?sort=full_name&direction=asc&per_page=30&page=2',
        ])
        expect((yield* directory.browse('github', '', 1, 'silent').pipe(Effect.flip))._tag).toBe(
          'AuthenticationRequired',
        )
        expect(
          (yield* directory.browse('github', '../evil', 1, 'silent').pipe(Effect.flip))._tag,
        ).toBe('InvalidProviderResponse')
        expect((yield* directory.browse('github', '', 0, 'silent').pipe(Effect.flip))._tag).toBe(
          'InvalidContinuation',
        )
      }).pipe(Effect.provide(layer))
    }),
)

it.effect(
  'authenticated accessible browse passes connect mode and validates external repository payloads',
  () =>
    Effect.gen(function* () {
      const modes: string[] = []

      const layer = yield* make(
        {
          get: (url, token) => {
            expect(url).toBe(
              'https://api.github.com/user/repos?sort=full_name&direction=asc&per_page=30&page=1',
            )
            expect(Option.isSome(token)).toBe(true)

            return Effect.succeed({
              body: [{ owner: { login: 'owner' }, name: '../bad' }],
              headers: {},
            })
          },
        },
        {
          session: (_provider, _scopes, mode) => {
            modes.push(mode)

            return Effect.succeed(Option.some(session))
          },
        },
      )

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        expect((yield* directory.browse('github', '', 1, 'connect').pipe(Effect.flip))._tag).toBe(
          'InvalidProviderResponse',
        )
        expect(modes).toEqual(['connect'])
      }).pipe(Effect.provide(layer))
    }),
)

it.effect(
  'Azure browses org or org/project using existing authentication and pages the documented unpaged collection',
  () =>
    Effect.gen(function* () {
      const urls: string[] = []

      const layer = yield* make(
        {
          get: (url, token) => {
            urls.push(url)
            expect(Option.isSome(token)).toBe(true)

            return Effect.succeed({
              body: {
                count: 51,
                value: Array.from({ length: 51 }, (_, index) => ({
                  name: `repo-${String(index).padStart(2, '0')}`,
                  project: { name: 'My Project' },
                  remoteUrl: 'https://evil.invalid',
                })),
              },
              headers: {},
            })
          },
        },
        {
          session: (provider) => {
            expect(provider).toBe('microsoft')

            return Effect.succeed(Option.some(session))
          },
        },
      )

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        const first = yield* directory.browse('azure-devops', 'org', 1, 'silent')
        const second = yield* directory.browse('azure-devops', 'org/My Project', 2, 'connect')
        expect(first.items.length).toBe(50)
        expect(first.hasMore).toBe(true)
        expect(second.items.length).toBe(1)
        expect(second.hasMore).toBe(false)
        expect(second.items[0]?.cloneUrl).toBe(
          'https://dev.azure.com/org/My%20Project/_git/repo-50',
        )
        expect(urls).toEqual([
          'https://dev.azure.com/org/_apis/git/repositories?api-version=7.1',
          'https://dev.azure.com/org/My%20Project/_apis/git/repositories?api-version=7.1',
        ])
      }).pipe(Effect.provide(layer))
    }),
)

it.effect(
  'lists through bound adapters, preserves state/cursor binding, and resolves forks to separate token-free exact destinations',
  () =>
    Effect.gen(function* () {
      const layer = yield* make({
        get: (url) =>
          Effect.succeed({
            body: url.includes('/pulls/17') ? pull : [pull],
            headers: url.includes('page=1')
              ? {
                  link: '<https://api.github.com/repos/owner/repo/pulls?state=open&sort=created&direction=desc&per_page=30&page=2>; rel="next"',
                }
              : { link: '' },
          }),
      })

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        const hosted = yield* recognized(directory)
        const page = yield* directory.list(hosted, 'open', Option.none())
        expect(page.items.length).toBe(1)
        expect(Option.isSome(page.next)).toBe(true)
        expect((yield* directory.list(hosted, 'closed', page.next).pipe(Effect.flip))._tag).toBe(
          'InvalidContinuation',
        )
        const resolved = yield* directory.resolve(hosted, '17')
        expect(resolved.revisions.source.commit).toBe('a'.repeat(40))
        expect(resolved.revisions.target.commit).toBe('b'.repeat(40))
        expect(resolved.revisions.source.remote).toEqual(
          Option.some({ name: 'duff-source', destination: 'https://github.com/fork/source.git' }),
        )
        expect(resolved.revisions.target.remote).toEqual(
          Option.some({ name: 'duff-target', destination: 'https://github.com/owner/repo.git' }),
        )

        const forged = HostedRepository.make({
          provider: hosted.provider,
          repository: hosted.repository,
          cloneUrl: 'https://github.com/other/repo.git',
        })

        expect((yield* directory.resolve(forged, '17').pipe(Effect.flip))._tag).toBe(
          'RepositoryUnavailable',
        )
        expect((yield* directory.connect(hosted).pipe(Effect.flip))._tag).toBe(
          'AuthenticationRequired',
        )
      }).pipe(Effect.provide(layer))
    }),
)

it.effect('explicitly fails unavailable fork sources rather than replacing revisions', () =>
  Effect.gen(function* () {
    const layer = yield* make({
      get: () =>
        Effect.succeed({ body: { ...pull, head: { ...pull.head, repo: null } }, headers: {} }),
    })

    yield* Effect.gen(function* () {
      const directory = yield* RepositoryDirectory
      const hosted = yield* recognized(directory)
      expect((yield* directory.resolve(hosted, '17').pipe(Effect.flip))._tag).toBe('ReviewError')
    }).pipe(Effect.provide(layer))
  }),
)

it.effect(
  'Azure resolves exact fork revisions with independent transports and fails missing commit details',
  () =>
    Effect.gen(function* () {
      let missingRevision = false

      const layer = yield* make(
        {
          get: () =>
            Effect.succeed({
              body: {
                pullRequestId: 17,
                title: 'Azure fork',
                status: 'active',
                sourceRefName: 'refs/heads/topic',
                targetRefName: 'refs/heads/main',
                lastMergeSourceCommit: missingRevision ? null : { commitId: 'a'.repeat(40) },
                lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
                forkSource: {
                  repository: {
                    name: 'Fork',
                    project: { name: 'Other Project' },
                    remoteUrl: 'https://dev.azure.com/other-org/Other%20Project/_git/Fork',
                  },
                },
              },
              headers: {},
            }),
        },
        { session: () => Effect.succeed(Option.some(session)) },
      )

      yield* Effect.gen(function* () {
        const directory = yield* RepositoryDirectory
        const hosted = yield* recognized(directory, 'https://dev.azure.com/org/project/_git/repo')
        yield* directory.connect(hosted)
        const resolved = yield* directory.resolve(hosted, '17')
        expect(resolved.revisions.source.remote).toEqual(
          Option.some({
            name: 'duff-source',
            destination: 'https://dev.azure.com/other-org/other%20project/_git/fork',
          }),
        )
        expect(resolved.revisions.target.remote).toEqual(
          Option.some({
            name: 'duff-target',
            destination: 'https://dev.azure.com/org/project/_git/repo',
          }),
        )
        missingRevision = true
        expect((yield* directory.resolve(hosted, '17').pipe(Effect.flip))._tag).toBe('ReviewError')
      }).pipe(Effect.provide(layer))
    }),
)

it.effect('Azure browse rejects invalid count, path traversal and absent authentication', () =>
  Effect.gen(function* () {
    const layer = yield* make(
      {
        get: () =>
          Effect.succeed({
            body: { count: 2, value: [] },
            headers: {},
          }),
      },
      { session: () => Effect.succeed(Option.some(session)) },
    )

    yield* Effect.gen(function* () {
      const directory = yield* RepositoryDirectory
      expect(
        (yield* directory.browse('azure-devops', 'org', 1, 'silent').pipe(Effect.flip))._tag,
      ).toBe('InvalidProviderResponse')
      expect(
        (yield* directory.browse('azure-devops', 'org/..', 1, 'silent').pipe(Effect.flip))._tag,
      ).toBe('InvalidProviderResponse')
    }).pipe(Effect.provide(layer))

    const anonymous = yield* make({ get: () => Effect.die('Unexpected HTTP') })
    yield* Effect.gen(function* () {
      const directory = yield* RepositoryDirectory
      expect(
        (yield* directory.browse('azure-devops', 'org', 1, 'silent').pipe(Effect.flip))._tag,
      ).toBe('AuthenticationRequired')
    }).pipe(Effect.provide(anonymous))
  }),
)
