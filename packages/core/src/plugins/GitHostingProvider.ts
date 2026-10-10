import { Effect, Option, Redacted, Schema } from "effect";
import { GitContextSnapshot } from "../git-context/GitContext";
import type { PluginIdentity } from "./Plugin";

export type Remote = GitContextSnapshot["remotes"][number];

export const RepositoryIdentity = Schema.Struct({
  authority: Schema.NonEmptyString, key: Schema.NonEmptyString, displayName: Schema.NonEmptyString,
});
export interface RepositoryIdentity extends Schema.Schema.Type<typeof RepositoryIdentity> {}
export const Authentication = Schema.Union([
  Schema.TaggedStruct("Authenticated", { account: Schema.Struct({ id: Schema.String, displayName: Schema.String }) }),
  Schema.TaggedStruct("Unauthenticated", {}),
  Schema.TaggedStruct("Unknown", {}),
]);
export type Authentication = Schema.Schema.Type<typeof Authentication>;
export const PullRequestRef = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^refs\//)),
  revision: Schema.Option(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i))),
});
export const OpenPullRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.String,
  url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  draft: Schema.Boolean,
  source: Schema.Union([
    Schema.TaggedStruct("Available", { repository: RepositoryIdentity, ref: PullRequestRef }),
    Schema.TaggedStruct("Unavailable", {}),
  ]),
  target: Schema.Struct({ repository: RepositoryIdentity, ref: PullRequestRef }),
});
export interface OpenPullRequest extends Schema.Schema.Type<typeof OpenPullRequest> {}
export const PullRequestPage = Schema.Struct({
  items: Schema.Array(OpenPullRequest), next: Schema.Option(Schema.Redacted(Schema.String)),
});
export interface PullRequestPage extends Schema.Schema.Type<typeof PullRequestPage> {}

export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()("AuthenticationRequired", {}) {}
export class RepositoryUnavailable extends Schema.TaggedError<RepositoryUnavailable>()("RepositoryUnavailable", {}) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.Option(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
}) {}
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {}) {}
export class InvalidProviderResponse extends Schema.TaggedError<InvalidProviderResponse>()("InvalidProviderResponse", {}) {}
export class InvalidContinuation extends Schema.TaggedError<InvalidContinuation>()("InvalidContinuation", {}) {}
export class RemoteNotFound extends Schema.TaggedError<RemoteNotFound>()("RemoteNotFound", {}) {}
export type AuthenticationError = RateLimited | ProviderUnavailable | InvalidProviderResponse;
export type DiscoveryError = AuthenticationRequired | RepositoryUnavailable | AuthenticationError | InvalidContinuation;

export interface ProviderRepository {
  readonly identity: RepositoryIdentity;
  readonly inspectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>;
  readonly connectAuthentication: () => Effect.Effect<Authentication, AuthenticationError>;
  readonly listOpenPullRequests: (input: {
    readonly scope: "repository";
    readonly cursor: Option.Option<Redacted.Redacted<string>>;
  }) => Effect.Effect<PullRequestPage, DiscoveryError>;
}
export interface ProviderContribution {
  readonly _tag: "Provider";
  readonly recognizeRemote: (remote: Remote) => Option.Option<ProviderRepository>;
}
export type RemoteDiscovery =
  | { readonly _tag: "Unsupported"; readonly remote: Remote }
  | { readonly _tag: "Ambiguous"; readonly remote: Remote; readonly candidates: ReadonlyArray<PluginIdentity> }
  | {
    readonly _tag: "Discovered"; readonly remote: Remote; readonly plugin: PluginIdentity;
    readonly repository: RepositoryIdentity; readonly authentication: Authentication; readonly page: PullRequestPage;
  }
  | {
    readonly _tag: "Failed"; readonly remote: Remote; readonly plugin: PluginIdentity;
    readonly repository: RepositoryIdentity; readonly error: DiscoveryError;
  };
