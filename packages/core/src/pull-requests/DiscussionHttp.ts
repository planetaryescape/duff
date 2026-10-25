import { Clock, Effect, type Option, type Redacted, Schema } from 'effect'

import {
  DiscussionLimitExceeded,
  DiscussionWriteRejected,
  DiscussionWriteUncertain,
  discussionPolicy,
  type DiscussionKey,
  type DiscussionReadError,
} from './Discussion'
import { InvalidProviderResponse, type DiscoveryError } from './GitHostingProvider'
import { type MutationHttpResult, type ProviderHttp, type ProviderResponse } from './ProviderHttp'

class DiscussionBudget {
  constructor(
    readonly available: () => number,
    readonly get: (
      url: string,
    ) => Effect.Effect<ProviderResponse, DiscoveryError | DiscussionLimitExceeded>,
    readonly post: (
      url: string,
      body: Schema.Json,
    ) => Effect.Effect<ProviderResponse, DiscoveryError | DiscussionLimitExceeded>,
  ) {}
}

export const makeDiscussionBudget = Effect.fn('DiscussionHttp.makeBudget')(function* (
  http: Pick<ProviderHttp['Service'], 'get' | 'post'>,
  token: Option.Option<Redacted.Redacted>,
) {
  const started = yield* Clock.currentTimeMillis
  let requests = 0

  const take = Effect.fn('DiscussionHttp.takeBudget')(function* () {
    if (
      ++requests > discussionPolicy.requests ||
      (yield* Clock.currentTimeMillis) - started >= discussionPolicy.refreshTimeout
    )
      return yield* new DiscussionLimitExceeded()
  })

  return new DiscussionBudget(
    () => discussionPolicy.requests - requests,
    Effect.fn('DiscussionHttp.get')(function* (url: string) {
      yield* take()

      return yield* http.get(url, token)
    }),
    Effect.fn('DiscussionHttp.query')(function* (url: string, body: Schema.Json) {
      yield* take()

      return yield* http.post(url, token, body)
    }),
  )
})

export const mutationBody = Effect.fn('DiscussionHttp.mutationBody')(function* (
  result: MutationHttpResult,
) {
  if (result._tag === 'Uncertain') {
    if (result.reason === 'timeout')
      return yield* new DiscussionWriteUncertain({ reason: 'timeout' })

    if (result.reason === 'transport')
      return yield* new DiscussionWriteUncertain({ reason: 'transport' })

    return yield* new DiscussionWriteUncertain({ reason: 'invalid-response' })
  }

  const status = result.status

  if (status === 401) return yield* new DiscussionWriteRejected({ reason: 'authentication' })

  if (status === 403) return yield* new DiscussionWriteRejected({ reason: 'permission' })

  if (status === 404) return yield* new DiscussionWriteRejected({ reason: 'missing-thread' })

  if (status === 422 || status === 400)
    return yield* new DiscussionWriteRejected({ reason: 'unsupported-anchor' })

  if (status === 409) return yield* new DiscussionWriteRejected({ reason: 'conflict' })

  if (status === 429) return yield* new DiscussionWriteRejected({ reason: 'rate-limited' })

  if (status < 200 || status >= 300)
    return yield* new DiscussionWriteUncertain({ reason: 'transport' })

  return result.body
})

export const preflightFailure = (
  error: DiscussionReadError | DiscoveryError,
): DiscussionWriteRejected =>
  new DiscussionWriteRejected({
    reason:
      error._tag === 'AuthenticationRequired' ||
      error._tag === 'GitHubAuthenticationError' ||
      error._tag === 'AzureCliAuthenticationError'
        ? 'authentication'
        : error._tag === 'RateLimited'
          ? 'rate-limited'
          : error._tag === 'RepositoryUnavailable'
            ? 'permission'
            : 'comparison-changed',
  })

export const boundDiscussion = (
  key: DiscussionKey,
  providerId: string,
  authority: string,
  repository: string,
): boolean =>
  key.providerId === providerId &&
  key.repository.authority === authority &&
  key.repository.key === repository &&
  /^[1-9][0-9]*$/.test(key.pullRequestId) &&
  Number.isSafeInteger(Number(key.pullRequestId))

export const decodeDiscussion =
  <S extends Schema.Top>(schema: S) =>
  (
    response: ProviderResponse,
  ): Effect.Effect<S['Type'], InvalidProviderResponse, S['DecodingServices']> =>
    Schema.decodeUnknownEffect(schema)(response.body).pipe(
      Effect.mapError(() => new InvalidProviderResponse()),
    )
