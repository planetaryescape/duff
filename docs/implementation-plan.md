# Implementation plan

## S01: Local branch review

Status: complete for text-file review.
Scope: native Activity Bar sidebar, branch picker, changed files, immutable diffs, real-file access, Effect service and local fence.
Acceptance: select a base and open modified, added, deleted, and renamed files without changing Git state.
Evidence: [2026-10-09 review delivery](implementation-log.md#2026-10-09-local-review-and-development-workflow).

## S02: Development workflow

Status: implemented; full F5 automation not independently exercised.
Scope: Bun watch task, launch configuration, and usage instructions.
Acceptance: F5 starts the background build, source changes rebuild, and manual development-window reload uses the bundle.
Evidence: watcher initial/rebuild output and separate development-host UI exercise; see [log](implementation-log.md).

## S03: Effective Git context

Status: local inspection and conventional HTTP(S) per-remote policy implemented; unsupported credential contexts remain unresolved. Depends on D003.
Scope: local inspection service, safe schemas, identity/configuration view, explicit refresh. No provider network work.
Acceptance: conditional includes and worktree/local/global precedence produce the effective name/email; helper chains and per-remote transport are shown safely.
Unset identity, environment overrides, SSH, custom helpers, multiple remotes, and invalid configuration have distinct truthful outputs.
Current slice shows applicable configured helpers after resets, credential username, and `useHttpPath` for supported URLs. It keeps all helper declarations separately. Userinfo-bearing remotes, encoded/nonstandard paths, and partial/user-qualified credential patterns remain explicit unresolved states, not complete S03 support.
Checks: real temporary Git/config fixtures, secret-canary redaction checks, native UI inspection, and the standard gate.
Docs: update the [strategy contract](blueprint/03-identity-and-provider-strategies.md) and implementation log.

## S04: Pull-request capability and GitHub discovery

Status: adapters and owner-approved capability/session cutover implemented and verified locally. Check, 40 tests, packaging and native supplied-service UI verification pass. Real provider requests and native sign-in remain unverified. Local Git context remains conservative for advanced credential patterns.
Depends on: D007. Current boundary: [capabilities and review session](blueprint/04-capabilities-and-review-session.md). [Plugin progress](blueprint/plugins/PROGRESS.md) is historical.
Scope: one job-shaped adapter contract, grouped progressive PullRequests discovery, ReviewSession job/state ownership, GitHub adapter and native PR list.
Acceptance: recognize supported GitHub remotes; show open PRs, drafts and source/target context; distinguish auth failure, empty results, and pagination.
Automatic discovery is cancellable and does not prompt for login or block local review.
Checks: remote-recognition fixtures, supplied Effect services, provider API seams, progressive grouping and session cancellation/refresh tests. Native verification exercised group-based loadMore, retained Refreshing/Stale rows and repository replacement. Connection interruption/failure is covered through the core service; native sign-in remains unverified. See the [delivery log](implementation-log.md#2026-10-10-core-owned-pull-requests-and-review-session). An authenticated account/repository smoke check remains separately authorized work.
No fetch, checkout, PR mutations, or credential storage in this slice.

## S05: Azure DevOps discovery

Status: implemented through the shared job-shaped seam and CLI-only authentication under D008. Deterministic adapter/subprocess tests pass. Installed-artifact Development Host verification reads active PRs through the existing CLI session; Windows CLI handling and natural token expiry remain unqualified.
Scope: Azure remote/authentication adapter, with the same host UI. No native Microsoft fallback, setting, login command or CLI account/default changes.
Acceptance: recognize supported HTTPS/SSH remote forms and list active PRs with provider-safe identity and errors.
Checks: Azure-specific fixtures and API seam tests; prove the shared review engine needs no provider conditions.
Local native testing may use the owner's approved `~/source/work/frontend` checkouts; see [Slice 3 and verified candidates](blueprint/plugins/07-pr-slices.md#slice-3-azure-devops-parity-using-the-same-service-and-ui). Preserve their branch, files, and configuration. Authenticated provider API checks still require explicit authorization.

## S06: Open a discovered PR locally

Status: implemented on the feature branch under D010. Delivery verification is recorded in the implementation log.
Scope: fresh provider details, exact source/target revisions, matched fork identity, consent-gated bounded acquisition, unique merge-base comparison, native preparation/refresh/exit and existing immutable diffs/viewed progress.
Acceptance: local objects need no permission; missing objects require explicit in-app consent. A moved fallback branch, unavailable source, absent SHA, missing history or ambiguous base fails without replacing the accepted review. Superseded work cannot publish stale results. Checkout, index, tags, FETCH_HEAD and remote-tracking branches remain unchanged.
No worktree acquisition, provider writes, automatic refresh or credential changes are included.

## S07: Viewed progress

Status: implemented and verified locally. Depends on D009.
Scope: explicit mark/unmark actions on native file rows and the active immutable diff; accessible viewed indicators, overall count and one current-snapshot workspace record.
Acceptance: no automatic marking; unchanged refresh, layouts and reload retain matching marks; exact root/base/head/path isolation; added/deleted/renamed files and either diff focus work; stale tabs/items and unrelated editors cannot mark another snapshot.
Evidence: [2026-10-15 viewed progress](implementation-log.md#2026-10-15-explicit-viewed-progress). No provider writes, Git mutation, history or auto-advance.

## S08: Persistent PR review sessions

Status: implemented on the feature branch under D011; not merged. See the [persistent session contract](blueprint/04-capabilities-and-review-session.md#persistent-pr-review-sessions).
Scope: multiple workspace-local PR sessions, offline exact-snapshot resume, automatic last-active/diff restoration in a single-folder workspace, durable viewed marks, unchanged full-comparison transfer, native Resume/Forget and safe Git retention.
Acceptance: switching PRs and reopening preserves separate progress; Exit stays inactive after restart; Update retains only unchanged comparisons; Forget releases only that store/session's pins after durable deletion. Save/preparation failures preserve the prior accepted review, and stale tabs cannot mark another comparison.
Evidence: [persistent session delivery](implementation-log.md#2026-10-15-persistent-pr-review-sessions). No expiry, cross-device sync, revision history, provider writes, implicit acquisition or checkout changes. Multi-root automatic selection and moved-workspace migration remain outside this slice.

## S09: Review-first sidebar and historical PR browsing

Status: implemented on the feature branch under D012; delivery evidence is recorded in the implementation log.
Scope: on-demand Git Diagnostics, PR rows without routine authentication metadata, native Open/Merged/Closed filter, state-bound provider pagination and existing immutable review for historical selections.
Acceptance: both providers distinguish merged from closed without merging; switching filters cancels pending reads and clears old rows; refresh and pagination keep the filter; past PRs open without checkout or worktree creation. Missing revisions retain the existing explicit acquisition consent and typed failures.

## S10: Repository dashboard and managed review windows

Status: implemented on the feature branch under D013; verification and delivery limits are recorded in the implementation log.
Scope: provider-neutral directory/catalog/workspace services, bulk local/remote repository picker, lazy collection suggestions, repository-first full-screen dashboard, host-local cross-editor SQLite storage, automatic pinned downloads and dedicated editable review windows.
Acceptance: add several repositories together; retain local-only entries; browse supported providers without UI provider routing; open historical and current PRs in complete detached checkouts; preserve edits on unchanged reopen and separate new revisions; share watchlist/progress between editor profiles without storing credentials; reject stale progress writes and preserve files on cancellation/failure.
Qualification: real temporary Git and SQLite tests plus installed-artifact Linux VSCodium checks. Windows/macOS native behavior and authenticated Azure discovery remain unqualified. No cloud sync, automatic cleanup, dependency installation, submodules, provider mutations or guaranteed language-server setup.

## S11: Lazy PR statistics and focus refresh

Status: implemented locally under [D015](blueprint/02-decision-log.md#d015-lazy-pr-statistics-and-focus-triggered-refresh); not committed or released. See [delivery evidence](implementation-log.md#2026-10-25-lazy-pr-statistics-and-focus-refresh).
Scope: selected-only Azure line totals, independent metadata loading, bounded revision-keyed in-memory caching, retained refresh/stale state, and shared freshness checks on dashboard/window focus and repository selection.
Acceptance: the [accepted facts](../goals/azure-pr-statistics/facts.md) and [approved plan](../goals/azure-pr-statistics/plan.md) define observable behavior and verification. Live API qualification is distinct from supplied-service tests; partial provider responses must never appear as complete totals.

## S12: Inline PR discussion and durable drafts

Status: implemented and verified locally on `feat/inline-pr-comments`, stacked on [PR #22](https://github.com/planetaryescape/duff/pull/22). Not merged or released.
Scope: existing threads on qualified immutable diffs, native discussion actions, adjacent Markdown composition, durable local drafts, explicit create/reply/resolve/reopen, and a Duff-only visibility toggle. The [layered spec](../.specs/inline-pr-comments/PROGRESS.md) owns the design and qualification requirements.
Acceptance: PR/comparison/side identity prevents comments leaking into another tab; acknowledged drafts survive restart; submissions retain their original destination, preserve newer edits, and never automatically replay an uncertain write. Both provider adapters retain precise placement and capability limits.
Qualification: full checks, 328 application tests plus rule tests, build/package, supplied-service native integration, installed-artifact smoke and combined code review pass. See the [delivery log](implementation-log.md#2026-10-26-inline-pr-discussion-integration) and [review record](inline-discussion-review.md). Live provider writes are not qualified. Workspace-backed visibility does not independently persist preferences for duplicate windows on the same workspace. Adjacent composition is the agent-selected implementation choice for observable autosave.
