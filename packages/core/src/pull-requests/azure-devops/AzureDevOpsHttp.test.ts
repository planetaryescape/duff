import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AuthenticationRequired,
  ProviderUnavailable,
  RateLimited,
  RepositoryUnavailable,
} from '../GitHostingProvider'
import type { ProviderRepository, Remote } from '../GitHostingProvider'
import { ProviderAuthentication } from '../ProviderAuthentication'
import type { ProviderSession } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { makeAzureDevOpsHttp } from './AzureDevOpsHttp'

const destination = 'https://dev.azure.com/acme/Target%20Project/_git/TargetRepo'

const remote = (url: string): Remote => ({
  name: 'origin',
  destination: url,
  transport: 'https',
  credentials: { _tag: 'NotApplicable' },
})

const session = (token = 'test-token', id = 'session'): ProviderSession => ({
  id,
  token: Redacted.make(token),
  account: Option.none(),
})

const pullRequest = (id = 1) => ({
  pullRequestId: id,
  title: 'Feature',
  status: 'active',
  isDraft: true,
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
})

const fullPage = {
  count: 50,
  value: Array.from({ length: 50 }, (_, index) => pullRequest(index + 1)),
}

const first = {
  scope: 'repository',
  state: 'open',
  cursor: Option.none<Redacted.Redacted>(),
} satisfies Parameters<ProviderRepository['listPullRequests']>[0]

const make = Effect.fn('AzureDevOps.Test.make')(function* (
  auth: ProviderAuthentication['Service'] = {
    session: () => Effect.succeed(Option.some(session())),
  },
  http: ProviderHttp['Service'] = {
    get: () => Effect.succeed({ body: { count: 0, value: [] }, headers: {} }),
  },
) {
  return yield* makeAzureDevOpsHttp.pipe(
    Effect.provideService(ProviderAuthentication, auth),
    Effect.provideService(ProviderHttp, http),
  )
})

