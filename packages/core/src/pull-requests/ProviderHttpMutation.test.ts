import { expect, it } from '@effect/vitest'
import { Context, Deferred, Effect, Fiber, Layer, Option } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { discussionPolicy } from './Discussion'
import { ProviderHttp } from './ProviderHttp'

it.effect('does not retry mutations and retains undecodable success as uncertainty', () =>
  Effect.gen(function* () {
    let requests = 0

    const client = HttpClient.make((request) => {
      requests++
      expect(request.method).toBe('PATCH')

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('not-json', { status: 200 })),
      )
    })

    const result = yield* ProviderHttp.use((http) =>
      http.mutate({
        method: 'PATCH',
        url: 'https://example.invalid/thread',
        token: Option.none(),
        body: { status: 'fixed' },
        headers: {},
      }),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    )

    expect(result).toEqual({ _tag: 'Uncertain', reason: 'response-decode' })
    expect(requests).toBe(1)
  }),
)

it.effect('never follows mutation redirects or decodes rejected response bodies', () =>
  Effect.gen(function* () {
    let requests = 0

    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        requests++
        const context = yield* Effect.context()
        expect(Context.getOrUndefined(context, FetchHttpClient.RequestInit)?.redirect).toBe(
          'manual',
        )

        return HttpClientResponse.fromWeb(
          request,
          new Response('private rejection', {
            status: 302,
            headers: { location: 'https://elsewhere.invalid' },
          }),
        )
      }),
    )

    const result = yield* ProviderHttp.use((http) =>
      http.mutate({
        method: 'POST',
        url: 'https://example.invalid/thread',
        token: Option.none(),
        body: {},
        headers: {},
      }),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    )

    expect(result).toMatchObject({ _tag: 'Received', status: 302, body: null })
    expect(requests).toBe(1)
    expect(JSON.stringify(result)).not.toContain('private rejection')
  }),
)

it.effect('bounds successful response streaming and reports the lost receipt as uncertain', () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('x'.repeat(discussionPolicy.responseBytes + 1)),
        ),
      ),
    )

    const result = yield* ProviderHttp.use((http) =>
      http.mutate({
        method: 'POST',
        url: 'https://example.invalid/thread',
        token: Option.none(),
        body: {},
        headers: {},
      }),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    )

    expect(result).toEqual({ _tag: 'Uncertain', reason: 'body-limit' })
  }),
)

it.effect('times out a dispatched mutation once without classifying it as rejected', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let requests = 0

    const client = HttpClient.make(() => {
      requests++

      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
    })

    const work = ProviderHttp.use((http) =>
      http.mutate({
        method: 'POST',
        url: 'https://example.invalid/thread',
        token: Option.none(),
        body: {},
        headers: {},
      }),
    ).pipe(
      Effect.provide(
        ProviderHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    )

    const fiber = yield* work.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust('20 seconds')
    expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'Uncertain', reason: 'timeout' })
    expect(requests).toBe(1)
  }),
)
