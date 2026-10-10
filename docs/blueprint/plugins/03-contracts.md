# Contracts: one provider capability, two implementations

Status: both provider implementations share [GitHostingProvider.ts](../../../packages/core/src/plugins/GitHostingProvider.ts). [Plugin.ts](../../../packages/core/src/plugins/Plugin.ts) owns generic lifecycle; [ProviderDiscovery.ts](../../../packages/core/src/plugins/ProviderDiscovery.ts) owns execution policy. Sketches summarize the compiled boundary. Both providers implement the same capability, including explicit connection. See [flows](04-flows.md) and [delivery evidence](../../implementation-log.md).

## Ownership

Core owns these contracts and the discovery service. Built-in plugins implement them behind their own adapters. The host supplies dependencies and constructs the explicit registry in one managed runtime.

There is one public provider contract, not separate GitHub and Azure contracts. Provider-specific API DTOs, authentication mechanisms, repository parsing, and continuation formats remain private. Future shared capabilities extend this contract only when their behavior is defined for both providers.

## Domain values

The following TypeScript sketches describe domain shapes. Implementation must define data values with Effect Schema and derive types from those schemas, following GitContext's existing convention. Functions, Effects, and plugin instances are in-process objects, not serialized DTOs.

```ts
import type { Effect, Option, Redacted, Scope } from "effect";
import type { GitContextSnapshot } from "@duff/core/git-context";

type Remote = GitContextSnapshot["remotes"][number];

interface PluginIdentity {
  readonly id: string;
  readonly displayName: string;
}

interface RepositoryIdentity {
  readonly authority: string;
  readonly key: string;
  readonly displayName: string;
}

type Authentication =
  | {
      readonly _tag: "Authenticated";
      readonly account: {
        readonly id: string;
        readonly displayName: string;
      };
    }
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Unknown" };

interface PullRequestRef {
  readonly name: string;
  readonly revision: Option.Option<string>;
}

type PullRequestSource =
  | {
      readonly _tag: "Available";
      readonly repository: RepositoryIdentity;
      readonly ref: PullRequestRef;
    }
  | { readonly _tag: "Unavailable" };

interface OpenPullRequest {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly source: PullRequestSource;
  readonly target: {
    readonly repository: RepositoryIdentity;
    readonly ref: PullRequestRef;
  };
}

interface PullRequestPage {
  readonly items: ReadonlyArray<OpenPullRequest>;
  readonly next: Option.Option<Redacted.Redacted<string>>;
}

interface ListOpenPullRequests {
  readonly scope: "repository";
  readonly cursor: Option.Option<Redacted.Redacted<string>>;
}
```

### Value invariants

- Plugin IDs are nonempty and unique in the registry. They identify implementations, not accounts.
- Repository identity is the pair authority/key, interpreted within its plugin. Authority identifies the configured provider host; key must distinguish complete repository paths, including Azure organization/project. Recognition normalizes supported SSH/HTTPS forms to the same identity without a network call. It is not a promise of an immutable provider database ID.
- A PR is identified by plugin ID, target repository identity, and PR ID. PR IDs are not global.
- Account metadata is local UI data, not a credential, and is only reported as authenticated when the adapter establishes it. Authentication does not imply permission to every repository.
- Ref names are full Git refs, normalized by adapters. Revisions are validated immutable Git object IDs when supplied, not inferred from branch names.
- Deleted or inaccessible fork sources are explicitly unavailable. Do not invent the target repository as their source.
- PR URLs are validated HTTP(S) browser links without userinfo or secret query parameters. They are not API endpoints supplied back to a transport.
- Listing initially means all open PRs targeting the recognized repository, including drafts. It does not mean only the current user's PRs or only the current branch. Branch-specific discovery requires a later shared contract.
- A cursor is opaque, private, memory-only, and valid only for the bound repository, query, and authentication context that issued it. Adapters validate continuations and never follow an arbitrary caller-supplied URL. Refresh starts with no cursor.
- No next cursor means the read is complete. An empty page with a next cursor is not proof that the repository has no open PRs.

