# Pull-request capability and review session

Status: discovery, CLI-only Azure authentication and exact-revision PR preparation implemented, 2026-10-15. Check, 59 application tests, rule tests and packaging pass. Native qualification distinguishes installed-artifact checks, real Azure reads and supplied-provider fixture captures. GitHub native sign-in and Windows process handling remain unverified. See the delivery log for evidence and limits.

This chapter supersedes the [staged plugin design](plugins/00-problem.md) under [D007](02-decision-log.md#d007-job-shaped-capabilities-and-one-review-session). GitHub and Azure DevOps are built in. Bitbucket is deferred. There is no generic plugin lifecycle or Alchemy.

## Owners and public boundaries

| Owner | Contract |
| --- | --- |
| [GitHostingProvider.ts](../../packages/core/src/pull-requests/GitHostingProvider.ts) | One job-shaped adapter: pure remote recognition returns a bound repository with silent authentication inspection, explicit connection, and paginated repository-wide open-PR reads |
| [PullRequests.ts](../../packages/core/src/pull-requests/PullRequests.ts) | Provider routing, equivalent-remote grouping, progressive discovery, private continuation state, group-based connect and loadMore |
| [ReviewSession.ts](../../packages/core/src/review-session/ReviewSession.ts) | One selected local repository, local inspection, owned background jobs, retained PR content, observable state |
| [Providers.ts](../../packages/core/src/pull-requests/Providers.ts) | Constructs built-in HTTP adapters, supplies their HTTP transport and composes PullRequests; native authentication is the remaining host dependency |
| [ProviderAuthentication.ts](../../packages/core/src/pull-requests/ProviderAuthentication.ts) | Headless session contract. The [extension implementation](../../packages/extension/src/pull-requests/ProviderAuthentication.ts) routes GitHub to native editor authentication and Azure to the core CLI service |
| [PullRequestCommands.ts](../../packages/extension/src/pull-requests/PullRequestCommands.ts), [PullRequestView.ts](../../packages/extension/src/pull-requests/PullRequestView.ts) | Subscribe to session changes, render native rows, dispatch explicit group actions, open provider pages |
| [GitHubHttp.ts](../../packages/core/src/pull-requests/github/GitHubHttp.ts), [AzureDevOpsHttp.ts](../../packages/core/src/pull-requests/azure-devops/AzureDevOpsHttp.ts) | HTTP implementations of the shared adapter contract: recognition, protocol validation, draft/fork normalization, session-bound pagination and cooldowns |

Core has no VS Code dependency. It owns provider implementations and their tests, not only contracts. The extension supplies native authentication through the built-in Layer export, without selecting provider transports or importing individual adapters. Its composition root owns one managed runtime. Local branch comparison stays independent of network availability. The separate HTTP client used for extension telemetry is not provider transport.

## Transport-neutral adapter contract

`GitHostingProvider` describes pure remote recognition. A recognized `ProviderRepository` exposes four jobs, with captured dependencies and no transport requirements on callers:

- `inspectAuthentication()` returns Authentication without prompting.
- `connectAuthentication()` performs explicit connection and returns Authentication.
- `listOpenPullRequests({ scope: "repository", cursor })` returns a normalized PullRequestPage or typed DiscoveryError.
- `getPullRequest(id)` rereads and normalizes one selected PR, without invalidating list continuation state.

The consumer-facing Effect service is PullRequests. It takes group IDs for connection and pagination and exposes progressive results; it does not expose HTTP URLs, request bodies, subprocess arguments or raw provider responses.

The adapter is the transport abstraction. There is no universal `Transport.request` interface: CLI execution should not pretend to be HTTP. `ProviderHttp` is an implementation dependency of the current HTTP adapters, not a requirement of GitHostingProvider. Core's Providers.ts supplies FetchHttpClient with redirects disabled before constructing the built-ins. The [composition test](../../packages/core/src/pull-requests/Providers.test.ts) exercises normalized GitHub/Azure results and redirect rejection through PullRequests without host HTTP wiring.

Accepted extension point, not implemented: a future `GitHubCli.ts` or `AzureDevOpsCli.ts` constructor can return the same GitHostingProvider, capturing its process runner, executable configuration and authentication strategy at construction. It must decode CLI output, map failures to the shared error vocabulary, redact continuations, preserve cancellation and time bounds, and keep sign-in explicit. CLI-managed authentication need not depend on ProviderAuthentication. CLI processes must use explicit executable/argument arrays without a shell and must not inherit an HTTP bearer-token policy blindly.

Core composition selects exactly one implementation per provider and passes the constructed values to `makePullRequestsLayer(providers)`. Selecting an HTTP or CLI adapter changes no ReviewSession, command or view code. Registering both for the same remote would produce Ambiguous, not automatic transport fallback. Automatic HTTP-to-CLI fallback, user transport settings, CLI adapters and Bitbucket remain unimplemented.

This keeps rat-stack's job-shaped port and captured dependencies. Duff deliberately differs from its strict contracts-only core: [D006](02-decision-log.md#d006-feature-owned-core-and-editor-packages) keeps adapters with their owning features in headless core rather than introducing another package.

## Discovery flow

The extension calls `ReviewSession.selectRepository(directory, { discover })`. The session interrupts old jobs, publishes Inspecting, and runs GitContext inspection. With discovery enabled, it consumes `PullRequests.discover(snapshot)`.

Discovery emits Started with groups and unsupported/ambiguous notices before network results. Equivalent recognized remotes share a group keyed by provider ID, repository authority, and repository key; remote names remain visible. Ambiguous and unsupported remotes make no provider request. Group IDs belong to a discovery generation.

Updated events arrive as groups finish, with at most four concurrent reads and no ordering guarantee. A slow or failed group does not withhold another group's result. Ready carries authentication, one normalized page and hasMore; Failed carries a typed error, not a successful empty list.

Continuation tokens remain private to PullRequests and the adapters. Consumers pass only GroupId to `loadMore` or `connect`. Repeated continuations fail explicitly; adapters validate repository/session bindings. PR identity includes target repository and PR ID, not a branch name alone. Source repository can be unavailable; revisions are optional.

## Session transitions and ownership

ReviewSession exposes `current()` and a SubscriptionRef-backed `changes` Stream. Effect FiberMap owns inspection, connection and group page jobs. Selection and clear interrupt owned work; scoped runtime disposal closes its lifetime. Commands do not own separate discovery generations.

Same-repository refresh with discovery retains previous PRs as Refreshing. Started reconciles retained content by stable group key. Success replaces the first page; failure retains previous content as Stale, or shows Failed when no prior content exists. Inspection failure clears the Git-context snapshot and marks retained PRs Stale with pagination disabled. Selecting a different repository, or selecting with discovery disabled, clears PR rows.

Load More appends and deduplicates by target repository and PR ID. Failed pages retain prior PRs. AuthenticationRequired and InvalidContinuation disable continuation; retryable page failures can retain it. Rate-limited page jobs with a supplied delay enter Cooldown. A Ready group can page while another group is discovering. Non-idle group activity suppresses duplicate actions; connection blocks page actions across the session.

Explicit connect cancels other session jobs, connects the chosen group and rediscovers the snapshot on success. Connection failure becomes Failed or Stale. It does not fetch, checkout or mutate provider data.

## Authentication and verification limits

Only explicit GitHub Connect can prompt for editor sign-in, after a broad-permission warning. Silent inspection and discovery never prompt. Git credential configuration does not establish API authentication. GitHub can read public repositories without a session; a rejected session is not retried anonymously. Azure exclusively uses an existing Azure CLI login under [D008](02-decision-log.md#d008-azure-cli-authentication-with-existing-rest-reads). Connect explains and rechecks that login without running login or changing defaults. Tokens remain inside adapters.

The core AzureCliAuthentication service captures the activation environment, invokes PATH-resolved `az` outside the workspace without a shell, disables dynamic extension installation and CLI command-file logging, and decodes the credential with Schema. Numeric `expires_on` is checked against Effect Clock. Credentials are redacted, account is None, and the opaque session identifier is a token digest. The existing REST continuation fingerprint rejects changed tokens. There is no Duff token cache, authentication selector or native Microsoft fallback.

Acquisition has a 12-second timeout, caller interruption, and a combined 1 MiB output bound, matching Node's default execFile buffer budget rather than assuming a token length. POSIX process groups cover the CLI wrapper and Python descendant. Windows only signals the direct child and remains unqualified. Errors expose finite reasons, never stdout, stderr or raw exceptions. Azure CLI may refresh its own cache; Duff does not control every internal CLI side effect.

The extension subscribes to changes and sends group IDs from native rows. Refresh performs a fresh manual inspection; editor-session changes clear and reinspect. `duff.automaticDiscovery` controls background reads, not explicit Check Pull Requests.

Executed deterministic tests cover the new capability/session boundaries, including paging during progressive discovery and interruption on failed connection. Native supplied-service verification exercises the real session, commands and views on gbfm: progressive groups, paging, retained Refreshing/Stale content, full error hover text and clearing PRs on repository replacement. This is not evidence of real API reads or native sign-in. See the [delivery log](../implementation-log.md#2026-10-10-core-owned-pull-requests-and-review-session). Polling, persistent provider caches and third-party plugin distribution remain outside this cutover.

## Immutable PR preparation

[PullRequests.resolve](../../packages/core/src/pull-requests/PullRequests.ts) owns provider routing and fresh metadata. GitHub pins `head.sha` and `base.sha`; Azure pins available `lastMergeSourceCommit.commitId` and `lastMergeTargetCommit.commitId`. Missing exact revisions fail, never fall back to HEAD or provider merge commits. Source and target remotes are matched independently by provider repository identity. Missing fork remotes do not prevent local-object review, but prevent acquisition until configured outside Duff.

[BranchReview.prepare](../../packages/core/src/review/BranchReview.ts) checks both commit objects before comparing. Missing objects return FetchRequired under local-only permission. The native explicit fetch command shows consent, then resumes the already pinned revision, not another API read. Git remote names, destinations and branch refs are checked. Fetch allows only HTTPS/SSH, disables hooks, tags, pruning, FETCH_HEAD, remote-tracking refmaps, submodules and automatic maintenance. It writes at most `refs/duff/reviews/source` and `target`. Raw-SHA acquisition can fall back to the named branch, whose resulting commit must equal the pinned SHA. A moved branch fails with an explicit refresh instruction. Existing Git credentials/SSH are used; API tokens are never forwarded to Git. Unsupported/missing remotes and Git authentication failures give safe actionable messages.

Comparison computes all common ancestors of the exact target/source commits and requires one. Unrelated or shallow history fails without global unshallow; criss-cross ambiguity fails without arbitrary selection. Diff and content reads use immutable commit IDs, with external diff/textconv and lazy fetch disabled. Git runs without a shell, strips inherited repository-redirection variables, bounds combined output to 16 MiB and time to 60 seconds. POSIX cancellation kills the process group and awaits close. Windows direct-child cleanup remains unqualified.

[PullRequestReview](../../packages/core/src/review/PullRequestReview.ts) owns Preparing, AwaitingFetch, Failed and Idle activity plus the last accepted snapshot. Its FiberMap interrupts superseded work before a replacement starts. Repository changes clear accepted state and cancel preparation; stale root requests are ignored. Failure/cancel leave the accepted review intact. Refresh PR Review explicitly resolves new metadata. Exit restores a prior local comparison when it belongs to the selected repository. The native UI shows PR title/id, source/target, preparation state and existing viewed progress. Browser opening is secondary. Current-checkout file opening warns about revision differences. No polling, auto-checkout, worktree creation, provider write, credential change or review history is introduced.
