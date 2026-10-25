# File map: Inline PR comments

Status: proposed paths, not delivered files. Maps [03 contracts](03-contracts.md) and [04 flows](04-flows.md) onto the current feature-owned architecture. No packages or files are deleted. Shared integration files are edited by one owner at a time.

## Core/provider task owns

Paths below are relative to `packages/core/`.

| File | Add/change and responsibility |
| --- | --- |
| `src/pull-requests/Discussion.ts` | Add domain Schemas, DiscussionKey/ThreadKey, anchors, snapshot, typed read/write outcomes and provider discussion job contract. No VS Code. |
| `src/review/DiscussionPlacement.ts` | Add exact comparison/file/side/content guards and pure placement decisions; call existing BranchReview for immutable content and object evidence. |
| `src/review/DiscussionDrafts.ts` | Add versioned Draft/Attempt schemas, legal transitions and DiscussionDraftStore port; no SQLite imports. |
| `src/review/Discussions.ts` | Add consumer Context.Service/Layer, read generations, explicit commands, save/send/state workflows and recovery reservations. |
| `src/pull-requests/GitHostingProvider.ts` | Add explicit optional discussion capability on bound repository; preserve existing metadata/statistics/discovery behavior. |
| `src/pull-requests/PullRequests.ts` | Add stable-selection discussion routing independent of discovery GroupId; reuse canonical repository recognition. |
| `src/pull-requests/Providers.ts` | Wire built-in discussion implementations using existing auth/HTTP layers. Export no second provider registry. |
| `src/pull-requests/ProviderHttp.ts` | Add distinct bounded, no-redirect/no-retry mutation transport with dispatch-aware results. Preserve `post` query semantics from upstream dashboard work. |
| `src/pull-requests/github/GitHubDiscussion.ts` | Add adapter-private GraphQL queries/resolution mutations, REST create/reply, dual pagination and exact current-anchor qualification. |
| `src/pull-requests/github/GitHubHttp.ts` | Construct/capture discussion adapter with existing credential/repository policy; keep source-specific tokens private. |
| `src/pull-requests/azure-devops/AzureDiscussion.ts` | Add thread reads, iteration/change evidence, create/reply/PATCH mapping and conservative legacy/tracking treatment. |
| `src/pull-requests/azure-devops/AzureDevOpsHttp.ts` | Bind Azure discussion jobs into the recognized repository using existing Azure auth. |
| `package.json` | Add explicit exports `./discussion`, `./discussion-drafts`, `./discussions`, `./discussion-placement` for extension consumers; no relative core-source imports. |

Do not place provider-specific wire fields in the shared public thread model. Keep request/response Schemas local to each provider adapter. Shared scalar types belong with the feature, not a catch-all utility module. A dedicated GraphQL code generator is not required for these small operations: bounded decoded query DTOs fit the current HTTP boundary and avoid an unrelated toolchain migration.

## Extension/UI task owns

Paths below are relative to `packages/extension/`.

| File | Add/change and responsibility |
| --- | --- |
| `src/review/SnapshotDocument.ts` | Add sole URI envelope builder/decoder, qualified-vs-legacy authority, deterministic PR/change/side identity. |
| `src/review/ReviewView.ts` | Route snapshot URI building through shared helper; preserve content Snapshot semantics. |
| `src/review/ReviewCommands.ts` | Update **both** diff openings, active-file/content/workspace readers, and pass accepted prepared review to small discussion registration. Keep UI implementation out of this already large file. |
| `src/review/SnapshotNavigation.ts` | Decode legacy/qualified envelopes through same helper before workspace navigation; never grant legacy tabs comment targets. |
| `src/review/DiscussionCommands.ts` | Add command/binding decoding, accepted review bridge, toolbar/context/thread-title actions and explicit destination confirmation. |
| `src/review/DiscussionComments.ts` | Add native controller/thread projection over qualified immutable URIs; no commentingRangeProvider, no built-in reply box. |
| `src/review/DiscussionView.ts` | Add native TreeDataProvider for unplaced threads, limited/stale states, durable drafts and unresolved attempts. Reuse existing Activity Bar container. |
| `src/review/DiscussionDraftEditor.ts` | Add writable FileSystemProvider and owned per-draft document.save loop; exact-version acknowledgment, flush/close/conflict handling. |
| `src/review/DiscussionDraftStore.ts` | Add private host-local `discussion.sqlite` adapter implementing core port with SQLite CAS/transactions, version codecs and bounded paging. Does not modify existing stores. |
| `src/review/DiscussionVisibility.ts` | Add workspaceState preference adapter, default shown, await writes; document duplicate-workspace-window limitation. |
| `src/review/DiscussionError.ts` | Add safe user messages for storage, permission, limits, failed and uncertain writes; do not reuse generic “Refresh to retry” for mutation uncertainty. |
| `src/extension.ts` | Supply data directory/ID allocator/store at activation; compose Discussions into the **one** managed runtime; register/dispose UI and FS provider. Coordinate with dashboard upstream changes. |
| `src/Operations.ts` | Extend CommandRuntime/service requirements; preserve existing operations, integrate typed discussion errors without treating interruption as proof of not sent. |
| `src/telemetry/Telemetry.ts` | Add finite discussion operation names/outcomes if required; no new content fields/exporter. |
| `package.json` | Register commands, native discussion view, editor toolbar toggle and snapshot-selection/thread-title/draft editor actions with narrow when clauses. Keep manifest host API compatibility truthful. |

