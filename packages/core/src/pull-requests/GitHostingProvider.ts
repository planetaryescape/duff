import { type Effect, type Option, type Redacted, Schema } from 'effect'

import { type RepositoryPage } from '../dashboard/RepositoryDirectory'
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

export const PullRequestState = Schema.Literals(['open', 'merged', 'closed'])

export type PullRequestState = Schema.Schema.Type<typeof PullRequestState>

export const OpenPullRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.String,
  author: Schema.optional(Schema.NonEmptyString),
  authorAvatarKey: Schema.optional(Schema.NonEmptyString),
  state: Schema.optionalKey(PullRequestState),
  url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  draft: Schema.Boolean,
  source: Schema.Union([
    Schema.TaggedStruct('Available', { repository: RepositoryIdentity, ref: PullRequestRef }),
    Schema.TaggedStruct('Unavailable', {}),
  ]),
  target: Schema.Struct({ repository: RepositoryIdentity, ref: PullRequestRef }),
})

export interface OpenPullRequest extends Schema.Schema.Type<typeof OpenPullRequest> {}

export const ChangeCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

/** Only inert, bounded raster images cross into the editor webview. */
export const AvatarImage = Schema.String.check(
  Schema.isPattern(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/),
  Schema.isMaxLength(350_000),
)

export const PullRequestDetails = Schema.Struct({
  pullRequest: OpenPullRequest,
  description: Schema.String,
  filesChanged: Schema.Option(ChangeCount),
  linesChanged: Schema.Option(Schema.Struct({ additions: ChangeCount, deletions: ChangeCount })),
})

export interface PullRequestDetails extends Schema.Schema.Type<typeof PullRequestDetails> {}

export const ComparisonIdentity = Schema.Struct({
  providerId: Schema.NonEmptyString,
  authority: Schema.NonEmptyString,
  targetRepository: RepositoryIdentity,
  sourceRepository: RepositoryIdentity,
  pullRequestId: Schema.NonEmptyString,
  targetRevision: PullRequestRef.fields.revision.value,
  sourceRevision: PullRequestRef.fields.revision.value,
  baseRevision: PullRequestRef.fields.revision.value,
  mode: Schema.Literals(['merge-base-v1']),
})

export interface ComparisonIdentity extends Schema.Schema.Type<typeof ComparisonIdentity> {}

export const ChangeStatistics = Schema.Struct({
  comparison: ComparisonIdentity,
  filesChanged: Schema.Option(ChangeCount),
  lines: Schema.Union([
    Schema.TaggedStruct('Complete', { additions: ChangeCount, deletions: ChangeCount }),
    Schema.TaggedStruct('Unavailable', {
      reason: Schema.Literals([
        'unsupported-comparison',
        'incomplete-response',
        'binary-content',
        'work-limit-exceeded',
      ]),
    }),
  ]),
})

export interface ChangeStatistics extends Schema.Schema.Type<typeof ChangeStatistics> {}

export class ComparisonChanged extends Schema.TaggedError<ComparisonChanged>()(
  'ComparisonChanged',
  {},
) {}

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

export class ProviderRedirected extends Schema.TaggedError<ProviderRedirected>()(
  'ProviderRedirected',
  { location: Schema.optionalKey(Schema.Redacted(Schema.String)) },
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
  | ProviderRedirected

export const DiscoveryError = Schema.Union([
  AuthenticationRequired,
  RepositoryUnavailable,
  RateLimited,
  ProviderUnavailable,
  InvalidProviderResponse,
  AzureCliAuthenticationError,
  GitHubAuthenticationError,
  ProviderRedirected,
  InvalidContinuation,
])

export type DiscoveryError = Schema.Schema.Type<typeof DiscoveryError>

export interface ProviderRepository {
  readonly identity: RepositoryIdentity
  readonly inspectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>
  readonly connectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>
  readonly getPullRequest: (id: string) => Effect.Effect<OpenPullRequest, DiscoveryError>
  readonly getPullRequestDetails: (id: string) => Effect.Effect<PullRequestDetails, DiscoveryError>
  readonly getPullRequestMetadata?: (
    id: string,
  ) => Effect.Effect<PullRequestDetails, DiscoveryError>
  readonly getPullRequestStatistics?: (
    expected: OpenPullRequest,
  ) => Effect.Effect<ChangeStatistics, DiscoveryError | ComparisonChanged>
  /** The key is provider-owned, never a webview-supplied destination for authenticated HTTP. */
  readonly getAvatar: (key: string) => Effect.Effect<Option.Option<string>, DiscoveryError>
  readonly listPullRequests: (input: {
    readonly scope: 'repository'
    readonly state: PullRequestState
    readonly cursor: Option.Option<Redacted.Redacted>
  }) => Effect.Effect<PullRequestPage, DiscoveryError>
}

/** Name a bound repository implementation without adding a context service or data codec. */
export const ProviderRepository = {
  of: (implementation: ProviderRepository): ProviderRepository => implementation,
}

export interface GitHostingProvider {
  readonly identity: ProviderIdentity
  readonly refreshRepository?: (
    repository: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, DiscoveryError>
  readonly recognizeRemote: (remote: Remote) => Option.Option<ProviderRepository>
  /** Canonical credential-free transport destination, validated by the provider. */
  readonly destination?: (repository: RepositoryIdentity) => Option.Option<string>
  readonly browsingScope?: (repository: RepositoryIdentity) => string
  readonly browseRepositories?: (
    scope: string,
    page: number,
    mode: 'silent' | 'connect',
  ) => Effect.Effect<RepositoryPage, DiscoveryError>
}

/** Name a provider implementation while preserving its structural substitution seam. */
export const GitHostingProvider = {
  of: (implementation: GitHostingProvider): GitHostingProvider => implementation,
}