## Expected failures

Implement these as colocated Effect Schema tagged errors. Safe diagnostics come from Duff-owned fixed messages, not response bodies, subprocess stderr, or credential errors.

```ts
type AuthenticationRequired = {
  readonly _tag: "AuthenticationRequired";
};
type RepositoryUnavailable = {
  readonly _tag: "RepositoryUnavailable";
};
type RateLimited = {
  readonly _tag: "RateLimited";
  readonly retryAfterSeconds: Option.Option<number>;
};
type ProviderUnavailable = {
  readonly _tag: "ProviderUnavailable";
};
type InvalidProviderResponse = {
  readonly _tag: "InvalidProviderResponse";
};
type InvalidContinuation = {
  readonly _tag: "InvalidContinuation";
};

type AuthenticationError =
  | RateLimited
  | ProviderUnavailable
  | InvalidProviderResponse;

type DiscoveryError =
  | AuthenticationRequired
  | RepositoryUnavailable
  | AuthenticationError
  | InvalidContinuation;
```

RepositoryUnavailable covers missing or inaccessible repositories where the provider cannot safely distinguish them. Rate-limit delay, when present, is finite and nonnegative. Unknown authentication is a truthful successful inspection, not a substitute for a failed network request. Listing still handles expired or rejected sessions after inspection. Interruption remains Effect interruption, not an empty page or ordinary provider failure. Defects are not caught as successful discovery outcomes.

## Shared provider contribution

```ts
interface ProviderRepository {
  readonly identity: RepositoryIdentity;
  readonly inspectAuthentication:
    () => Effect.Effect<Authentication, AuthenticationError>;
  readonly connectAuthentication:
    () => Effect.Effect<Authentication, AuthenticationError>;
  readonly listOpenPullRequests:
    (input: ListOpenPullRequests) => Effect.Effect<PullRequestPage, DiscoveryError>;
}

interface ProviderContribution {
  readonly _tag: "Provider";
  readonly recognizeRemote: (remote: Remote) => Option.Option<ProviderRepository>;
}

type PluginContribution = ProviderContribution;

interface PluginInstance {
  readonly identity: PluginIdentity;
  readonly contributions: ReadonlyArray<PluginContribution>;
}

interface PluginDefinition<Requirements> {
  readonly identity: PluginIdentity;
  readonly make: Effect.Effect<
    ReadonlyArray<PluginContribution>,
    never,
    Requirements | Scope.Scope
  >;
}
```

Recognition is synchronous, local, and free of I/O. Unsupported transports, malformed forms, and unconfigured aliases return None. The returned ProviderRepository closes over provider-private routing data and dependencies. It does not acquire credentials or resources during recognition. Both plugins return this same interface, so callers cannot send a GitHub handle into an Azure method.

The first definition permits at most one Provider contribution per plugin. A plugin may declare none; callers do not infer capability from its ID. Future kinds form an explicit typed union, not a handler-name dictionary. A plugin instance copies identity from its definition rather than constructing a conflicting identity during make.

Make captures construction dependencies through Effect context and has no expected startup failure: it does not request login or contact the provider. An unavailable optional authentication mechanism is represented at operation time. Invalid built-in configuration is a safe startup diagnostic, not an empty provider result.

The composition root lifts construction into Layers under the existing runtime and supplies the resulting immutable instances to the discovery service. Do not repeatedly provide one shared Provider tag, since that would overwrite implementations. Do not add another runtime, manual dispose method, or activate/deactivate hooks. Resource acquisition belongs to owning scopes; subprocess and HTTP adapters propagate interruption.

## Service-facing contract

