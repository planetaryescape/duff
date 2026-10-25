import { expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Option, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AuthenticationRequired,
  OpenPullRequest,
  ProviderUnavailable,
  RateLimited,
  RepositoryUnavailable,
  type ProviderRepository,
  type Remote,
} from '../GitHostingProvider'
import { ProviderAuthentication, type ProviderSession } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { makeGitHubHttp } from './GitHubHttp'

const remote = (destination: string): Remote => ({
  name: 'origin',
  destination,
  transport: 'ssh',
  credentials: { _tag: 'NotApplicable' },
})

const request = {
  scope: 'repository',
  state: 'open',
  cursor: Option.none<Redacted.Redacted>(),
} satisfies Parameters<ProviderRepository['listPullRequests']>[0]

const session = (token = 'test-token', id = 'session'): ProviderSession => ({
  id,
  token: Redacted.make(token),
  account: Option.some({ id: 'account', displayName: 'Test account' }),
})

const url = (page: number) =>
  `https://api.github.com/repos/owner/repo/pulls?state=open&sort=created&direction=desc&per_page=30&page=${page}`

const pull = {
  number: 17,
  title: 'A pull request',
  user: { login: 'original-author' },
  draft: true,
  state: 'open',
  merged_at: null,
  html_url: 'https://evil.invalid/untrusted',
  head: {
    ref: 'feature/topic',
    sha: 'a'.repeat(40),
    repo: { owner: { login: 'fork-owner' }, name: 'fork-repo' },
  },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { owner: { login: 'owner' }, name: 'repo' } },
}

const make = Effect.fn('GitHubTest.make')(function* (
  auth: ProviderAuthentication['Service'] = { session: () => Effect.succeed(Option.none()) },
  http: ProviderHttp['Service'] = { get: () => Effect.succeed({ body: [], headers: {} }) },
) {
  const provider = yield* makeGitHubHttp.pipe(
    Effect.provideService(ProviderAuthentication, ProviderAuthentication.of(auth)),
    Effect.provideService(ProviderHttp, ProviderHttp.of(http)),
  )

  const repository = provider.recognizeRemote(remote('https://github.com/owner/repo.git'))

  if (Option.isNone(repository)) return yield* Effect.die('Missing repository')

  return { provider, repository: repository.value }
})

it.effect('construction and remote recognition do not authenticate or call HTTP', () =>
  Effect.gen(function* () {
    const { provider } = yield* make(
      { session: () => Effect.die('Unexpected authentication') },
      { get: () => Effect.die('Unexpected HTTP') },
    )

    expect(provider.identity).toEqual({
      id: 'github',
      displayName: 'GitHub',
      authenticationSource: 'github',
    })

    for (const destination of [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git/',
      'ssh://github.com/owner/repo.git',
      'ssh://git@github.com/owner/repo',
      'git@github.com:owner/repo.git',
      'github.com:owner/repo',
      'https://GITHUB.COM/owner/repo',
    ]) {
      const recognized = provider.recognizeRemote(remote(destination))
      expect(Option.isSome(recognized)).toBe(true)

      if (Option.isSome(recognized)) expect(recognized.value.identity.key).toBe('owner/repo')
    }

    for (const destination of [
      'http://github.com/owner/repo',
      'https://github.enterprise/owner/repo',
      'https://github.com.evil/owner/repo',
      'https://user:secret@github.com/owner/repo',
      'https://github.com/owner/repo?secret=x',
      'https://github.com/owner/repo#x',
      'https://github.com/owner/repo/extra',
      'https://github.com/owner/%72epo',
      'https://github.com/owner/..',
      'ssh://github.com:22/owner/repo',
      'file:///owner/repo',
    ]) {
      expect(Option.isNone(provider.recognizeRemote(remote(destination)))).toBe(true)
    }
  }),
)

it.effect('reports only actual sessions and explicitly requests connect', () =>
  Effect.gen(function* () {
    let active = Option.none<ProviderSession>()
    const modes: string[] = []

    const { repository } = yield* make({
      session: (provider, scopes, mode) =>
        Effect.sync(() => {
          expect(provider).toBe('github')
          expect(scopes).toEqual(['repo'])
          modes.push(mode)

          return active
        }),
    })

    expect(yield* repository.inspectAuthentication()).toEqual({ _tag: 'Unauthenticated' })
    active = Option.some(session())
    expect(yield* repository.connectAuthentication()).toEqual({
      _tag: 'Authenticated',
      account: session().account,
      source: 'editor',
    })
    expect(modes).toEqual(['silent', 'connect'])
  }),
)

