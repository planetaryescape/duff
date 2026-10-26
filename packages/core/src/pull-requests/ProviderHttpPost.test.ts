import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { ProviderHttp } from './ProviderHttp'

it.effect(
  'encodes an authenticated JSON POST and classifies status, redirects, malformed and oversized responses',
  () =>
    Effect.gen(function* () {
      for (const fixture of [
        { status: 200, text: '{"count":0,"value":[]}', expected: 'Success' },
        { status: 200, text: 'invalid-json-canary', expected: 'InvalidProviderResponse' },
        { status: 200, text: 'x'.repeat(4 * 1024 * 1024 + 1), expected: 'InvalidProviderResponse' },
        { status: 401, text: 'private-canary', expected: 'AuthenticationRequired' },
        { status: 403, text: 'private-canary', expected: 'RepositoryUnavailable' },
        { status: 404, text: 'private-canary', expected: 'RepositoryUnavailable' },
        { status: 429, text: 'private-canary', expected: 'RateLimited' },
        { status: 500, text: 'private-canary', expected: 'ProviderUnavailable' },
        ...[301, 302, 303, 307, 308].map((status) => ({
          status,
          text: 'private-canary',
          expected: 'ProviderRedirected',
        })),
      ]) {
        let requests = 0

        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            requests++
            expect(request.method).toBe('POST')
            expect(request.headers['authorization']).toBe('Bearer canary-token')
            expect(request.headers['content-type']).toContain('application/json')
            expect(
              Option.getOrThrow(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).redirect,
            ).toBe('manual')
            expect(request.body._tag).toBe('Uint8Array')

            if (request.body._tag === 'Uint8Array')
              expect(Buffer.from(request.body.body).toString('utf8')).toBe(
                '{"baseVersionCommit":"base","fileDiffParams":[]}',
              )

            return HttpClientResponse.fromWeb(
              request,
              new Response(fixture.text, {
                status: fixture.status,
                headers: { 'Retry-After': '90', Location: 'https://other.invalid/private' },
              }),
            )
          }),
        )

        const result = yield* ProviderHttp.use((http) =>
          http.post(
            'https://example.invalid/fileDiffs',
            Option.some(Redacted.make('canary-token')),
            { baseVersionCommit: 'base', fileDiffParams: [] },
          ),
        ).pipe(
          Effect.provide(
            ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
          ),
          Effect.result,
        )

        expect(requests).toBe(1)
        expect(result._tag === 'Success' ? result._tag : result.failure._tag).toBe(fixture.expected)
        expect(JSON.stringify(result)).not.toContain('canary')

        if (result._tag === 'Success') expect(result.success.body).toEqual({ count: 0, value: [] })

        if (result._tag === 'Failure' && result.failure._tag === 'RateLimited')
          expect(result.failure.retryAfterSeconds).toEqual(Option.some(90))
      }
    }),
)

it.effect('applies the 20-second POST deadline and releases the transport', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()

    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    )

    const fiber = yield* ProviderHttp.use((http) =>
      http.post('https://example.invalid/fileDiffs', Option.none(), {}),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
      Effect.result,
      Effect.forkScoped,
    )

    yield* Deferred.await(started)
    yield* TestClock.adjust('20 seconds')
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderUnavailable' },
    })
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)

it.effect('POST cancellation interrupts the underlying request', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()

    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    )

    const fiber = yield* ProviderHttp.use((http) =>
      http.post('https://example.invalid/fileDiffs', Option.none(), {}),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
      Effect.forkScoped,
    )

    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)
