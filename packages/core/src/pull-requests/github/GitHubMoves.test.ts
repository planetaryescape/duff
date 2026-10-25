import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { RepositoryDirectory } from '../../dashboard/RepositoryDirectory'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { pullRequestsLayer } from '../Providers'

const authentication = Layer.succeed(ProviderAuthentication, {
  session: () =>
    Effect.succeed(
      Option.some({
        id: 'fixture',
        token: Redacted.make('fixture-token'),
        account: Option.none(),
      }),
    ),
})

const list = RepositoryDirectory.use((directory) => {
  const hosted = directory.recognize('https://github.com/old/repo.git')

  if (Option.isNone(hosted)) return Effect.die('Expected recognized repository')

  return directory.list(hosted.value, 'open', Option.none())
})

it.effect('recovers a moved repository with no PRs through validated GitHub metadata', () => {
  const requests: string[] = []

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token')

    if (url.includes('/repos/old/repo/pulls?'))
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repositories/42/pulls' },
        }),
      )

    if (url === 'https://api.github.com/repos/old/repo')
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repositories/42' },
        }),
      )

    if (url === 'https://api.github.com/repositories/42')
      return Promise.resolve(Response.json({ id: 42, owner: { login: 'New' }, name: 'Repo' }))

    if (url.includes('/repos/new/repo/pulls?')) return Promise.resolve(Response.json([]))

    return Promise.reject(new Error('Unexpected request'))
  }

  return Effect.gen(function* () {
    const page = yield* list

    expect(page.items).toEqual([])
    expect(page.hosting.repository.key).toBe('new/repo')
    expect(page.hosting.repository.displayName).toBe('New/Repo')
    expect(page.hosting.cloneUrl).toBe('https://github.com/new/repo.git')
    expect(requests).toHaveLength(4)
  }).pipe(
    Effect.provide(pullRequestsLayer.pipe(Layer.provide(authentication))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'follow' }),
  )
})

it.effect(
  'refuses unsafe relocation targets, mismatched IDs, redirect loops, and inaccessible metadata',
  () =>
    Effect.gen(function* () {
      for (const scenario of [
        {
          location: 'https://evil.invalid/repositories/42',
          status: 200,
          id: 42,
          expected: 'ProviderRedirected',
        },
        {
          location: 'http://api.github.com/repositories/42',
          status: 200,
          id: 42,
          expected: 'ProviderRedirected',
        },
        {
          location: 'https://api.github.com/user',
          status: 200,
          id: 42,
          expected: 'ProviderRedirected',
        },
        {
          location: 'https://api.github.com/repositories/42?token=x',
          status: 200,
          id: 42,
          expected: 'ProviderRedirected',
        },
        {
          location: 'https://api.github.com/repositories/42',
          status: 200,
          id: 43,
          expected: 'InvalidProviderResponse',
        },
        {
          location: 'https://api.github.com/repositories/42',
          status: 301,
          id: 42,
          expected: 'ProviderRedirected',
        },
        {
          location: 'https://api.github.com/repositories/42',
          status: 404,
          id: 42,
          expected: 'RepositoryUnavailable',
        },
      ]) {
        const requests: string[] = []

        const fetch: typeof globalThis.fetch = (input) => {
          const url = input instanceof Request ? input.url : String(input)
          requests.push(url)

          if (url.includes('/repos/old/repo'))
            return Promise.resolve(
              new Response(null, { status: 301, headers: { location: scenario.location } }),
            )

          expect(url).toBe('https://api.github.com/repositories/42')

          return Promise.resolve(
            Response.json(
              { id: scenario.id, owner: { login: 'new' }, name: 'repo' },
              { status: scenario.status, headers: { location: scenario.location } },
            ),
          )
        }

        const error = yield* list.pipe(
          Effect.provide(pullRequestsLayer.pipe(Layer.provide(authentication))),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.flip,
        )

        expect(error._tag).toBe(scenario.expected)
        expect(requests.length).toBeLessThanOrEqual(3)
        expect(requests.every((url) => url.startsWith('https://api.github.com/'))).toBe(true)
      }
    }),
)