it.effect('normalizes drafts, fork identities, full refs and revisions, and deleted sources', () =>
  Effect.gen(function* () {
    const { repository } = yield* make(undefined, {
      get: (actualUrl, token, headers) =>
        Effect.sync(() => {
          expect(actualUrl).toBe(url(1))
          expect(Option.isNone(token)).toBe(true)
          expect(headers).toEqual({
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'Duff',
          })

          return {
            body: [pull, { ...pull, number: 18, user: null, head: { ...pull.head, repo: null } }],
            headers: {},
          }
        }),
    })

    const page = yield* repository.listPullRequests(request)
    expect(page.items[0]).toEqual({
      id: '17',
      title: pull.title,
      author: 'original-author',
      draft: true,
      state: 'open',
      url: 'https://github.com/owner/repo/pull/17',
      source: {
        _tag: 'Available',
        repository: {
          authority: 'github.com',
          key: 'fork-owner/fork-repo',
          displayName: 'fork-owner/fork-repo',
        },
        ref: { name: 'refs/heads/feature/topic', revision: Option.some('a'.repeat(40)) },
      },
      target: {
        repository: repository.identity,
        ref: { name: 'refs/heads/main', revision: Option.some('b'.repeat(40)) },
      },
    })
    expect(page.items[1]?.source).toEqual({ _tag: 'Unavailable' })
    expect(page.items[1]?.author).toBeUndefined()
    expect(Option.isNone(page.next)).toBe(true)
  }),
)

it.effect('continues decoding saved pull requests without state and rejects unknown states', () =>
  Effect.gen(function* () {
    const legacy = {
      id: '17',
      title: 'Saved review',
      url: 'https://github.com/owner/repo/pull/17',
      draft: false,
      source: { _tag: 'Unavailable' },
      target: {
        repository: { authority: 'github.com', key: 'owner/repo', displayName: 'owner/repo' },
        ref: { name: 'refs/heads/main', revision: Option.some(pull.base.sha) },
      },
    }

    expect(yield* Schema.decodeUnknownEffect(OpenPullRequest)(legacy)).toEqual(legacy)
    expect(Schema.decodeUnknownOption(OpenPullRequest)({ ...legacy, state: 'active' })).toEqual(
      Option.none(),
    )
  }),
)

it.effect('rejects malformed provider data and inconsistent targets', () =>
  Effect.gen(function* () {
    for (const body of [
      { items: [] },
      [null],
      [{ ...pull, number: 0 }],
      [{ ...pull, draft: 'true' }],
      [{ ...pull, state: 'unknown' }],
      [{ ...pull, merged_at: 123 }],
      [{ ...pull, merged_at: '2026-10-01T00:00:00Z' }],
      [{ ...pull, head: { ...pull.head, sha: 'bad' } }],
      [{ ...pull, base: { ...pull.base, repo: null } }],
      [{ ...pull, base: { ...pull.base, repo: { owner: { login: 'other' }, name: 'repo' } } }],
    ]) {
      const { repository } = yield* make(undefined, {
        get: () => Effect.succeed({ body, headers: {} }),
      })

      expect((yield* repository.listPullRequests(request).pipe(Effect.flip))._tag).toBe(
        'InvalidProviderResponse',
      )
    }
  }),
)

it.effect('continues with rebuilt URLs and refuses other repositories or replaced sessions', () =>
  Effect.gen(function* () {
    let active = Option.some(session())
    const requests: string[] = []

    const { provider, repository } = yield* make(
      { session: () => Effect.sync(() => active) },
      {
        get: (actualUrl, token) =>
          Effect.sync(() => {
            requests.push(actualUrl)
            expect(Option.isSome(token)).toBe(true)

            if (Option.isSome(token)) expect(Redacted.value(token.value)).toBe('test-token')

            const headers: Readonly<Record<string, string>> =
              actualUrl === url(1)
                ? { link: `<${url(2)}>; rel="next", <${url(3)}>; rel="last"` }
                : actualUrl === url(2)
                  ? { link: `<${url(3)}>; rel="next"` }
                  : {}

            return { body: [pull], headers }
          }),
      },
    )

    const first = yield* repository.listPullRequests(request)
    expect(Option.isSome(first.next)).toBe(true)
    const second = yield* repository.listPullRequests({ ...request, cursor: first.next })
    const third = yield* repository.listPullRequests({ ...request, cursor: second.next })
    expect(Option.isNone(third.next)).toBe(true)
    expect(requests).toEqual([url(1), url(2), url(3)])
    const other = provider.recognizeRemote(remote('github.com:other/repo'))

    if (Option.isSome(other))
      expect(
        (yield* other.value.listPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))
          ._tag,
      ).toBe('InvalidContinuation')

    for (const replacement of [
      Option.some(session('new-token')),
      Option.some(session('test-token', 'new-session')),
      Option.none<ProviderSession>(),
    ]) {
      active = replacement
      expect(
        (yield* repository.listPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))
          ._tag,
      ).toBe('InvalidContinuation')
    }

    expect(requests).toHaveLength(3)
    expect(
      (yield* repository
        .listPullRequests({ ...request, cursor: Option.some(Redacted.make('unissued')) })
        .pipe(Effect.flip))._tag,
    ).toBe('InvalidContinuation')
  }),
)