describe('AzureDevOps', () => {
  it.effect('recognizes equivalent sanitized forms without authentication or HTTP', () =>
    Effect.gen(function* () {
      let calls = 0

      const contribution = yield* make(
        {
          session: () =>
            Effect.sync(() => {
              calls++

              return Option.none()
            }),
        },
        {
          get: () =>
            Effect.sync(() => {
              calls++

              return { body: {}, headers: {} }
            }),
        },
      )

      expect(contribution.identity).toEqual({
        id: 'azure-devops',
        displayName: 'Azure DevOps',
        authenticationSource: 'azure-cli',
      })

      for (const url of [
        destination,
        'https://acme.visualstudio.com/Target%20Project/_git/TargetRepo',
        'ssh.dev.azure.com:v3/acme/Target%20Project/TargetRepo',
        'ssh://ssh.dev.azure.com/v3/acme/Target%20Project/TargetRepo',
      ]) {
        expect(Option.getOrThrow(contribution.recognizeRemote(remote(url))).identity).toEqual({
          authority: 'dev.azure.com',
          key: 'acme/target%20project/targetrepo',
          displayName: 'acme/Target Project/TargetRepo',
        })
      }

      expect(
        Option.getOrThrow(contribution.recognizeRemote(remote(`${destination}.git`))).identity.key,
      ).toBe('acme/target%20project/targetrepo.git')

      for (const url of [
        'https://evil.dev.azure.com/acme/p/_git/r',
        'http://dev.azure.com/acme/p/_git/r',
        'https://dev.azure.com/acme/p/r',
        `${destination}?token=secret`,
        'ssh://ssh.dev.azure.com/v3/acme/p/r/extra',
        'https://dev.azure.com/acme/p/_git/%2f',
        'https://dev.azure.com/acme/../_git/r',
      ]) {
        expect(Option.isNone(contribution.recognizeRemote(remote(url)))).toBe(true)
      }

      expect(calls).toBe(0)
    }),
  )

  it.effect(
    'uses the supplied silent and connect authentication and requires a session for listing',
    () =>
      Effect.gen(function* () {
        const requests: Array<readonly [string, ReadonlyArray<string>, string]> = []
        let httpCalls = 0

        const contribution = yield* make(
          {
            session: (provider, scopes, mode) =>
              Effect.sync(() => {
                requests.push([provider, scopes, mode])

                return mode === 'silent' ? Option.none() : Option.some(session())
              }),
          },
          {
            get: () =>
              Effect.sync(() => {
                httpCalls++

                return { body: {}, headers: {} }
              }),
          },
        )

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        expect(yield* repository.inspectAuthentication()).toEqual({ _tag: 'Unauthenticated' })
        expect((yield* repository.connectAuthentication())._tag).toBe('Authenticated')
        expect(yield* repository.listPullRequests(first).pipe(Effect.flip)).toBeInstanceOf(
          AuthenticationRequired,
        )
        expect(requests).toEqual(
          ['silent', 'connect', 'silent'].map((mode) => [
            'microsoft',
            ['499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'],
            mode,
          ]),
        )
        expect(httpCalls).toBe(0)
      }),
  )

  it.effect('normalizes draft, fork, missing revisions and trusted browser URLs', () =>
    Effect.gen(function* () {
      const urls: Array<string> = []

      const contribution = yield* make(undefined, {
        get: (url, token) =>
          Effect.sync(() => {
            urls.push(url)
            expect(Option.isSome(token)).toBe(true)

            return {
              headers: {},
              body: {
                count: 3,
                value: [
                  {
                    ...pullRequest(),
                    createdBy: {
                      displayName: 'Original Author',
                      uniqueName: 'private@example.test',
                    },
                    url: 'https://evil.test',
                    lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
                    lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
                    forkSource: {
                      repository: {
                        name: 'ForkRepo',
                        project: { name: 'Source Project' },
                        remoteUrl: 'https://dev.azure.com/acme/Source%20Project/_git/ForkRepo',
                      },
                    },
                  },
                  pullRequest(2),
                  { ...pullRequest(3), createdBy: null, forkSource: { repository: null } },
                ],
              },
            }
          }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      const page = yield* repository.listPullRequests(first)
      expect(urls).toEqual([
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests?searchCriteria.status=active&$top=50&$skip=0&api-version=7.1',
      ])
      expect(page.items[0]).toMatchObject({
        id: '1',
        author: 'Original Author',
        state: 'open',
        draft: true,
        url: `${destination}/pullrequest/1`,
        source: {
          _tag: 'Available',
          repository: { key: 'acme/source%20project/forkrepo' },
          ref: { name: 'refs/heads/feature', revision: Option.some('a'.repeat(40)) },
        },
        target: {
          repository: repository.identity,
          ref: { name: 'refs/heads/main', revision: Option.some('b'.repeat(40)) },
        },
      })
      expect(page.items[1]).toMatchObject({
        source: { _tag: 'Available', ref: { revision: Option.none() } },
        target: { ref: { revision: Option.none() } },
      })
      expect(page.items[2]?.source).toEqual({ _tag: 'Unavailable' })
      expect(page.items[1]?.author).toBeUndefined()
      expect(page.items[2]?.author).toBeUndefined()
      expect(Option.isNone(page.next)).toBe(true)
    }),
  )

  it.effect(
    'keeps inaccessible fork sources unavailable instead of assigning the target repository',
    () =>
      Effect.gen(function* () {
        for (const forkSource of [
          null,
          {},
          { repository: {} },
          { repository: { id: 'private' } },
          {
            repository: {
              name: 'Fork',
              project: { name: 'Other' },
              remoteUrl: 'https://untrusted.test/fork',
            },
          },
        ]) {
          const contribution = yield* make(undefined, {
            get: () =>
              Effect.succeed({
                headers: {},
                body: { count: 1, value: [{ ...pullRequest(), forkSource }] },
              }),
          })

          const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
          const page = yield* repository.listPullRequests(first)
          expect(page.items[0]?.source).toEqual({ _tag: 'Unavailable' })
          expect(page.items[0]?.target.repository).toEqual(repository.identity)
        }
      }),
  )

  it.effect(
    'paginates full then short pages and rejects unissued, cross-repository and consumed cursors',
    () =>
      Effect.gen(function* () {
        const urls: Array<string> = []

        const contribution = yield* make(undefined, {
          get: (url) =>
            Effect.sync(() => {
              urls.push(url)

              return {
                headers: { 'x-ms-continuationtoken': 'untrusted' },
                body: urls.length === 1 ? fullPage : { count: 1, value: [pullRequest(51)] },
              }
            }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const page = yield* repository.listPullRequests(first)
        expect(Option.isSome(page.next)).toBe(true)

        const other = Option.getOrThrow(
          contribution.recognizeRemote(remote('https://dev.azure.com/acme/Other/_git/OtherRepo')),
        )

        expect(
          (yield* other.listPullRequests({ ...first, cursor: page.next }).pipe(Effect.flip))._tag,
        ).toBe('InvalidContinuation')
        expect(
          (yield* repository
            .listPullRequests({ ...first, cursor: Option.some(Redacted.make('50')) })
            .pipe(Effect.flip))._tag,
        ).toBe('InvalidContinuation')
        const recognizedAgain = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))

        const last = yield* recognizedAgain.listPullRequests({
          ...first,
          cursor: page.next,
        })

        expect(last.items).toHaveLength(1)
        expect(Option.isNone(last.next)).toBe(true)
        expect(urls[1]).toContain('&$skip=50&api-version=7.1')
        expect(
          (yield* repository.listPullRequests({ ...first, cursor: page.next }).pipe(Effect.flip))
            ._tag,
        ).toBe('InvalidContinuation')
        expect(urls).toHaveLength(2)
      }),
  )

  it.effect(
    'invalidates cursors for changed sessions and replacement tokens under the same session id',
    () =>
      Effect.gen(function* () {
        let current = session()
        let calls = 0

        const contribution = yield* make(
          { session: () => Effect.sync(() => Option.some(current)) },
          {
            get: () =>
              Effect.sync(() => {
                calls++

                return { body: fullPage, headers: {} }
              }),
          },
        )

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const page = yield* repository.listPullRequests(first)

        for (const replacement of [
          session('replacement'),
          session('test-token', 'different-session'),
        ]) {
          current = replacement
          expect(
            (yield* repository.listPullRequests({ ...first, cursor: page.next }).pipe(Effect.flip))
              ._tag,
          ).toBe('InvalidContinuation')
        }

        expect(calls).toBe(1)
      }),
  )

  it.effect('honors successful Retry-After with the Effect clock and no retries', () =>
    Effect.gen(function* () {
      let calls = 0

      const contribution = yield* make(undefined, {
        get: () =>
          Effect.sync(() => {
            calls++

            return { body: { count: 0, value: [] }, headers: { 'retry-after': '10' } }
          }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      yield* repository.listPullRequests(first)
      expect(yield* repository.listPullRequests(first).pipe(Effect.flip)).toEqual(
        new RateLimited({ retryAfterSeconds: Option.some(10) }),
      )
      expect(calls).toBe(1)
      yield* TestClock.adjust('10 seconds')
      yield* repository.listPullRequests(first)
      expect(calls).toBe(2)
    }),
  )

  it.effect(
    'retains a continuation after a provider failure and applies its private cooldown',
    () =>
      Effect.gen(function* () {
        let calls = 0

        const contribution = yield* make(undefined, {
          get: () =>
            Effect.suspend(() => {
              calls++

              if (calls === 2)
                return Effect.fail(new RateLimited({ retryAfterSeconds: Option.some(5) }))

              return Effect.succeed({
                headers: {},
                body: calls === 1 ? fullPage : { count: 0, value: [] },
              })
            }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const page = yield* repository.listPullRequests(first)

        const next = { ...first, cursor: page.next } satisfies Parameters<
          typeof repository.listPullRequests
        >[0]

        expect((yield* repository.listPullRequests(next).pipe(Effect.flip))._tag).toBe(
          'RateLimited',
        )
        expect((yield* repository.listPullRequests(next).pipe(Effect.flip))._tag).toBe(
          'RateLimited',
        )
        expect(calls).toBe(2)
        yield* TestClock.adjust('5 seconds')
        expect(Option.isNone((yield* repository.listPullRequests(next)).next)).toBe(true)
        expect(calls).toBe(3)
      }),
  )

  it.effect(
    'normalizes completed and abandoned PRs, binds paging state, and preserves exact SHAs',
    () =>
      Effect.gen(function* () {
        for (const state of ['merged', 'closed'] satisfies ReadonlyArray<'merged' | 'closed'>) {
          const status = state === 'merged' ? 'completed' : 'abandoned'

          const historicalPull = {
            ...pullRequest(),
            status,
            lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
            lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
            lastMergeCommit: { commitId: 'c'.repeat(40) },
          }

          const urls: string[] = []

          const contribution = yield* make(undefined, {
            get: (url) =>
              Effect.sync(() => {
                urls.push(url)

                return {
                  headers: {},
                  body: url.includes('/pullrequests/1?')
                    ? historicalPull
                    : url.includes('$skip=0')
                      ? { count: 50, value: Array.from({ length: 50 }, () => historicalPull) }
                      : { count: 1, value: [historicalPull] },
                }
              }),
          })

          const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
          const page = yield* repository.listPullRequests({ ...first, state })
          expect(page.items).toHaveLength(50)
          expect(page.items[0]).toMatchObject({
            state,
            source: { ref: { revision: Option.some('a'.repeat(40)) } },
            target: { ref: { revision: Option.some('b'.repeat(40)) } },
          })
          expect(Option.isSome(page.next)).toBe(true)

          for (const changed of [
            'open',
            state === 'merged' ? 'closed' : 'merged',
          ] satisfies ReadonlyArray<'open' | 'merged' | 'closed'>) {
            expect(
              (yield* repository
                .listPullRequests({ ...first, state: changed, cursor: page.next })
                .pipe(Effect.flip))._tag,
            ).toBe('InvalidContinuation')
          }

          expect((yield* repository.getPullRequest('1')).state).toBe(state)
          const last = yield* repository.listPullRequests({ ...first, state, cursor: page.next })
          expect(last.items.map((item) => item.state)).toEqual([state])
          expect(Option.isNone(last.next)).toBe(true)
          expect(urls).toHaveLength(3)
          expect(urls[0]).toContain(`searchCriteria.status=${status}&$top=50&$skip=0`)
          expect(urls[1]).toBe(
            'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests/1?api-version=7.1',
          )
          expect(urls[2]).toContain(`searchCriteria.status=${status}&$top=50&$skip=50`)
        }
      }),
  )

  it.effect('rereads active PRs independently of completed list continuations', () =>
    Effect.gen(function* () {
      const contribution = yield* make(undefined, {
        get: (url) =>
          Effect.succeed({
            headers: {},
            body: url.includes('/pullrequests/1?')
              ? pullRequest()
              : url.includes('$skip=0')
                ? { count: 50, value: fullPage.value.map((pr) => ({ ...pr, status: 'completed' })) }
                : { count: 0, value: [] },
          }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      const page = yield* repository.listPullRequests({ ...first, state: 'merged' })
      expect((yield* repository.getPullRequest('1')).state).toBe('open')
      expect(
        Option.isNone(
          (yield* repository.listPullRequests({ ...first, state: 'merged', cursor: page.next }))
            .next,
        ),
      ).toBe(true)
    }),
  )

  it.effect('reads descriptions and counts all latest-iteration file pages against the base', () =>
    Effect.gen(function* () {
      const urls: string[] = []

      const contribution = yield* make(undefined, {
        get: (url) =>
          Effect.sync(() => {
            urls.push(url)

            return {
              headers: {},
              body: url.endsWith('/iterations?api-version=7.1')
                ? { value: [{ id: 3 }, { id: 1 }, { id: 2 }] }
                : url.includes('/changes?')
                  ? url.includes('$skip=0')
                    ? {
                        changeEntries: [
                          { item: { path: '/folder', isFolder: true } },
                          {
                            item: { path: '/renamed.ts' },
                            changeType: 'rename',
                            originalPath: '/old.ts',
                          },
                        ],
                        nextSkip: 2,
                        nextTop: 2000,
                      }
                    : {
                        changeEntries: [
                          { item: { path: '/deleted.ts' }, changeType: 'delete' },
                          { item: { path: '/added.ts', isFolder: false }, changeType: 'add' },
                        ],
                        nextSkip: 0,
                        nextTop: 0,
                      }
                  : {
                      ...pullRequest(),
                      description: '# Description\n\nKeep **markdown**.',
                      lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
                      lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
                    },
            }
          }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      const details = yield* repository.getPullRequestDetails('1')
      expect(details.description).toBe('# Description\n\nKeep **markdown**.')
      expect(details.filesChanged).toEqual(Option.some(3))
      expect(details.linesChanged).toEqual(Option.none())
      expect(details.pullRequest.source).toMatchObject({
        ref: { revision: Option.some('a'.repeat(40)) },
      })
      expect(details.pullRequest.target.ref.revision).toEqual(Option.some('b'.repeat(40)))
      expect(urls).toEqual([
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests/1?api-version=7.1',
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests/1/iterations?api-version=7.1',
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests/1/iterations/3/changes?$compareTo=0&$top=2000&$skip=0&api-version=7.1',
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests/1/iterations/3/changes?$compareTo=0&$top=2000&$skip=2&api-version=7.1',
      ])
    }),
  )

  it.effect('distinguishes exact zero files from unavailable or incomplete statistics', () =>
    Effect.gen(function* () {
      for (const scenario of [
        'empty',
        'iterations-fail',
        'no-iterations',
        'second-page-fail',
        'malformed-page',
        'stuck-page',
      ]) {
        const contribution = yield* make(undefined, {
          get: (url) => {
            if (url.endsWith('/iterations?api-version=7.1')) {
              if (scenario === 'iterations-fail') return Effect.fail(new RepositoryUnavailable())

              return Effect.succeed({
                headers: {},
                body: { value: scenario === 'no-iterations' ? [] : [{ id: 1 }] },
              })
            }

            if (url.includes('/changes?')) {
              if (url.includes('$skip=1')) return Effect.fail(new ProviderUnavailable())

              return Effect.succeed({
                headers: {},
                body:
                  scenario === 'malformed-page'
                    ? { changeEntries: [{ item: { path: 3 } }] }
                    : {
                        changeEntries: scenario === 'empty' ? [] : [{ item: { path: '/one.ts' } }],
                        nextSkip: scenario === 'second-page-fail' ? 1 : 0,
                        nextTop:
                          scenario === 'stuck-page' || scenario === 'second-page-fail' ? 2000 : 0,
                      },
              })
            }

            return Effect.succeed({
              headers: {},
              body: { ...pullRequest(), description: 'Still usable' },
            })
          },
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const details = yield* repository.getPullRequestDetails('1')
        expect(details.description).toBe('Still usable')
        expect(details.filesChanged).toEqual(scenario === 'empty' ? Option.some(0) : Option.none())
        expect(details.linesChanged).toEqual(Option.none())
      }
    }),
  )

  it.effect('accepts omitted terminal paging only when the requested page is not full', () =>
    Effect.gen(function* () {
      for (const count of [0, 2, 1999, 2000]) {
        const contribution = yield* make(undefined, {
          get: (url) =>
            Effect.succeed({
              headers: {},
              body: url.endsWith('/iterations?api-version=7.1')
                ? { value: [{ id: 1 }] }
                : url.includes('/changes?')
                  ? {
                      changeEntries: Array.from({ length: count }, (_, index) => ({
                        item: { path: `/file-${index}.ts` },
                      })),
                    }
                  : pullRequest(),
            }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const details = yield* repository.getPullRequestDetails('1')
        expect(details.filesChanged).toEqual(count < 2000 ? Option.some(count) : Option.none())
      }
    }),
  )

  it.effect('accepts missing descriptions and authors without inventing author metadata', () =>
    Effect.gen(function* () {
      for (const fields of [
        {},
        { createdBy: null, description: null },
        { createdBy: { displayName: 'Ada' }, description: '' },
      ]) {
        const contribution = yield* make(undefined, {
          get: () => Effect.succeed({ headers: {}, body: { ...pullRequest(), ...fields } }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const details = yield* repository.getPullRequestDetails('1')
        expect(details.description).toBe('')
        expect(details.pullRequest.authorAvatarKey).toBeUndefined()
        expect(details.filesChanged).toEqual(Option.none())
      }
    }),
  )

  it.effect(
    'prefers identity avatar links, owns opaque keys and canonicalizes legacy image links',
    () =>
      Effect.gen(function* () {
        const preferred =
          'https://dev.azure.com/acme/_apis/Identities/11111111-1111-1111-1111-111111111111/avatar'

        const legacy =
          'https://acme.visualstudio.com/_apis/Identities/22222222-2222-2222-2222-222222222222/avatar'

        const image = 'data:image/png;base64,aGVsbG8='

        for (const author of [
          { displayName: 'Ada', _links: { avatar: { href: preferred } }, imageUrl: legacy },
          { displayName: 'Ada', imageUrl: legacy },
          {
            displayName: 'Ada',
            imageUrl:
              'https://dev.azure.com/acme/_api/_common/identityImage?id=33333333-3333-3333-3333-333333333333',
          },
        ]) {
          const requests: string[] = []

          const contribution = yield* make(undefined, {
            get: (url, token, _headers, format) =>
              Effect.sync(() => {
                requests.push(url)
                expect(Option.isSome(token)).toBe(true)

                if (format === 'image') return { headers: {}, body: image }

                return {
                  headers: {},
                  body: { count: 1, value: [{ ...pullRequest(), createdBy: author }] },
                }
              }),
          })

          const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
          const page = yield* repository.listPullRequests(first)
          const key = page.items[0]?.authorAvatarKey
          expect(key).toBeDefined()

          if (key === undefined) return yield* Effect.die('Expected provider-owned avatar key')
          expect(key).not.toContain('https:')
          expect(yield* repository.getAvatar(key)).toEqual(Option.some(image))
          expect(requests[1]).toBe(
            author['_links']
              ? preferred
              : author.imageUrl.replace('acme.visualstudio.com', 'dev.azure.com/acme'),
          )
          expect(yield* repository.getAvatar(preferred)).toEqual(Option.none())

          const recognizedAgain = Option.getOrThrow(
            contribution.recognizeRemote(remote(destination)),
          )

          expect(yield* recognizedAgain.getAvatar(key)).toEqual(Option.some(image))

          const other = Option.getOrThrow(
            contribution.recognizeRemote(remote('https://dev.azure.com/other/p/_git/r')),
          )

          expect(yield* other.getAvatar(key)).toEqual(Option.none())
          expect(requests).toHaveLength(3)
        }
      }),
  )

  it.effect('never requests unsafe, cross-org, Graph or forged avatar destinations', () =>
    Effect.gen(function* () {
      const route = '/_apis/Identities/11111111-1111-1111-1111-111111111111/avatar'

      for (const url of [
        `https://evil.test/acme${route}`,
        `https://dev.azure.com.evil.test/acme${route}`,
        `https://dev.azure.com/other${route}`,
        `https://other.visualstudio.com${route}`,
        `https://dev.azure.com@evil.test/acme${route}`,
        `http://dev.azure.com/acme${route}`,
        `https://dev.azure.com/acme${route}?redirect=https://evil.test`,
        `https://dev.azure.com/acme${route}#fragment`,
        `https://dev.azure.com:443/acme${route}`,
        'https://dev.azure.com/acme/_api/_common/identityImage?id=33333333-3333-3333-3333-333333333333&redirect=https://evil.test',
        'https://dev.azure.com/other/_api/_common/identityImage?id=33333333-3333-3333-3333-333333333333',
        'https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.identity',
        'data:image/svg+xml;base64,PHN2Zz4=',
      ]) {
        const requests: string[] = []

        const contribution = yield* make(undefined, {
          get: (destination) =>
            Effect.sync(() => {
              requests.push(destination)

              return {
                headers: {},
                body: {
                  count: 1,
                  value: [
                    {
                      ...pullRequest(),
                      createdBy: {
                        displayName: 'Ada',
                        _links: { avatar: { href: url } },
                        imageUrl: url,
                      },
                    },
                  ],
                },
              }
            }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        expect(
          (yield* repository.listPullRequests(first)).items[0]?.authorAvatarKey,
        ).toBeUndefined()
        expect(yield* repository.getAvatar(url)).toEqual(Option.none())
        expect(requests).toHaveLength(1)
      }
    }),
  )

  it.effect('rejects active image content and propagates avatar transport failures', () =>
    Effect.gen(function* () {
      for (const body of [
        'data:image/svg+xml;base64,PHN2Zz4=',
        'https://evil.test/image.png',
        null,
      ]) {
        const contribution = yield* make(undefined, {
          get: (_url, _token, _headers, format) =>
            Effect.succeed({
              headers: {},
              body:
                format === 'image'
                  ? body
                  : {
                      ...pullRequest(),
                      createdBy: {
                        displayName: 'Ada',
                        imageUrl:
                          'https://dev.azure.com/acme/_apis/Identities/11111111-1111-1111-1111-111111111111/avatar',
                      },
                    },
            }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        const key = (yield* repository.getPullRequest('1')).authorAvatarKey

        if (key === undefined) return yield* Effect.die('Expected avatar key')
        expect(yield* repository.getAvatar(key)).toEqual(Option.none())
      }

      const contribution = yield* make(undefined, {
        get: (_url, _token, _headers, format) =>
          format === 'image'
            ? Effect.fail(new ProviderUnavailable())
            : Effect.succeed({
                headers: {},
                body: {
                  ...pullRequest(),
                  createdBy: {
                    imageUrl:
                      'https://dev.azure.com/acme/_apis/Identities/11111111-1111-1111-1111-111111111111/avatar',
                  },
                },
              }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      const key = (yield* repository.getPullRequest('1')).authorAvatarKey

      if (key === undefined) return yield* Effect.die('Expected avatar key')
      expect(yield* repository.getAvatar(key).pipe(Effect.flip)).toBeInstanceOf(ProviderUnavailable)
    }),
  )

  it.effect('rejects malformed provider values', () =>
    Effect.gen(function* () {
      for (const body of [
        null,
        {},
        { count: 1, value: [] },
        { count: 1, value: [{ ...pullRequest(), status: 'completed' }] },
        { count: 1, value: [{ ...pullRequest(), sourceRefName: 'feature' }] },
        { count: 1, value: [{ ...pullRequest(), lastMergeSourceCommit: { commitId: 'bad' } }] },
        { count: 1, value: [{ ...pullRequest(), isDraft: 'true' }] },
      ]) {
        const contribution = yield* make(undefined, {
          get: () => Effect.succeed({ body, headers: {} }),
        })

        const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
        expect((yield* repository.listPullRequests(first).pipe(Effect.flip))._tag).toBe(
          'InvalidProviderResponse',
        )
      }
    }),
  )

  it.effect(
    'preserves provider failures, failed sessions and interruption without anonymous fallback',
    () =>
      Effect.gen(function* () {
        for (const error of [
          new AuthenticationRequired(),
          new RepositoryUnavailable(),
          new ProviderUnavailable(),
          new RateLimited({ retryAfterSeconds: Option.some(5) }),
        ]) {
          let calls = 0

          const contribution = yield* make(undefined, {
            get: () => {
              calls++

              return Effect.fail(error)
            },
          })

          const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
          expect(yield* repository.listPullRequests(first).pipe(Effect.flip)).toEqual(error)
          expect(calls).toBe(1)
        }

        let calls = 0

        const failedAuth = yield* make(
          { session: () => Effect.fail(new ProviderUnavailable()) },
          {
            get: () => {
              calls++

              return Effect.succeed({ body: {}, headers: {} })
            },
          },
        )

        const repository = Option.getOrThrow(failedAuth.recognizeRemote(remote(destination)))
        expect(yield* repository.inspectAuthentication().pipe(Effect.flip)).toBeInstanceOf(
          ProviderUnavailable,
        )
        expect(yield* repository.listPullRequests(first).pipe(Effect.flip)).toBeInstanceOf(
          ProviderUnavailable,
        )
        expect(calls).toBe(0)
        const interrupted = yield* make(undefined, { get: () => Effect.interrupt })

        const interruptedRepository = Option.getOrThrow(
          interrupted.recognizeRemote(remote(destination)),
        )

        expect(
          Exit.hasInterrupts(
            yield* interruptedRepository.listPullRequests(first).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
  )
})
