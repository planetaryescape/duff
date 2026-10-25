# Decision log

## D001: Effect and a local fence, without Alchemy

Status: accepted. Date: 2026-10-09.

Chosen: the owner selected rat-stack as the Effect/fence reference and explicitly excluded Alchemy from Duff.
Reason: this is a local extension with no cloud infrastructure.
Alternatives: copying the full rat-stack template would add unrelated packages and deployment concepts.
Consequences: use Bun and VS Code integration boundaries; the current fence is smaller than rat-stack's.
Revisit when: the owner explicitly changes the product's runtime or infrastructure scope.

## D002: Native review entry and editor

Status: accepted. Date: 2026-10-09.

Chosen: the owner requested an Activity Bar entry, changed-file tree or list, diffs, interaction, and real-file access.
Reason: VS Code already supplies the editor, diff navigation, themes, and language tooling.
Alternatives: Explorer-only placement did not match the owner's screenshot; a custom webview would duplicate editor behavior.
Consequences: Duff has its own sidebar; real-file access remains a separate action from historical diffs.
Revisit when: native controls prevent a demonstrated review workflow.

## D003: Effective configuration before provider discovery

Status: accepted, not implemented. Date: 2026-10-09.

Chosen: the owner wants the active name, email, and credential strategy visible before remote PR detection.
Reason: the reviewer needs to understand the repository's active context before provider features are added.
Alternatives: starting with PR discovery would hide identity/authentication ambiguity behind network behavior.
Consequences: configuration inspection is a standalone local slice and does not require a provider login.
Revisit when: the owner changes the delivery order.

## D004: Provider behavior belongs in plugins