it.effect('accepts GitHub numeric repository page links only for the response repository', () =>
  Effect.gen(function* () {
    const numeric = (id: number) => url(2).replace('/repos/owner/repo/', `/repositories/${id}/`)
    const body = [{ ...pull, base: { ...pull.base, repo: { ...pull.base.repo, id: 42 } } }]
    const requests: string[] = []

    const { repository } = yield* make(undefined, {
      get: (actual) => {
        requests.push(actual)

        const headers: Readonly<Record<string, string>> =
          actual === url(1) ? { link: `<${numeric(42)}>; rel="next"` } : {}

        return Effect.succeed({ body, headers })
      },
    })

    const first = yield* repository.listPullRequests(request)
    expect(Option.isSome(first.next)).toBe(true)
    const second = yield* repository.listPullRequests({ ...request, cursor: first.next })
    expect(second.items.map((pr) => pr.id)).toEqual(['17'])
    expect(requests).toEqual([url(1), url(2)])

    const wrong = yield* make(undefined, {
      get: () => Effect.succeed({ body, headers: { link: `<${numeric(43)}>; rel="next"` } }),
    })

    expect((yield* wrong.repository.listPullRequests(request).pipe(Effect.flip))._tag).toBe(
      'InvalidProviderResponse',
    )
  }),
)

it.effect('rejects unsafe, repeated, backwards and query-changing next links', () =>
  Effect.gen(function* () {
    for (const next of [
      url(1),
      url(0),
      url(2).replace('api.github.com', 'evil.invalid'),
      url(2).replace('owner/repo', 'other/repo'),
      url(2).replace('state=open', 'state=closed'),
      `${url(2)}&extra=x`,
      `${url(2)}#fragment`,
      url(2).replace('https://', 'https://user:secret@'),
      `${url(2)}&page=3`,
    ]) {
      const { repository } = yield* make(undefined, {
        get: () => Effect.succeed({ body: [], headers: { link: `<${next}>; rel="next"` } }),
      })

      expect((yield* repository.listPullRequests(request).pipe(Effect.flip))._tag).toBe(
        'InvalidProviderResponse',
      )
    }

    for (const link of ['malformed', `<${url(2)}>; rel="next", <${url(3)}>; rel="next"`]) {
      const { repository } = yield* make(undefined, {
        get: () => Effect.succeed({ body: [], headers: { link } }),
      })

      expect((yield* repository.listPullRequests(request).pipe(Effect.flip))._tag).toBe(
        'InvalidProviderResponse',
      )
    }

    const { repository } = yield* make(undefined, {
      get: (actualUrl) =>
        Effect.succeed({
          body: [],
          headers: { link: `<${actualUrl === url(1) ? url(2) : url(1)}>; rel="next"` },
        }),
    })

    const first = yield* repository.listPullRequests(request)
    expect(
      (yield* repository.listPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))
        ._tag,
    ).toBe('InvalidProviderResponse')
  }),
)

