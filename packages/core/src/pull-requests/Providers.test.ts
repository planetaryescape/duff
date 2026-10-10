import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { type GitContextSnapshot } from '../git-context/GitContext'
import { ProviderAuthentication } from './ProviderAuthentication'
import { pullRequestsLayer } from './Providers'
import { PullRequests } from './PullRequests'

it.effect('built-ins discover both providers without host HTTP wiring and reject redirects', () => {
  const fetch: typeof globalThis.fetch = (input, init) => {
    expect(init?.redirect).toBe('manual')
    const url = new URL(input instanceof Request ? input.url : String(input))

    if (url.hostname === 'api.github.com' && url.pathname === '/repos/owner/repo/pulls') {
      return Promise.resolve(
        Response.json([
          {
            number: 17,
            title: 'GitHub change',
            draft: true,
            head: {
              ref: 'feature',
              sha: 'a'.repeat(40),
              repo: { owner: { login: 'fork' }, name: 'repo' },
            },
            base: {
              ref: 'main',
              sha: 'b'.repeat(40),
              repo: { owner: { login: 'owner' }, name: 'repo' },
            },
          },
        ]),
      )
    }

    if (url.hostname === 'dev.azure.com') {
      return Promise.resolve(
        Response.json({
          count: 1,
          value: [
            {
              pullRequestId: 29,
              title: 'Azure change',
              status: 'active',
              isDraft: false,
              sourceRefName: 'refs/heads/topic',
              targetRefName: 'refs/heads/main',
            },
          ],
        }),
      )
    }

    if (url.pathname === '/repos/owner/redirect/pulls') {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } }),
      )
    }

    return Promise.reject(new Error('Unexpected request'))
  }

  const destinations = [
    'https://github.com/owner/repo',
    'https://dev.azure.com/acme/Project/_git/Repo',
    'https://github.com/owner/redirect',
  ]

  const snapshot: GitContextSnapshot = {
    root: '/fixture',
    helpers: [],
    sshCommandConfigured: false,
    remotes: destinations.map((destination, index) => ({
      name: `remote-${index}`,
      destination,
      transport: 'https',
      credentials: { _tag: 'NotApplicable' },
    })),
  }

  return Effect.gen(function* () {
    const service = yield* PullRequests
    const events = yield* Stream.runCollect(service.discover(snapshot))
    const results = events.filter((event) => event._tag === 'Updated').map((event) => event.result)
    expect(results).toHaveLength(3)
    const ready = results.filter((result) => result._tag === 'Ready')
    expect(
      ready
        .flatMap((result) => result.items.map((item) => [item.id, item.title, item.draft]))
        .sort(),
    ).toEqual([
      ['17', 'GitHub change', true],
      ['29', 'Azure change', false],
    ])
    expect(
      results.filter((result) => result._tag === 'Failed').map((result) => result.error._tag),
    ).toEqual(['InvalidProviderResponse'])
  }).pipe(
    Effect.provide(
      pullRequestsLayer.pipe(
        Layer.provide(
          Layer.succeed(ProviderAuthentication, {
            session: () =>
              Effect.succeed(
                Option.some({
                  id: 'test-session',
                  token: Redacted.make('test-token'),
                  account: { id: 'account', displayName: 'Test' },
                }),
              ),
          }),
        ),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
})