No changes to `SnapshotPosition.workspaceLine` are needed: it remains workspace navigation, not comment anchor evidence. No database changes to `SharedReviewStore`, `SavedReviewStore`, RepositoryStore, managed checkout metadata, or repository Git configuration are part of this feature.

## Tests and runtime evidence

| Proposed file/path | Owning task and coverage |
| --- | --- |
| `packages/core/src/review/DiscussionPlacement.test.ts` | Core: real Git snapshots, sides, rename/add/delete, mismatching revisions, no heuristic fallback. |
| `packages/core/src/review/DiscussionDrafts.test.ts` | Core: legal state transitions, persisted DTO invariants and newer-version preservation. |
| `packages/core/src/review/Discussions.test.ts` | Core: supplied provider/store seams, late reads, explicit writes, recovery and interruption. |
| `packages/core/src/pull-requests/github/GitHubDiscussion.test.ts` | Core: real adapter through supplied HTTP seam, nested paging, exact request bodies, permissions and uncertain outcomes. |
| `packages/core/src/pull-requests/azure-devops/AzureDiscussion.test.ts` | Core: exact iteration triples/tracking, status vocabulary, offsets, pagination and write bodies. |
| `packages/core/src/pull-requests/ProviderHttpMutation.test.ts` | Core: transport streaming/status/redirect/timeouts/no-retry behavior; retain upstream query POST tests. |
| `packages/extension/src/review/SnapshotDocument.test.ts` | UI: URI aliases, deterministic identity, malicious/mismatching envelope, legacy read-only behavior. |
| `packages/extension/src/review/DiscussionDraftStore.test.ts` | UI: real SQLite/temp directories, cross-instance CAS/reservations, restart and corruption. |
| `packages/extension/src/review/DiscussionVisibility.test.ts` | UI: default, save failure, reload restoration and documented shared-key semantics. |
| `packages/extension/src/review/DiscussionDraftEditor.test.ts` | UI: extract testable document/save coordinator, supplied seam; real host still required for document lifecycle. |
| `packages/extension/src/review/DiscussionComments.test.ts` | UI: pure projection/binding behavior through an intentional native host seam, not a patched vscode module. |
| implementation evidence in `docs/implementation-log.md` | Parent/integrator records actual checks, screenshots and provider test-PR results; never claim design-time reads prove runtime behavior. |

Parent owns integration documentation updates (`docs/blueprint/00-overview.md`, architecture, decision log, relevant capability contract and implementation plan/log). These updates must distinguish accepted scope, agent-selected UX/limits, implementation state and evidence. This spec-only task does not touch those shared files.

## Two-task handoff and no-overlap rule

Core/provider task owns all `packages/core` feature edits/tests and freezes the exports/signatures from 03 first, then implements a vertical adapter/service behavior. Extension/UI task owns `packages/extension` including storage adapter, manifest/runtime and native qualification. Both import the exact shared contracts; neither invents another Draft/ThreadKey model. Core can use a supplied in-memory store seam while UI implements the real SQLite adapter; UI can use a supplied ProviderDiscussion seam while provider work proceeds. Those are test seams, not alternative production paths.

Integrate one PR slice at a time per [07](07-pr-slices.md). A parent coordinates only shared stack base, exports and cross-package runtime composition. Contract changes require both tasks to agree before implementation; update 03 rather than chasing compile errors with casts. No task stages another task's files, rewrites dashboard work, bypasses hooks, or auto-merges PRs.