it.effect(
  'requests sign-in for anonymous inaccessible repositories and succeeds after connection',
  () =>
    Effect.gen(function* () {
      let active = Option.none<ProviderSession>()

      const { repository } = yield* make(
        {
          session: (_provider, _scopes, mode) =>
            Effect.sync(() => {
              if (mode === 'connect') active = Option.some(session())

              return active
            }),
        },
        {
          get: (requestedUrl, token) =>
            Option.isNone(token)
              ? Effect.fail(new RepositoryUnavailable())
              : Effect.succeed({
                  body: requestedUrl === url(1) ? [pull] : pull,
                  headers: {},
                }),
        },
      )

      expect(yield* repository.listPullRequests(request).pipe(Effect.flip)).toEqual(
        new AuthenticationRequired(),
      )
      expect(yield* repository.getPullRequest('17').pipe(Effect.flip)).toEqual(
        new AuthenticationRequired(),
      )
      expect(yield* repository.inspectAuthentication()).toEqual({ _tag: 'Unauthenticated' })

      yield* repository.connectAuthentication()
      expect((yield* repository.listPullRequests(request)).items.map((item) => item.id)).toEqual([
        '17',
      ])
      expect((yield* repository.getPullRequest('17')).id).toBe('17')
    }),
)

it.effect('propagates HTTP and authentication failures without anonymous fallback or retries', () =>
  Effect.gen(function* () {
    for (const error of [
      new AuthenticationRequired(),
      new RepositoryUnavailable(),
      new ProviderUnavailable(),
      new RateLimited({ retryAfterSeconds: Option.none() }),
    ]) {
      let calls = 0

      const { repository } = yield* make(
        { session: () => Effect.succeed(Option.some(session())) },
        {
          get: () =>
            Effect.sync(() => {
              calls++
            }).pipe(Effect.andThen(Effect.fail(error))),
        },
      )

      expect(yield* repository.listPullRequests(request).pipe(Effect.flip)).toEqual(error)
      expect(calls).toBe(1)
    }

    const { repository } = yield* make(
      { session: () => Effect.fail(new ProviderUnavailable()) },
      { get: () => Effect.die('Anonymous fallback') },
    )

    expect((yield* repository.inspectAuthentication().pipe(Effect.flip))._tag).toBe(
      'ProviderUnavailable',
    )
    expect((yield* repository.connectAuthentication().pipe(Effect.flip))._tag).toBe(
      'ProviderUnavailable',
    )
    expect((yield* repository.listPullRequests(request).pipe(Effect.flip))._tag).toBe(
      'ProviderUnavailable',
    )
  }),
)

it.effect(
  'honors successful Retry-After and failed rate-limit cooldown using the supplied clock',
  () =>
    Effect.gen(function* () {
      for (const failed of [false, true]) {
        let calls = 0

        const { repository } = yield* make(undefined, {
          get: () => {
            calls++

            return failed
              ? Effect.fail(new RateLimited({ retryAfterSeconds: Option.some(10) }))
              : Effect.succeed({ body: [], headers: { 'retry-after': '10' } })
          },
        })

        yield* repository.listPullRequests(request).pipe(Effect.result)
        const error = yield* repository.listPullRequests(request).pipe(Effect.flip)
        expect(error._tag).toBe('RateLimited')
        expect(calls).toBe(1)
        yield* TestClock.adjust('10 seconds')
        yield* repository.listPullRequests(request).pipe(Effect.result)
        expect(calls).toBe(2)
      }
    }),
)

it.effect('uses the test clock for HTTP-date Retry-After and ignores malformed delays', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    let calls = 0

    const { repository } = yield* make(undefined, {
      get: () =>
        Effect.sync(() => {
          calls++

          return {
            body: [],
            headers: { 'retry-after': calls === 1 ? 'Thu, 01 Jan 1970 00:00:10 GMT' : 'invalid' },
          }
        }),
    })

    yield* repository.listPullRequests(request)
    expect(yield* repository.listPullRequests(request).pipe(Effect.flip)).toEqual(
      new RateLimited({ retryAfterSeconds: Option.some(10) }),
    )
    expect(calls).toBe(1)
    yield* TestClock.adjust('10 seconds')
    yield* repository.listPullRequests(request)
    yield* repository.listPullRequests(request)
    expect(calls).toBe(3)
  }),
)

it.effect('separates merged and closed results while retaining exact source and target SHAs', () =>
  Effect.gen(function* () {
    const merged = {
      ...pull,
      state: 'closed',
      merged_at: '2026-10-01T00:00:00Z',
      merge_commit_sha: 'c'.repeat(40),
    }

    const closed = { ...pull, number: 18, state: 'closed' }
    const requests: string[] = []

    const { repository } = yield* make(undefined, {
      get: (actualUrl) =>
        Effect.sync(() => {
          requests.push(actualUrl)

          return { body: [merged, closed], headers: {} }
        }),
    })

    for (const state of ['merged', 'closed'] satisfies ReadonlyArray<'merged' | 'closed'>) {
      const page = yield* repository.listPullRequests({ ...request, state })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        id: state === 'merged' ? '17' : '18',
        state,
        source: { ref: { revision: Option.some(pull.head.sha) } },
        target: { ref: { revision: Option.some(pull.base.sha) } },
      })
    }

    expect(requests).toEqual([
      url(1).replace('state=open', 'state=closed'),
      url(1).replace('state=open', 'state=closed'),
    ])
  }),
)

