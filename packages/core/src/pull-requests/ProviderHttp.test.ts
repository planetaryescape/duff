import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { ProviderHttp } from './ProviderHttp'

it.effect('classifies HTTP failures before decoding and hides raw response diagnostics', () =>
  Effect.gen(function* () {
    const fixtures: ReadonlyArray<
      readonly [
        number,
        (
          | 'AuthenticationRequired'
          | 'RepositoryUnavailable'
          | 'RateLimited'
          | 'ProviderUnavailable'
          | 'InvalidProviderResponse'
        ),
      ]
    > = [
      [401, 'AuthenticationRequired'],
      [403, 'RepositoryUnavailable'],
      [404, 'RepositoryUnavailable'],
      [429, 'RateLimited'],
      [503, 'ProviderUnavailable'],
      [302, 'InvalidProviderResponse'],
    ]

    for (const [status, expected] of fixtures) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('canary-secret', { status, headers: { 'Retry-After': '23' } }),
          ),
        ),
      )

      const result = yield* ProviderHttp.use((http) =>
        http.get('https://example.invalid/prs', Option.some(Redacted.make('canary-token'))),
      ).pipe(
        Effect.provide(
          ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
        ),
        Effect.flip,
      )

      expect(result._tag).toBe(expected)
      expect(JSON.stringify(result)).not.toContain('canary-secret')
      expect(JSON.stringify(result)).not.toContain('canary-token')

      if (result._tag === 'RateLimited') expect(result.retryAfterSeconds).toEqual(Option.some(23))
    }
  }),
)

it.effect('applies a finite deadline to a hung transport', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()

    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    )

    const work = ProviderHttp.use((http) =>
      http.get('https://example.invalid/prs', Option.none()),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
      Effect.flip,
    )

    const fiber = yield* work.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust('20 seconds')
    expect((yield* Fiber.join(fiber))._tag).toBe('ProviderUnavailable')
  }),
)
