import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'

import {
  AuthenticationRequired,
  type DiscoveryError,
  InvalidProviderResponse,
  ProviderUnavailable,
  ProviderRedirected,
  RateLimited,
  RepositoryUnavailable,
} from './GitHostingProvider'

/** Transport output remains undecoded until the owning provider selects its wire schema. */
export const ProviderResponse = Schema.Struct({
  body: Schema.Unknown,
  headers: Schema.Record(Schema.String, Schema.String),
})

export interface ProviderResponse extends Schema.Schema.Type<typeof ProviderResponse> {}

export class ProviderHttp extends Context.Service<
  ProviderHttp,
  {
    readonly get: (
      url: string,
      token: Option.Option<Redacted.Redacted>,
      headers?: Readonly<Record<string, string>>,
      format?: 'json' | 'image',
      maxResponseBytes?: number,
    ) => Effect.Effect<ProviderResponse, DiscoveryError>
    readonly post: (
      url: string,
      token: Option.Option<Redacted.Redacted>,
      body: Schema.Json,
    ) => Effect.Effect<ProviderResponse, DiscoveryError>
  }
>()('duff/ProviderHttp') {
  static readonly layer = Layer.effect(
    ProviderHttp,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const get = Effect.fn('ProviderHttp.get')(
        function* (
          url: string,
          token: Option.Option<Redacted.Redacted>,
          headers: Readonly<Record<string, string>> = {},
          format: 'json' | 'image' = 'json',
          body?: Schema.Json,
          maxResponseBytes: number = 4 * 1024 * 1024,
        ) {
          if (
            !Number.isSafeInteger(maxResponseBytes) ||
            maxResponseBytes < 1 ||
            maxResponseBytes > 4 * 1024 * 1024
          )
            return yield* new InvalidProviderResponse()

          let request = (
            body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
          ).pipe(HttpClientRequest.setHeaders({ Accept: 'application/json', ...headers }))

          if (body !== undefined)
            request = yield* HttpClientRequest.bodyJson(request, body).pipe(
              Effect.mapError(() => new InvalidProviderResponse()),
            )

          if (Option.isSome(token))
            request = request.pipe(HttpClientRequest.bearerToken(token.value))

          const response = yield* client.execute(request).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
            Effect.mapError(() => new ProviderUnavailable()),
          )

          const delay = response.headers['retry-after']
          const now = yield* Clock.currentTimeMillis

          const seconds =
            delay === undefined
              ? NaN
              : /^\d+$/.test(delay)
                ? Number(delay)
                : Option.getOrElse(
                    Option.map(
                      DateTime.make(delay),
                      (time) => (DateTime.toEpochMillis(time) - now) / 1000,
                    ),
                    () => NaN,
                  )

          const retryAfterSeconds = Number.isFinite(seconds)
            ? Option.some(Math.max(0, seconds))
            : Option.none<number>()

          if (
            response.status === 429 ||
            (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0')
          ) {
            return yield* new RateLimited({ retryAfterSeconds })
          }

          if (response.status === 401) return yield* new AuthenticationRequired()

          if (response.status === 403 || response.status === 404)
            return yield* new RepositoryUnavailable()

          if (response.status >= 500 || response.status === 408)
            return yield* new ProviderUnavailable()

          if (format === 'json' && [301, 302, 303, 307, 308].includes(response.status))
            return yield* new ProviderRedirected(
              response.headers.location
                ? { location: Redacted.make(response.headers.location) }
                : {},
            )

          if (response.status < 200 || response.status >= 300)
            return yield* new InvalidProviderResponse()

          const declaredLength = response.headers['content-length']

          if (
            format === 'json' &&
            declaredLength !== undefined &&
            /^\d+$/.test(declaredLength) &&
            Number(declaredLength) > maxResponseBytes
          )
            return yield* new InvalidProviderResponse()

          if (format === 'image') {
            const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()

            if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
              return yield* new InvalidProviderResponse()
            const chunks: Uint8Array[] = []
            let bytes = 0

            yield* Stream.runForEach(response.stream, (chunk) => {
              bytes += chunk.byteLength

              if (bytes > Math.min(256 * 1024, maxResponseBytes))
                return Effect.fail(new InvalidProviderResponse())
              chunks.push(chunk)

              return Effect.void
            }).pipe(Effect.mapError(() => new InvalidProviderResponse()))

            if (bytes === 0) return yield* new InvalidProviderResponse()

            return ProviderResponse.make({
              body: `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`,
              headers: response.headers,
            })
          }

          const chunks: Uint8Array[] = []
          let bytes = 0
          yield* Stream.runForEach(response.stream, (chunk) => {
            bytes += chunk.byteLength

            if (bytes > maxResponseBytes) return Effect.fail(new InvalidProviderResponse())
            chunks.push(chunk)

            return Effect.void
          }).pipe(Effect.mapError(() => new InvalidProviderResponse()))

          const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            Buffer.concat(chunks).toString('utf8'),
          ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

          return ProviderResponse.make({ body: decoded, headers: response.headers })
        },
        Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => new ProviderUnavailable() }),
      )

      return ProviderHttp.of({
        get: (url, token, headers, format, maxResponseBytes) =>
          get(url, token, headers, format, undefined, maxResponseBytes),
        post: (url, token, body) => get(url, token, {}, 'json', body),
      })
    }),
  )
}