it.effect('continues empty filtered pages and binds cursors to the selected historical state', () =>
  Effect.gen(function* () {
    for (const state of ['merged', 'closed'] satisfies ReadonlyArray<'merged' | 'closed'>) {
      const requests: string[] = []
      const historicalUrl = (page: number) => url(page).replace('state=open', 'state=closed')

      const { repository } = yield* make(undefined, {
        get: (actualUrl) =>
          Effect.sync(() => {
            requests.push(actualUrl)
            const selected = actualUrl === historicalUrl(2)
            const merged = state === 'merged' ? selected : !selected

            const headers: Readonly<Record<string, string>> = selected
              ? {}
              : { link: `<${historicalUrl(2)}>; rel="next"` }

            return {
              body: [
                { ...pull, state: 'closed', merged_at: merged ? '2026-10-01T00:00:00Z' : null },
              ],
              headers,
            }
          }),
      })

      const firstPage = yield* repository.listPullRequests({ ...request, state })
      expect(firstPage.items).toEqual([])
      expect(Option.isSome(firstPage.next)).toBe(true)

      for (const changed of [
        'open',
        state === 'merged' ? 'closed' : 'merged',
      ] satisfies ReadonlyArray<'open' | 'merged' | 'closed'>) {
        expect(
          (yield* repository
            .listPullRequests({ ...request, state: changed, cursor: firstPage.next })
            .pipe(Effect.flip))._tag,
        ).toBe('InvalidContinuation')
      }

      const second = yield* repository.listPullRequests({
        ...request,
        state,
        cursor: firstPage.next,
      })

      expect(second.items.map((item) => item.state)).toEqual([state])
      expect(Option.isNone(second.next)).toBe(true)
      expect(requests).toEqual([historicalUrl(1), historicalUrl(2)])
    }
  }),
)

it.effect('rejects historical next links with an open API query', () =>
  Effect.gen(function* () {
    const { repository } = yield* make(undefined, {
      get: () => Effect.succeed({ body: [], headers: { link: `<${url(2)}>; rel="next"` } }),
    })

    for (const state of ['merged', 'closed'] satisfies ReadonlyArray<'merged' | 'closed'>) {
      expect(
        (yield* repository.listPullRequests({ ...request, state }).pipe(Effect.flip))._tag,
      ).toBe('InvalidProviderResponse')
    }
  }),
)

it.effect('rereads any state by id without following list pagination or changing its cursor', () =>
  Effect.gen(function* () {
    let state: 'open' | 'merged' | 'closed' = 'open'
    const requests: string[] = []

    const { repository } = yield* make(undefined, {
      get: (actualUrl) =>
        Effect.sync(() => {
          requests.push(actualUrl)

          const body = {
            ...pull,
            state: state === 'open' ? 'open' : 'closed',
            merged_at: state === 'merged' ? '2026-10-01T00:00:00Z' : null,
          }

          const headers: Readonly<Record<string, string>> =
            actualUrl === url(2) ? {} : { link: 'not a valid pagination link' }

          return {
            body: actualUrl.includes('?') ? [pull] : body,
            headers: actualUrl === url(1) ? { link: `<${url(2)}>; rel="next"` } : headers,
          }
        }),
    })

    const page = yield* repository.listPullRequests(request)

    for (const selected of ['open', 'merged', 'closed'] satisfies ReadonlyArray<
      'open' | 'merged' | 'closed'
    >) {
      state = selected
      expect((yield* repository.getPullRequest('17')).state).toBe(selected)
    }

    yield* repository.listPullRequests({ ...request, cursor: page.next })
    expect(requests).toEqual([
      url(1),
      ...Array.from({ length: 3 }, () => 'https://api.github.com/repos/owner/repo/pulls/17'),
      url(2),
    ])
  }),
)

it.effect('preserves interruption and transport cleanup', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let cleaned = false

    const { repository } = yield* make(undefined, {
      get: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned = true
            }),
          ),
        ),
    })

    const fiber = yield* repository.listPullRequests(request).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    expect(cleaned).toBe(true)
  }),
)
