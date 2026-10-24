import { type Effect, type Option, type Redacted, Schema } from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'

export type Remote = GitContextSnapshot['remotes'][number]

export const GitHubCredentialSource = Schema.Literals([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'github-cli',
  'editor',
])

export type GitHubCredentialSource = Schema.Schema.Type<typeof GitHubCredentialSource>

export const ProviderIdentity = Schema.Struct({
  id: Schema.NonEmptyString,
  displayName: Schema.NonEmptyString,
  authenticationSource: Schema.Literals(['editor', 'azure-cli', 'github']),
})

export interface ProviderIdentity extends Schema.Schema.Type<typeof ProviderIdentity> {}

export const RepositoryIdentity = Schema.Struct({
  authority: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  displayName: Schema.NonEmptyString,
})

export interface RepositoryIdentity extends Schema.Schema.Type<typeof RepositoryIdentity> {}

export const Authentication = Schema.Union([
  Schema.TaggedStruct('Authenticated', {
    account: Schema.Option(Schema.Struct({ id: Schema.String, displayName: Schema.String })),
    source: Schema.optionalKey(GitHubCredentialSource),
  }),
  Schema.TaggedStruct('Unauthenticated', {}),
  Schema.TaggedStruct('Unknown', {}),
])

export type Authentication = Schema.Schema.Type<typeof Authentication>

export const PullRequestRef = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^refs\//)),
  revision: Schema.Option(
    Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)),
  ),
})

export const OpenPullRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.String,
  url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  draft: Schema.Boolean,
  source: Schema.Union([
    Schema.TaggedStruct('Available', { repository: RepositoryIdentity, ref: PullRequestRef }),
    Schema.TaggedStruct('Unavailable', {}),
  ]),
  target: Schema.Struct({ repository: RepositoryIdentity, ref: PullRequestRef }),
})

export interface OpenPullRequest extends Schema.Schema.Type<typeof OpenPullRequest> {}

export const PullRequestPage = Schema.Struct({
  items: Schema.Array(OpenPullRequest),
  next: Schema.Option(Schema.Redacted(Schema.String)),
})

export interface PullRequestPage extends Schema.Schema.Type<typeof PullRequestPage> {}

export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  'AuthenticationRequired',
  {},
) {}

export class RepositoryUnavailable extends Schema.TaggedError<RepositoryUnavailable>()(
  'RepositoryUnavailable',
  {},
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  retryAfterSeconds: Schema.Option(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
}) {}

export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
  'ProviderUnavailable',
  {},
) {}

export class InvalidProviderResponse extends Schema.TaggedError<InvalidProviderResponse>()(
  'InvalidProviderResponse',
  {},
) {}

export class InvalidContinuation extends Schema.TaggedError<InvalidContinuation>()(
  'InvalidContinuation',
  {},
) {}

export class AzureCliAuthenticationError extends Schema.TaggedError<AzureCliAuthenticationError>()(
  'AzureCliAuthenticationError',
  {
    reason: Schema.Literals([
      'not-installed',
      'sign-in-required',
      'unavailable',
      'invalid-response',
    ]),
  },
) {}

export class GitHubAuthenticationError extends Schema.TaggedError<GitHubAuthenticationError>()(
  'GitHubAuthenticationError',
  {
    source: GitHubCredentialSource,
    reason: Schema.Literals(['invalid-credential', 'unavailable', 'rejected', 'inaccessible']),
  },
) {}

export type AuthenticationError =
  | RateLimited
  | ProviderUnavailable
  | InvalidProviderResponse
  | AzureCliAuthenticationError
  | GitHubAuthenticationError

export type DiscoveryError =
  | AuthenticationRequired
  | RepositoryUnavailable
  | AuthenticationError
  | InvalidContinuation

export interface ProviderRepository {
  readonly identity: RepositoryIdentity
  readonly inspectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>
  readonly connectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>
  readonly getPullRequest: (id: string) => Effect.Effect<OpenPullRequest, DiscoveryError>
  readonly listOpenPullRequests: (input: {
    readonly scope: 'repository'
    readonly cursor: Option.Option<Redacted.Redacted>
  }) => Effect.Effect<PullRequestPage, DiscoveryError>
}

/** Name a bound repository implementation without adding a context service or data codec. */
export const ProviderRepository = {
  of: (implementation: ProviderRepository): ProviderRepository => implementation,
}

export interface GitHostingProvider {
  readonly identity: ProviderIdentity
  readonly recognizeRemote: (remote: Remote) => Option.Option<ProviderRepository>
}

/** Name a provider implementation while preserving its structural substitution seam. */
export const GitHostingProvider = {
  of: (implementation: GitHostingProvider): GitHostingProvider => implementation,
}
