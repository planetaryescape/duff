import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { ProviderHttp } from './ProviderHttp'

it.effect(
  'enforces the caller JSON response bound before decoding and refuses invalid bounds',
  () =>
    Effect.gen(function* () {
      let requests = 0

      const client = HttpClient.make((request) => {
        requests++
        expect(request.method).toBe('GET')

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ content: 'x'.repeat(100) })),
          ),
        )
      })

      yield* Effect.gen(function* () {
        const http = yield* ProviderHttp
        expect(
          yield* http
            .get('https://example.invalid/items', Option.none(), {}, 'json', 32)
            .pipe(Effect.result),
        ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidProviderResponse' } })
        expect(
          yield* http
            .get('https://example.invalid/items', Option.none(), {}, 'json', 256)
            .pipe(Effect.result),
        ).toMatchObject({ _tag: 'Success' })

        for (const bound of [0, -1, 1.5, 4 * 1024 * 1024 + 1])
          yield* http
            .get('https://example.invalid/items', Option.none(), {}, 'json', bound)
            .pipe(Effect.result)
        expect(requests).toBe(2)
      }).pipe(
        Effect.provide(
          ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
        ),
      )
    }),
)

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
          | 'ProviderRedirected'
        ),
      ]
    > = [
      [401, 'AuthenticationRequired'],
      [403, 'RepositoryUnavailable'],
      [404, 'RepositoryUnavailable'],
      [429, 'RateLimited'],
      [503, 'ProviderUnavailable'],
      [301, 'ProviderRedirected'],
      [302, 'ProviderRedirected'],
      [307, 'ProviderRedirected'],
      [308, 'ProviderRedirected'],
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

it.effect(
  'accepts bounded raster images and rejects active, empty, oversized or redirected images',
  () =>
    Effect.gen(function* () {
      const fixtures = [
        { content: 'raster', mime: 'image/png', status: 200, valid: true },
        { content: '<svg onload="alert(1)"/>', mime: 'image/svg+xml', status: 200, valid: false },
        { content: '', mime: 'image/png', status: 200, valid: false },
        { content: 'x'.repeat(256 * 1024 + 1), mime: 'image/png', status: 200, valid: false },
        { content: 'redirect', mime: 'image/png', status: 302, valid: false },
      ]

      for (const fixture of fixtures) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(fixture.content, {
                status: fixture.status,
                headers: { 'Content-Type': fixture.mime },
              }),
            ),
          ),
        )

        const result = yield* ProviderHttp.use((http) =>
          http.get('https://example.invalid/avatar', Option.none(), {}, 'image'),
        ).pipe(
          Effect.provide(
            ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
          ),
          Effect.result,
        )

        if (fixture.valid) {
          expect(result._tag).toBe('Success')

          if (result._tag === 'Success')
            expect(result.success.body).toBe('data:image/png;base64,cmFzdGVy')
        } else {
          expect(result._tag).toBe('Failure')

          if (result._tag === 'Failure') expect(result.failure._tag).toBe('InvalidProviderResponse')
        }
      }
    }),
)
