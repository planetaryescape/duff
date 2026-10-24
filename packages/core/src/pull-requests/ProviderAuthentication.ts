import { Context, type Effect, type Option, Schema } from 'effect'

import { type AuthenticationError, GitHubCredentialSource } from './GitHostingProvider'

/** Parsed authentication data; the token stays redacted inside core. */
export const ProviderSession = Schema.Struct({
  id: Schema.String,
  token: Schema.Redacted(Schema.NonEmptyString),
  account: Schema.Option(Schema.Struct({ id: Schema.String, displayName: Schema.String })),
  source: Schema.optionalKey(GitHubCredentialSource),
})

export interface ProviderSession extends Schema.Schema.Type<typeof ProviderSession> {}

export class ProviderAuthentication extends Context.Service<
  ProviderAuthentication,
  {
    readonly session: (
      provider: string,
      scopes: ReadonlyArray<string>,
      mode: 'silent' | 'connect',
    ) => Effect.Effect<Option.Option<ProviderSession>, AuthenticationError>
  }
>()('duff/ProviderAuthentication') {}
