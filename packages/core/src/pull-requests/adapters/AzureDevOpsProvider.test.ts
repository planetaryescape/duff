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
import { makeAzureDevOpsProvider } from './AzureDevOpsProvider'
import { ProviderHttp } from './ProviderHttp'

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
  account: { id: 'account', displayName: 'Test' },
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
  cursor: Option.none<Redacted.Redacted>(),
} satisfies Parameters<ProviderRepository['listOpenPullRequests']>[0]

const make = Effect.fn('AzureDevOps.Test.make')(function* (
  auth: ProviderAuthentication['Service'] = {
    session: () => Effect.succeed(Option.some(session())),
  },
  http: ProviderHttp['Service'] = {
    get: () => Effect.succeed({ body: { count: 0, value: [] }, headers: {} }),
  },
) {
  return yield* makeAzureDevOpsProvider.pipe(
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

      expect(contribution.identity).toEqual({ id: 'azure-devops', displayName: 'Azure DevOps' })

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
    'uses native silent and connect authentication and requires a session for listing',
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
        expect(yield* repository.listOpenPullRequests(first).pipe(Effect.flip)).toBeInstanceOf(
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
                  { ...pullRequest(3), forkSource: { repository: null } },
                ],
              },
            }
          }),
      })

      const repository = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))
      const page = yield* repository.listOpenPullRequests(first)
      expect(urls).toEqual([
        'https://dev.azure.com/acme/Target%20Project/_apis/git/repositories/TargetRepo/pullrequests?searchCriteria.status=active&$top=50&$skip=0&api-version=7.1',
      ])
      expect(page.items[0]).toMatchObject({
        id: '1',
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
          const page = yield* repository.listOpenPullRequests(first)
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
        const page = yield* repository.listOpenPullRequests(first)
        expect(Option.isSome(page.next)).toBe(true)

        const other = Option.getOrThrow(
          contribution.recognizeRemote(remote('https://dev.azure.com/acme/Other/_git/OtherRepo')),
        )

        expect(
          (yield* other
            .listOpenPullRequests({ scope: 'repository', cursor: page.next })
            .pipe(Effect.flip))._tag,
        ).toBe('InvalidContinuation')
        expect(
          (yield* repository
            .listOpenPullRequests({ scope: 'repository', cursor: Option.some(Redacted.make('50')) })
            .pipe(Effect.flip))._tag,
        ).toBe('InvalidContinuation')
        const recognizedAgain = Option.getOrThrow(contribution.recognizeRemote(remote(destination)))

        const last = yield* recognizedAgain.listOpenPullRequests({
          scope: 'repository',
          cursor: page.next,
        })

        expect(last.items).toHaveLength(1)
        expect(Option.isNone(last.next)).toBe(true)
        expect(urls[1]).toContain('&$skip=50&api-version=7.1')
        expect(
          (yield* repository
            .listOpenPullRequests({ scope: 'repository', cursor: page.next })
            .pipe(Effect.flip))._tag,
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
        const page = yield* repository.listOpenPullRequests(first)

        for (const replacement of [
          session('replacement'),
          session('test-token', 'different-session'),
        ]) {
          current = replacement
          expect(
            (yield* repository
              .listOpenPullRequests({ scope: 'repository', cursor: page.next })
              .pipe(Effect.flip))._tag,
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
      yield* repository.listOpenPullRequests(first)
      expect(yield* repository.listOpenPullRequests(first).pipe(Effect.flip)).toEqual(
        new RateLimited({ retryAfterSeconds: Option.some(10) }),
      )
      expect(calls).toBe(1)
      yield* TestClock.adjust('10 seconds')
      yield* repository.listOpenPullRequests(first)
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
        const page = yield* repository.listOpenPullRequests(first)

        const next = { scope: 'repository', cursor: page.next } satisfies Parameters<
          typeof repository.listOpenPullRequests
        >[0]

        expect((yield* repository.listOpenPullRequests(next).pipe(Effect.flip))._tag).toBe(
          'RateLimited',
        )
        expect((yield* repository.listOpenPullRequests(next).pipe(Effect.flip))._tag).toBe(
          'RateLimited',
        )
        expect(calls).toBe(2)
        yield* TestClock.adjust('5 seconds')
        expect(Option.isNone((yield* repository.listOpenPullRequests(next)).next)).toBe(true)
        expect(calls).toBe(3)
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
        expect((yield* repository.listOpenPullRequests(first).pipe(Effect.flip))._tag).toBe(
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
          expect(yield* repository.listOpenPullRequests(first).pipe(Effect.flip)).toEqual(error)
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
        expect(yield* repository.listOpenPullRequests(first).pipe(Effect.flip)).toBeInstanceOf(
          ProviderUnavailable,
        )
        expect(calls).toBe(0)
        const interrupted = yield* make(undefined, { get: () => Effect.interrupt })

        const interruptedRepository = Option.getOrThrow(
          interrupted.recognizeRemote(remote(destination)),
        )

        expect(
          Exit.hasInterrupts(
            yield* interruptedRepository.listOpenPullRequests(first).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
  )
})