```ts
type RemoteDiscovery =
  | { readonly _tag: "Unsupported"; readonly remote: Remote }
  | {
      readonly _tag: "Ambiguous";
      readonly remote: Remote;
      readonly candidates: ReadonlyArray<PluginIdentity>;
    }
  | {
      readonly _tag: "Discovered";
      readonly remote: Remote;
      readonly plugin: PluginIdentity;
      readonly repository: RepositoryIdentity;
      readonly authentication: Authentication;
      readonly page: PullRequestPage;
    }
  | {
      readonly _tag: "Failed";
      readonly remote: Remote;
      readonly plugin: PluginIdentity;
      readonly repository: RepositoryIdentity;
      readonly error: DiscoveryError;
    };

type RemoteNotFound = { readonly _tag: "RemoteNotFound" };

interface ProviderDiscovery {
  readonly connect: (context: GitContextSnapshot, remoteName: string) =>
    Effect.Effect<Authentication, AuthenticationError | RemoteNotFound>;
  readonly discover:
    (context: GitContextSnapshot) => Effect.Effect<ReadonlyArray<RemoteDiscovery>>;
  readonly loadMore: (input: {
    readonly context: GitContextSnapshot;
    readonly remoteName: string;
    readonly cursor: Redacted.Redacted<string>;
  }) => Effect.Effect<RemoteDiscovery, RemoteNotFound>;
}
```

Implement ProviderDiscovery as an Effect Context.Service. It captures the immutable built-in registry when its Layer is constructed and owns recognition, authentication inspection, and listing. Bound ProviderRepository objects stay inside orchestration; only data outcomes leave the service. Editor callbacks do not orchestrate provider-specific calls.

Discover reads the first page for each uniquely recognized remote and preserves input remote order. It returns no rows when there are no remotes. Expected per-remote errors become Failed rows, not a failed whole batch. Defects and interruption still propagate through Effect; the absent typed error channel does not imply they are suppressed. Ambiguous candidates contain at least two distinct plugin identities.

LoadMore recognizes the named remote from the current context, validates its continuation, and reads the next page without replacing earlier pages. A missing remote is RemoteNotFound; changed routing/session/query produces InvalidContinuation rather than applying a stale token. The host retains cursors only in memory and never renders or logs them. The flows layer will specify page accumulation and stale-result rejection.

Loading, refreshing, and cancelled are editor workflow states, not plugin success data. Empty successful discovery means an empty items array with no continuation. A first page with a continuation must be shown as incomplete. Exact sequencing, bounded concurrency, and UI state projection belong in the next flows layer. No generic execute(operationName, payload), provider switch in the service, or capability for undefined future actions is introduced here.

## Startup interpretation

Runtime construction supplies implementations; it does not require a selected Git repository. Once a repository is selected, inspect GitContext, recognize its remotes, then run the shared provider workflow if enabled. Repeat this sequence on repository changes and explicit refresh, not only once at startup.

Git credential-strategy inspection does not execute helpers or expose tokens. Provider API authentication is a separate adapter concern, potentially using a different session than Git transport. Automatic discovery cannot silently invoke arbitrary helpers or prompt for login. Missing provider authentication never blocks local branch review.

## Authentication choice and remaining work

- GitHub uses native editor sessions with `repo`; explicit Connect opts into prompting after a permission warning. Silent inspection has a 12-second deadline, connection 120 seconds, and complete HTTP reads 20 seconds. The editor's authentication promise cannot itself be cancelled; stale completion cannot publish into a replaced operation.
- Public GitHub reads are permitted only after successful missing-session inspection. Rejected authentication is a failure, not anonymous fallback. Azure's native session strategy is implemented in the following parity slice.
- Refresh invalidates service-issued cursors as well as host rows. Tokens and cursors are private, Redacted, and memory-only. HTTP redirects are rejected rather than followed with a bearer token.
- Shared service operations for the future capabilities the owner wants to define after discovery.

No persistence DTO, external plugin protocol, or public VS Code extension API is added. All plugins compile and ship together. See [progress](PROGRESS.md) before treating any sketch as accepted policy.
