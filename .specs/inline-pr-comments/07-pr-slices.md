# PR delivery slices: Inline PR comments

Status: proposed execution plan, not committed/pushed/merged delivery. The owner requested Sol 6.1 separated implementation tasks, stacked PRs and final `@code-review` across **all** work, including the existing agent. No implementation was performed by this spec task.

## Stack base and ownership

Upstream dependency D0 is [PR #22](https://github.com/planetaryescape/duff/pull/22), branch `feat/azure-pr-statistics-refresh`. The previous owner explicitly handed off all work. Commit `845d23b` contains that delivery; `eca34db` fixes the independently reproduced cached Azure continuation bug. The implementation worktree at `/Users/guidefari/source/oss/worktrees/duff/inline-pr-comments`, branch `feat/inline-pr-comments`, was rebased onto `eca34db` before implementation. D0 remains an open PR, not merged main.

```text
main
  -> D0 existing dashboard/details/statistics/auth work, reviewed upstream PR(s)
    -> C1 qualified immutable discussion reads + visibility
      -> C2 durable adjacent drafts + explicit create/reply
        -> C3 resolution/reopen + integrated qualification
```

Three PRs deliver vertical capabilities, not “all types” then “all providers” then UI. Each has both core/provider and extension/UI contributions. Use two Sol 6.1 tasks with disjoint ownership from [05](05-file-map.md), coordinated by the parent. Task identity/model selection is the parent's responsibility. This spec cannot spawn those tasks or publish PRs itself. Do not stage/commit another task's work, add co-authors, bypass checks or auto-merge.

Integration update, 2026-10-26: the two implementation tasks delivered C1-C3 together against their shared contracts. Keep these as acceptance slices, but publish the integrated comments feature in one dependent PR above D0 rather than manufacture intermediate commits with partial runtime/store APIs. The resulting GitHub stack is D0 dashboard work followed by the comments feature. Each PR must pass its complete checks independently; neither is automatically merged.

## C1: Discussion reads on the exact immutable diff

Delivered behavior:

- Both built-in providers load bounded thread/comment data for an accepted PR review; exact supported anchors render natively and everything else has an explicit unplaced reason/provider-page path.
- Qualified SnapshotDocument prevents cross-PR, cross-side and empty-placeholder URI aliasing; legacy tabs remain readable/navigable but cannot host comments or create targets.
- Shown by default, one toolbar toggle, resolved threads initially collapsed, explicit refresh and loading/stale/limited states; local review remains usable on network failure.
- Workspace-backed visibility survives reload in normal separate managed review workspaces. **Duplicate same-workspace windows do not have independently guaranteed remembered visibility.** Parent surfaces this known requirement gap, not a false completion claim.
- No mutating commands or composer exposed yet. Native controller `canReply=false` and no commentingRangeProvider.

Contracts/files: read/domain/routing/URI/visibility parts of [03](03-contracts.md); activation/render/toggle flows in [04](04-flows.md); core Discussion/Placement/provider read modules and extension SnapshotDocument/Comments/View/Visibility plus readers/runtime/manifest in [05](05-file-map.md).

Boundary: this is the smallest useful first slice and needs no draft database. It must not depend on unimplemented writes to render or on provider auth to navigate code. Core task supplies read contract/adapters while UI task can use that same contract with a recording provider, then integrate before PR readiness.

Gate: [06 Slice 1](06-test-plan.md#slice-1-read-the-right-discussion-beside-the-right-immutable-code), required repo checks, native qualified-URI display/toggle verification, and packaging smoke after manifest changes. Broader outdated placement, legacy Azure anchors, GitHub left creation and exact duplicate-window persistence remain explicitly deferred/limited, not silently implemented by guesses.

## C2: Durable native drafts and explicit posting

Delivered behavior:

- New Thread snapshot-selection context action and Reply in Draft Editor thread-title action open a writable adjacent Markdown document bound to the exact original destination.
- Real host-local draft store, ordered autosave through document.save/writeFile, acknowledged-text recovery after full restart, explicit Discard and Return to Diff.
- Single-line creation on the documented supported sides: GitHub current-head/right only; Azure exact matched iteration/head or base. Unsupported locations reject before dispatch without retargeting or truncating.
- Provider REST create/reply and durable attempts, prepared/dispatching/confirmed/rejected/uncertain outcomes; no automatic retries/replay or body-matching deduplication. Confirmed success deletes only the unchanged sent version.
- Visible save failures/conflicts/uncertainty with explicit recovery. New writes from any window respect a durable unresolved-target reservation.

Contracts/files: draft/attempt/provider write/transport/consumer contracts in [03](03-contracts.md), save/send/recovery flows in [04](04-flows.md), Drafts/Discussions/write adapters and extension DraftStore/DraftEditor/Commands/Error/runtime wiring in [05](05-file-map.md).

Before creating the new `discussion.sqlite` schema, parent follows the owner's database-change confirmation policy. No migration/alteration of existing catalog/review databases or repository files. Adjacent composition is agent-selected under the owner's instruction to proceed after the open composer question; it must be called out in PR description, not rewritten as explicitly owner-confirmed.

Gate: [06 Slice 2](06-test-plan.md#slice-2-a-saved-draft-survives-restart-without-duplicate-posting), deterministic race/crash tests, real SQLite restart/CAS tests, native full-close recovery and save/send evidence, complete VSIX smoke. Unsupported historical/GitHub left anchors remain readable as unplaced discussion, not secretly moved. Live provider writes are only exercised with permission on disposable PRs; otherwise report that qualification limit.

Deferred to C3: Resolve/Reopen actions and the final provider-status/security/review sweep. C2 remains useful for reading and posting without these actions.

## C3: Resolution, reopening and full-stack qualification

Delivered behavior:

- GitHub GraphQL Resolve/Reopen and Azure fixed/active PATCH actions on the right originating thread, with fresh permissions/state checks and preserved provider status detail.
- Uncertain state mutations retain recovery evidence and are never automatically replayed; another review switch cannot retarget the action.
- Final limits/error/security/native-accessibility review, packaged artifact verification and evidence-backed docs reflecting what actually works and what remains limited.
- Parent completes `@code-review` across D0+C1+C2+C3 and both Sol tasks, including existing dashboard changes, not only the newest diff. Fix findings and rerun affected checks.

Contracts/files: resolution parts of 03/04/05, [06 Slice 3](06-test-plan.md#slice-3-resolve-reopen-and-finish-provider-parity), plus parent-owned blueprint/decision/plan/log updates. Keep the scope bounded: no edit/delete/reactions, review approval/submission, workspace inline comments, range creation, historical inference, polling or infrastructure.

Gate: all required repo checks, package/install smoke, native screenshots and explicit live-provider verification status. Independent duplicate-window visibility remains a disclosed product limitation until the owner accepts it or a supported qualified implementation closes it. Do not mark the entire owner-confirmed feature complete while silently retaining that gap.

## Review and merge order

1. Parent records actual D0 PR/commit references and reviews existing agent output before basing dependent PRs on it. D0 is not labelled merged without evidence.
2. Stack each comments PR against its immediate parent and state that dependency in the body. Restacking must preserve unrelated user work and public contract tests.
3. Every PR stays buildable/usable independently; do not expose commands for a later slice as failing stubs. Contract exports may grow with slices, but no fake production provider/store paths.
4. Two task owners agree on 03's shared names, URI projection and error/receipt semantics before coding. If APIs change, update the spec and both consumers together; never cast through the disagreement.
5. Parent coordinates Plannotator/spec review outside this task and the final code review. Spec checkpoint waivers authorize drafting all requested layers; they do not establish native or live-provider evidence.
6. PR descriptions list actual checks, screenshots, upstream dependency, agent-selected choices, visibility/anchor limits, and unqualified runtime claims. Keep local edits, committed, pushed, reviewed, merged and released distinct.

## Stop/report conditions

- Native custom snapshot comments cannot render safely after URI qualification, or the writable draft lifecycle cannot meet acknowledged-save recovery: stop that slice and present the observed failure, not a webview/native-input substitution.
- A provider cannot express the exact selected supported code address: retain draft and return typed unsupported-anchor. No latest-head/iteration fallback.
- Mutation transport/store loses dispatch ambiguity or requires automatic POST retry: do not enable posting until fixed.
- Missing explicit authorization for live provider test writes/new database initialization: report blocked qualification/initialization rather than doing it covertly.
- Owner declines the disclosed workspace-backed visibility approximation: independent per-window persistence becomes a product/API decision gate, not a hidden implementation shortcut.