Status: superseded by [D007](#d007-job-shaped-capabilities-and-one-review-session). Date: 2026-10-09.

Chosen: the owner wants plugins, starting with GitHub and Azure DevOps, to detect open PRs on remotes.
Reason: provider-specific remote recognition, authentication, and PR APIs should not leak into the local review engine.
Alternatives: hard-coded provider conditions inside VS Code callbacks would couple UI and transport.
Consequences: share provider-neutral values and job-shaped contracts; each plugin owns its provider adapter.
Revisit when: a provider cannot satisfy the shared contract without losing important meaning.

## D005: Trusted built-in registry for the first plugins

Status: superseded by [D007](#d007-job-shaped-capabilities-and-one-review-session). Date: 2026-10-09.

Chosen: the owner confirmed trusted built-in plugins. Define a plugin contract and compose GitHub/Azure implementations inside Duff.
Reason: it establishes plugin boundaries without immediately designing packaging, third-party trust, or extension-to-extension APIs.
Alternatives: separately installed VS Code extensions provide stronger distribution independence but need API-version and lifetime contracts.
Consequences: plugins are replaceable modules bundled with Duff, not arbitrary scripts loaded from repository configuration. No dynamic loader, separate plugin runtime, or distribution-version negotiation is needed for the first interface. In-process plugins are trusted code, not sandboxed code.
Revisit when: the owner requires independently installed plugins or third-party distribution.

## D006: Feature-owned core and editor packages

Status: accepted. Date: 2026-10-09.

Chosen: two Bun workspace packages, headless core and VS Code extension. Core feature modules own their schemas, errors, service contracts, Git implementation Layers, and nearby tests. Extension feature folders own native views and command registration. The entrypoint selects Layers and owns one runtime.
Reason: the owner rejected a contracts/core, Git-adapter, extension split because it scattered each small feature across technical packages. OpenCode v2 provides a reference for cohesive feature modules and a runtime-capable core.
Alternatives: a separate Git package would add navigation and manifests without an independently useful responsibility. Separate schema/error files for each small service would add more names without hiding complexity.
Consequences: core permits Node-based local Git adapters but prohibits VS Code and extension imports. Package exports remain explicit. Provider plugins are not implemented by this reorganization.
Revisit when: an adapter needs independent distribution, a second host requires a platform-neutral package, or a feature grows enough to justify private internal modules.

## D007: Job-shaped capabilities and one review session

Status: accepted by the owner; implemented and verified locally. Date: 2026-10-10.

Chosen: one GitHostingProvider adapter contract, PullRequests for grouped progressive discovery, and ReviewSession for one selected local repository and owned jobs. GitHub and Azure DevOps remain built in; Bitbucket comes later. This supersedes D004, D005 and the staged plugin design.
Reason: provider protocol differences need an adapter seam, not a generic plugin lifecycle. Session ownership makes cancellation and retained refresh state independent of native rendering.
Alternatives: generic lifecycle, plugin runtime and ordered batch discovery add machinery or delay visible results without serving the current jobs. Alchemy remains excluded by D001.
Consequences: Started/Updated discovery uses bounded unordered concurrency; connect and loadMore target repository groups; continuation state stays private. Refresh retains PRs as Refreshing and failures mark retained results Stale. Core owns the provider implementations, transport composition and tests. The extension supplies native authentication and consumes the session interface. GitHostingProvider is transport-neutral; core can select an HTTP or CLI implementation without changing the session or editor. No generic transport-request wrapper, third-party loader or plugin distribution contract is introduced.
Revisit when: a concrete additional capability or independent distribution requirement cannot fit this boundary.
References: [current contract and inspected owners](04-capabilities-and-review-session.md). Check, 40 tests, packaging and native supplied-service UI verification pass. Real provider requests and native sign-in remain unverified.

## D008: Azure CLI authentication with existing REST reads

Status: accepted by the owner; implemented on the feature branch. Date: 2026-10-15.

Chosen: Azure uses the existing Azure CLI login as its only credential source. Keep the REST adapter, schema validation, pagination and HTTP policy. GitHub keeps native editor authentication. Provider source metadata is available before authentication; verified account identity is optional and never inferred from Git configuration or token claims.
Reason: a read-only Mac probe demonstrated CLI-issued Azure DevOps tokens against the approved repository. The owner chose CLI-only authentication rather than maintaining multiple Azure sign-in paths.
Alternatives: native Microsoft editor authentication is removed from the Azure route; a full `az repos pr` adapter and strategy settings are deferred.
Consequences: users install/sign in to Azure CLI outside Duff. Connect only rechecks. No fallback, account selection, login command or CLI default change is allowed. Token changes invalidate old continuations. The adapter owns bounded acquisition, parsing, expiry, cancellation and safe error translation, not Azure CLI's cache internals.
Revisit when: a concrete tenant or supported platform cannot obtain the required resource token through this path.

## D009: Explicit, current-snapshot viewed progress

Status: accepted by the owner; implemented on the feature branch. Date: 2026-10-15.
PR persistence and update transfer are superseded by [D011](#d011-multiple-local-pr-sessions-with-explicit-forgetting). Local branch comparisons keep this contract.

Chosen: reversible local marks from native file rows and the active immutable diff, with visible icons and overall progress. Opening a diff never marks it. Persist one current snapshot per editor workspace, keyed by exact root, base commit, head commit and changed path.
Reason: review progress must reflect an explicit reviewer decision and must not imply that new revisions have been reviewed.
Alternatives: automatic marking on open, provider viewed APIs, review history and auto-advance are excluded by the requested scope.
Consequences: unchanged refresh, layout changes and selecting the same comparison after reload retain marks. A replacement comparison discards previous marks. Active commands require both immutable diff sides to match the current snapshot, regardless of original/modified focus. Stale rows and tabs cannot mark a different snapshot. No Git mutation or provider write is involved.
Revisit when: the owner requests multi-review history or provider synchronization with an explicit conflict policy.

## D010: Exact PR revisions with consent-gated Git acquisition

Status: accepted by the owner; implemented on the feature branch. Date: 2026-10-15.

Chosen: reread selected PR details behind the provider boundary, pin exact source/target SHAs, and compare their unique common ancestor to source. Reuse native immutable diffs and current-snapshot viewed progress. Local objects need no permission. Missing objects require explicit in-app consent for bounded HTTPS/SSH fetches through identity-matched configured remotes.
Reason: a PR can target a different branch or originate in a fork, so current HEAD and same-name branches cannot establish the reviewed revision. API authentication and Git authentication remain distinct.
Alternatives: synthetic merge commits, implicit fetches, guessed fork URLs, automatic checkout/worktree creation and silent refresh under a reader are excluded. An unmatched fork can still be reviewed when its exact objects already exist locally.
Consequences: at most two Duff-owned refs are updated; moved fallback branches fail exact-SHA verification. Missing/shallow history and ambiguous common ancestors fail actionably. Preparation has owned cancellation and preserves the accepted review on failure/cancel. Explicit refresh creates a new snapshot; exit restores the prior local comparison. No provider writes or owner checkout/index changes occur. This supersedes S06's original no-fetch proposal only for user-consented acquisition.
Revisit when: a supported provider requires another safe revision acquisition strategy or a concrete platform cannot satisfy process ownership.

## D011: Multiple local PR sessions with explicit forgetting

Status: owner-confirmed behavior implemented; storage/retention choices selected within the authorized implementation. Date: 2026-10-15.

Chosen: multiple saved PR sessions, one current snapshot each, automatic restore of the last active review/diff, and viewed-mark transfer only for unchanged full file comparisons. Exit stays inactive; Forget explicitly removes progress. A native picker avoids a second sidebar panel. Workspace-local JSON and Duff-owned Git pins provide offline resume without copied contents or credentials.
Reason: closing the editor or switching PRs must not discard the reviewer's work, and a different diff must never inherit a reviewed claim.
Alternatives: one global mark record loses other PR progress; resolving latest on resume silently changes the review; filename/source-only matching ignores base, rename and mode changes; a revision timeline exceeds the owner's scope. Silent expiry would delete progress without consent.
Consequences: serialized, atomic saves precede acknowledgment. A per-workspace writer lease prevents last-writer-wins loss. Acceptance and deletion journal pin work for recovery; Update/Forget release only obsolete owned refs, with no GC commands. Sessions do not expire automatically, so their reachable Git objects consume space until explicitly forgotten or updated. Multi-root automatic selection and workspace/repository migration are not included. Existing fetch acquisition still uses two bounded refs; session retention adds separate per-session refs and supersedes D010's two-ref limit for accepted-session retention only.
Revisit when: a demonstrated storage-size problem needs an owner-approved retention policy, or the owner requests multi-window sharing, migration or synchronization.
References: [persistent session contract](04-capabilities-and-review-session.md#persistent-pr-review-sessions), [design discussion](../../.specs/pr-review-sessions/PROGRESS.md).

## D012: Review-first UI and past pull requests

Status: owner-confirmed behavior implemented on the feature branch. Date: 2026-10-24.

Chosen: show Changed Files and Pull Requests by default. Reveal Git Diagnostics only through its explicit command. Remove identity, host and authentication metadata rows from the PR list while retaining actionable failures and connection actions. Add Open, Merged and Closed filters for both providers, with Closed meaning closed without merging. Historical PR selection uses the existing exact-revision review and saved-session flow.
Reason: reviewers need to find and read changes, including already-merged work; Git configuration is troubleshooting information, not the review task.
Alternatives: removing local inspection would break remote routing and diagnostics; checkout or a separate worktree is unnecessary for immutable diffs and was explicitly excluded by the owner.
Consequences: startup defaults to Open. Refresh, connection and pagination keep the selected state. Changing state cancels pending jobs and clears old rows rather than labelling another state's results as stale. Provider continuations bind to the selected state. GitHub filters its closed pages into merged and unmerged results, preserving continuation even when a filtered page is empty. Azure maps active/completed/abandoned to Open/Merged/Closed. No checkout, provider write, implicit acquisition or new credential flow is added. Existing revision-availability and deleted-fork limits still apply.
Revisit when: reviewers need a provider-wide search rather than filtering loaded repository pages.

## D013: Repository command center and isolated review windows

Status: owner-confirmed behavior implemented on the feature branch. Date: 2026-10-25.

Chosen: repository-first dashboard; bulk local/remote onboarding from browsable lists; lazy remote-derived collection suggestions; local-only repositories with branch comparison. Each selected PR opens a complete detached checkout at its exact source HEAD in its own editor window. Opening authorizes automatic object acquisition, without another confirmation. Reopening unchanged source/target revisions preserves edits; changed revisions get separate directories.
Reason: reviewers need one entry point across repositories and access to real source and editor tooling, not only virtual changed-file documents. This explicitly supersedes D012's no-checkout constraint for new review windows and D010's consent pause for managed acquisition; original repositories remain unchanged.
Alternatives: a provider-specific dashboard would duplicate orchestration; editor profile storage cannot share between VS Code and VSCodium; sharing one mutable checkout risks overwriting edits. Cloud sync and mandatory setup scripts are outside scope.
Consequences: core owns RepositoryDirectory, RepositoryCatalog and ReviewWorkspaces contracts; provider adapters own repository browsing and clone destinations; extension owns the webview and SQLite storage adapters. OS-user storage is independent of editor profiles but local to the extension host, not cross-machine sync. SQLite transactions merge watchlist updates and reject stale progress writes. Full source does not promise a working AST without language extensions, dependencies and SDKs. Checkouts use independent Git repositories, consume disk per revision, and have no automatic deletion, dependency installation or submodule initialization. Only trusted system/global credential settings cross the managed Git configuration boundary; hooks, filters and templates stay disabled during acquisition/checkout.
Revisit when: measured disk cost warrants a shared object cache, or the owner requests hosted synchronization, cleanup policy or additional providers.
References: [dashboard architecture](01-architecture.md#repository-dashboard-and-managed-reviews), [S10](../implementation-plan.md#s10-repository-dashboard-and-managed-review-windows).
