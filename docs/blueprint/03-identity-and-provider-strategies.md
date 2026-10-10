# Identity and provider strategies

Status: local identity inspection implemented in part; provider plugins accepted, not implemented. Detailed target contracts below remain proposed where noted.

Current inspection shows effective name/email with scope and origin, separate commit author/committer, sanitized fetch remotes, ordered helper declarations, and whether a custom SSH command is configured.
Apple Git can report built-in configuration with scope `unknown`; Duff preserves that scope instead of guessing its precedence.
For conventional HTTP(S) URLs and full HTTP(S) credential patterns, inspection also shows each remote's configured helper chain after resets, configured username, and `useHttpPath`, with provenance. SSH remotes explicitly separate their strategy from HTTP helpers.
Userinfo-bearing remotes, encoded or nonstandard paths, partial credential patterns, user-qualified patterns, and other unsupported patterns produce an explicit unresolved policy. These remain gaps in S03, not inferred effective credentials.
Refresh is explicit. Changing the review clears the context snapshot. No helper is executed and no authentication is attempted.

## 1. Inspect the effective Git context

Input: the repository selected for review, including its worktree and current branch.
Owner: a dedicated local Git-context service and Git CLI adapter, composed by the extension.
Output: safe configuration metadata, sources, and recognized remotes. No provider network request is needed.

Show these as distinct facts:

| Fact | Display contract |
| --- | --- |
| `user.name`, `user.email` | Effective configured values, or explicitly unset |
| Configuration provenance | Origin and scope for relevant values, including conditional includes and worktree configuration |
| Commit identity | Separate effective author/committer identity if environment overrides differ from configured values |
| HTTPS credential strategy | Applicable helper chain, reset entries, configured username, and `useHttpPath` behavior for each remote |
| SSH credential strategy | SSH transport and safely recognized command/agent configuration, without claiming which key will authenticate |
| Provider API identity | Separate status, unknown until established by a provider plugin |

Git name/email describe commit attribution, not a verified GitHub or Azure account.
Likewise, a credential helper or SSH-agent setting does not prove which credential will be used successfully.
There may be several remotes and several accounts. Do not invent one global "active credential".

### Inspection approach

- Query allowlisted keys in the repository context, preserving Git's precedence and conditional includes.
- Evaluate supported URL-specific credential configuration for each remote, not only global configuration. Keep raw URLs private and sanitize the public snapshot.
- Preserve the ordered helper chain; an empty helper value can reset inherited helpers.
- Use Git's effective identity resolution separately from configured name/email when reporting environment overrides.
- Inspect transport metadata without invoking authentication just to discover a username.
- Refresh after repository, branch, worktree, or relevant configuration changes.

Git expands includes and scopes through an allowlisted NUL-delimited configuration query. A stdin-only synthetic config gives each declaration a unique marker key, so Git's URL matcher selects all applicable declarations without collapsing helpers to one most-specific value. Duff folds the selected declarations in original order. Git also parses the configured boolean values.

This differs from directly calling `git config --get-urlmatch credential`: that command selects one most-specific value per key, while the credential subsystem accumulates all matching helpers and applies later scalar values in config order. Unsupported contexts stay unresolved rather than substituting that incorrect shortcut. See [Git's credential configuration](https://github.com/git/git/blob/v2.54.0/credential.c) and [URL matching](https://github.com/git/git/blob/v2.54.0/urlmatch.c).
Do not read every config key into a UI model and try to redact it afterwards.

### Credential safety

- Never display tokens, passwords, private keys, credential-store contents, or HTTP authorization headers.
- Never dump `git credential fill`, arbitrary config, or environment output into the UI, logs, errors, or screenshots.
- Remote URLs can contain userinfo, tokens, and query parameters. Sanitize before storing or displaying metadata.
- Custom helper and SSH commands can contain secrets. Show a safe strategy label, not the raw command string.
- Treat custom host/account identity as unknown unless a configured plugin establishes it.
- Do not run custom helper commands during inspection. Credential execution is a separate, explicit authentication concern.
- Keep email and local config-origin paths local; do not add telemetry for them.

Failures: no repository, invalid config, unavailable Git, or unsupported inspection should be visible typed outcomes.
An unset name is not a failed inspection. Unknown authentication is not a successful login.

## 2. Provider plugin contract

The plugin owns remote recognition, provider authentication, and read-only PR discovery.
The host owns repository selection, plugin selection, refresh/cancellation, and native UI rendering.
The local BranchReview service stays provider-neutral.

The owner confirmed one shared capability contract for GitHub and Azure DevOps. The staged [plugin contracts](plugins/03-contracts.md) define the proposed TypeScript boundary, including repository-bound operations, normalized results, and typed failures. Neither plugin gets its own incompatible public API.

Conceptual public jobs, refined by that contract rather than compiled interfaces here:

- `recognizeRemote`: sanitized remote context → unsupported or a provider-specific repository handle.
- `inspectAuthentication`: repository handle → authenticated account, unauthenticated, or unknown.
- `listOpenPullRequests`: repository handle and explicit discovery scope → normalized page with continuation.

Define inputs, outputs, and expected failures with Effect Schema before adding handlers.
Expose methods through Effect services and provide implementations with Layers.
Authentication values remain inside adapters; only safe account metadata reaches the UI.
Do not build a generic capability-projection framework for one VS Code surface.

Normalized PR values need provider ID, repository identity, PR ID, title, URL, draft state, source/target refs, and source repository identity.
Keep provider IDs scoped to repositories. Branch names alone cannot identify fork-based pull requests.
Where available, preserve immutable source/target revisions so later local review can resolve the intended snapshots.

## 3. GitHub and Azure DevOps strategies

| Plugin | Owns | Must not assume |
| --- | --- | --- |
| GitHub | GitHub remote recognition, API session, repository and fork identities, open PR pages | Git commit email proves the GitHub account; `origin` is always the PR target |
| Azure DevOps | Azure remote recognition, organization/project/repository identity, API session, active PR pages | Git helper identity equals Azure API identity; all remotes use one URL spelling |

HTTPS and SSH recognition need seam fixtures for both providers, including encoded names and malformed URLs.
Custom hosts and SSH aliases need an explicit supported mapping or an unsupported result.
Study each provider's current APIs and authentication tools before implementing either adapter.
No choice of GitHub CLI, Azure CLI, VS Code authentication sessions, or personal tokens is settled here.

## 4. Automatic discovery

Accepted outcome: detect whether supported remotes have open pull requests.
Proposed behavior: after local context inspection, recognize supported remotes and perform cancellable, read-only discovery using an available session.
Do not open login prompts automatically. Offer a connection action when authentication is missing.
Provide a visible refresh action and a way to disable automatic discovery.
Background discovery must not block local branch review.

Distinguish unsupported remote, authentication required, loading, empty successful result, partial results, rate limiting, and failed request.
Show every candidate remote when more than one is supported; never silently select a conflicting provider.
Use paginated reads and preserve the continuation state. Do not treat the first page as proof that no matching PR exists.
Cancel stale work on repository changes and extension deactivation. Do not guess polling intervals before measuring the actual request path.

Opening a discovered PR must not silently fetch, checkout, or modify the worktree.
If required refs are missing locally, explain the missing data and offer a separate authorized acquisition step.

## Acceptance boundary

Configuration inspection must stand alone and be useful before either provider plugin exists.
Plugin tests must distinguish "no open PRs" from authorization failure, network failure, and incomplete pagination.
See the [ordered plan](../implementation-plan.md) and decisions [D003–D005](02-decision-log.md).
