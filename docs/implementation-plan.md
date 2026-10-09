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

Status: local inspection implemented; per-remote credential selection remains incomplete. Depends on D003.
Scope: local inspection service, safe schemas, identity/configuration view, explicit refresh. No provider network work.
Acceptance: conditional includes and worktree/local/global precedence produce the effective name/email; helper chains and per-remote transport are shown safely.
Unset identity, environment overrides, SSH, custom helpers, multiple remotes, and invalid configuration have distinct truthful outputs.
Current slice shows ordered helper declarations, not an effective per-remote chain. Configured credential username and `useHttpPath` remain unimplemented.
Checks: real temporary Git/config fixtures, secret-canary redaction checks, native UI inspection, and the standard gate.
Docs: update the [strategy contract](blueprint/03-identity-and-provider-strategies.md) and implementation log.

## S04: Plugin seam and GitHub discovery

Status: planned. Depends on verified S03 and a decision on D005/authentication.
Scope: shared provider contract, registry/composition, GitHub strategy, native PR list and discovery states.
Acceptance: recognize supported GitHub remotes; show open PRs, drafts and source/target context; distinguish auth failure, empty results, and pagination.
Automatic discovery is cancellable and does not prompt for login or block local review.
Checks: remote-recognition fixtures, supplied Effect services, provider API seam tests, and an explicitly authorized account/repository smoke check.
No fetch, checkout, PR mutations, or credential storage in this slice.

## S05: Azure DevOps discovery

Status: planned. Depends on S04's proven shared seam and an Azure authentication decision.
Scope: Azure strategy and its remote/authentication adapter, with the same host UI.
Acceptance: recognize supported HTTPS/SSH remote forms and list active PRs with provider-safe identity and errors.
Checks: Azure-specific fixtures and API seam tests; prove the shared review engine needs no provider conditions.

## S06: Open a discovered PR locally

Status: proposed follow-up, not implementation authorization.
Scope: normalize a selected PR into an existing local review; explain unavailable refs without mutating Git.
Acceptance: correctly resolve repository and source/target revisions, including forks, or give an actionable missing-ref result.
Any fetch or worktree acquisition requires a separate design and authorization decision.
