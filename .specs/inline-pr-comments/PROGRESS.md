# Inline PR comments: Progress

## Status: Design complete; implementation and combined code review verified locally

- [x] Layer 0: Problem frame (confirmed scope; remaining design questions carried forward)
- [x] Layer 1: Shape (accepted; composition adjustment awaits decision)
- [ ] Layer 2: Alternatives (drafted; adjacent Markdown editor agent-selected, not explicitly owner-confirmed)
- [ ] Layer 3: Contracts (drafted, pending review)
- [ ] Layer 4: Flows (drafted, pending review)
- [ ] Layer 5: File map (drafted, pending review)
- [ ] Layer 6: Test plan (drafted, pending review)
- [ ] Layer 7: PR delivery slices (drafted, pending review)
- [ ] Plannotator review (opened by parent; feedback pending)

Unchecked means not yet confirmed, not unwritten. Owner waived intermediate checkpoints by asking for all remaining layers now. These files are a design proposal, not proof of implementation, merged PRs, runtime qualification or live writes.

## Delivery and known limits

- Spec task owns only `.specs/inline-pr-comments/`; no implementation, staging or Git history changes.
- Core/provider and extension/UI ownership and shared contracts are defined in 03/05. C1 reads/URI isolation, C2 durable drafts/create/reply, C3 resolve/reopen remain acceptance slices; integration consolidates them into one dependent feature PR as recorded in 07.
- Implementation is in `/Users/guidefari/source/oss/worktrees/duff/inline-pr-comments`, branch `feat/inline-pr-comments`, based on PR #22 at `eca34db`. The upstream PR remains open and its hosted checks passed.
- Adjacent writable Markdown drafts and workspace-backed visibility are agent-selected decisions. Duplicate windows of the same workspace cannot be promised independent remembered visibility through workspaceState. This remains an explicit gap against the owner's per-window requirement.
- Initial creation is single-line only: GitHub current-head/right; Azure exact iteration/head or base. Unsupported/outdated/ambiguous locations remain visible but unplaced, with no silent retargeting.
- Native supplied-service checks exercised custom-URI rendering, draft restart recovery, explicit mutations, inactive recovery and uncertain-write reload with zero automatic dispatches. These use local fake providers and isolated SQLite data. Live provider write behavior remains unqualified. Installed-artifact smoke and combined code review passed; all proven findings were independently closed.

## Log

- 2026-10-25: Confirmed scope: read existing inline PR threads, reply, resolve, and easily toggle comments on/off.
- 2026-10-25: Created spec folder and drafted Layer 0 from current documentation and working-tree code. Paused for owner feedback.
- 2026-10-25: Owner added new-thread creation and confirmed immutable diffs as the initial surface for both display and creation. Revised Layer 0; remaining proposals await confirmation.
- 2026-10-25: Owner confirmed Reopen as the inverse of Resolve. Updated Layer 0.
- 2026-10-25: Owner confirmed comments visible by default, a one-click diff-toolbar toggle, per-review-window visibility remembered across reloads, and resolved threads initially collapsed.
- 2026-10-25: Owner confirmed durable drafts across closing/reopening Duff and requested the next layer. Updated Layer 0 and drafted Layer 1; paused for shape review.
- 2026-10-25: Owner accepted Layer 1. Inspected stable/proposed native comments APIs and provider creation documentation; drafted Layer 2 after finding no documented native reply-input autosave event. Paused for composition choice.
- 2026-10-25: Owner requested all remaining layers without checkpoints, then Sol 6.1 separated implementation and stacked PRs with final code review covering existing work. Drafted Layers 3-7; did not mark them owner-confirmed.
- 2026-10-25: Inspected current managed runtime, host-shared SQLite/unmanaged leased JSON storage, Effect 4.0.5 source, provider GraphQL/REST and Azure iteration/tracking/status protocols. Recorded mutation ambiguity and exact-anchor limits.
- 2026-10-25: Incorporated independent native API findings: qualified PR/comparison/logical-path/side Snapshot URIs, legacy decoder without comment authority, no commentingRangeProvider, adjacent writable draft document.save loop, and workspace-backed visibility limitation. Parent coordinates review and implementation.
- 2026-10-26: Documentation-only check passed: all relative Markdown file links resolve and no spec file contains em dashes. Reviewed file ownership and delivery status. No application checks, native-host checks, packaging, authenticated provider writes, staging or commits performed by this task.
- 2026-10-26: Two Sol 6.1 implementation tasks delivered core/provider and native UI/storage code. Added read-only creation preflight, bounded global draft recovery and per-comment publication state during integration. Core review finding on pending comments was fixed and independently verified; extension/persistence review remains pending.
- 2026-10-26: Parent check/build passed. Full test run had one saved-review timeout; all six tests in that file passed in isolation. Full-suite rerun is pending, with no timeout changes or test bypasses.
- 2026-10-26: Final check/test/build/package passed, including 328 application tests and rule tests. Controlled upstream comparison isolated real-Git timeouts to cross-file concurrency; one-worker test scheduling passed three full runs without deadline changes. Final VSIX installed smoke passed. Combined core/extension/upstream review findings are closed; delivery evidence is in docs/implementation-log.md.
