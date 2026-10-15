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
