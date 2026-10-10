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

Status: implemented through the shared job-shaped seam and native Microsoft authentication; deterministic adapter tests pass. Session integration has native supplied-service verification under S04. Real provider requests and native sign-in remain unverified.
Scope: Azure strategy and its remote/authentication adapter, with the same host UI.
Acceptance: recognize supported HTTPS/SSH remote forms and list active PRs with provider-safe identity and errors.
Checks: Azure-specific fixtures and API seam tests; prove the shared review engine needs no provider conditions.
Local native testing may use the owner's approved `~/source/work/frontend` checkouts; see [Slice 3 and verified candidates](blueprint/plugins/07-pr-slices.md#slice-3-azure-devops-parity-using-the-same-service-and-ui). Preserve their branch, files, and configuration. Authenticated provider API checks still require explicit authorization.

## S06: Open a discovered PR locally

Status: proposed follow-up, not implementation authorization.
Scope: normalize a selected PR into an existing local review; explain unavailable refs without mutating Git.
Acceptance: correctly resolve repository and source/target revisions, including forks, or give an actionable missing-ref result.
Any fetch or worktree acquisition requires a separate design and authorization decision.
