import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  type Redacted,
  Schema,
  Stream,
} from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import {
  AuthenticationRequired,
  type DiscoveryError,
  InvalidProviderResponse,
  ProviderUnavailable,
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
        ) {
          let request = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({ Accept: 'application/json', ...headers }),
          )

          if (Option.isSome(token))
            request = request.pipe(HttpClientRequest.bearerToken(token.value))

          const response = yield* client
            .execute(request)
            .pipe(Effect.mapError(() => new ProviderUnavailable()))

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

          if (response.status < 200 || response.status >= 300)
            return yield* new InvalidProviderResponse()

          if (format === 'image') {
            const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()

            if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
              return yield* new InvalidProviderResponse()
            const chunks: Uint8Array[] = []
            let bytes = 0

            yield* Stream.runForEach(response.stream, (chunk) => {
              bytes += chunk.byteLength

              if (bytes > 256 * 1024) return Effect.fail(new InvalidProviderResponse())
              chunks.push(chunk)

              return Effect.void
            }).pipe(Effect.mapError(() => new InvalidProviderResponse()))

            if (bytes === 0) return yield* new InvalidProviderResponse()

            return ProviderResponse.make({
              body: `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`,
              headers: response.headers,
            })
          }

          const body = yield* response.json.pipe(
            Effect.mapError(() => new InvalidProviderResponse()),
          )

          return ProviderResponse.make({ body, headers: response.headers })
        },
        Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => new ProviderUnavailable() }),
      )

      return ProviderHttp.of({ get })
    }),
  )
}
