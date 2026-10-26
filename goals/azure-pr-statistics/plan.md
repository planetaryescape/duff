# Lazy Azure PR statistics and focus refresh

Status: owner-approved through Plannotator and implemented locally. The owner accepted [all eight facts](facts.md). This document preserves the planned sequence; [delivery evidence](../../docs/implementation-log.md#2026-10-25-lazy-pr-statistics-and-focus-refresh) records actual implementation, adjustments and qualification limits.

## Approach

Use Duff's existing Azure CLI authentication and provider adapter to query file-level diff blocks. Publish metadata before requesting expensive statistics. Keep a bounded, session-local cache of completed comparisons and a shared freshness policy for dashboard activation and repository selection. Native callbacks remain in the extension; comparison, cache policy, and provider work remain headless in core.

Use 60 seconds for automatic metadata freshness. Manual Refresh bypasses that delay but still reuses successful totals for immutable revisions. Keep the prior result visible while checking freshness, with explicit refreshing/stale status. A known revision change stops old totals being presented as current.

## Inspected baseline

- `packages/core/src/pull-requests/azure-devops/AzureCliAuthentication.ts` already obtains scoped Azure access tokens through `az account get-access-token`.
- `packages/core/src/pull-requests/azure-devops/AzureDevOpsHttp.ts` pages iteration changes for file count, waits for that count before returning details, and always returns absent line totals. Its iteration schema currently retains only iteration IDs.
- `packages/core/src/pull-requests/ProviderHttp.ts` supports GET only, with typed status failures, a timeout, and manual redirect handling.
- Microsoft's [GitApi.getFileDiffs](https://github.com/microsoft/azure-devops-node-api/blob/master/api/GitApi.ts) uses POST and resource ID `c4c5a7e6-e9f3-4730-a92b-84baacff694b`. The inspected SDK uses `7.2-preview.1`; the deployed server's supported version and route still need verification.
- Its [GitInterfaces](https://github.com/microsoft/azure-devops-node-api/blob/master/api/interfaces/GitInterfaces.ts) defines base/target commit IDs, original/current file paths, and line blocks with None/Add/Delete/Edit change types and original/modified counts. SDK source confirms the candidate protocol, not live server behavior or completeness.
- `RepositoryDirectory.ts` owns provider-neutral calls and repository identity checks. Bound adapters are retained, but details/statistics have no result cache.
- `DashboardCommands.ts` clears rows/details on refresh and repository selection. Window focus refreshes the catalog; there is no dashboard activation callback. Its selected-PR pagination recovery calls full details, which would accidentally fetch expensive statistics unless separated.
- `DashboardState.ts` has Idle/Loading/Loaded/Failed detail states and generation protection, but no retained refreshing/stale result. `DashboardHtml.ts` attributes absent totals to provider unavailability regardless of actual loading/failure state.

## Ordered implementation

### 1. Verify Azure's comparison contract

Use the existing CLI session against one accessible PR, without printing tokens or saving private response bodies. Discover the supported file-diff route/version through Azure resource metadata or a pinned SDK source, then make a read-only query. Record only sanitized response shape, status, comparison semantics, and aggregate counts.

Confirm that the latest iteration's common/base commit and source commit produce the full PR comparison represented by `$compareTo=0`. Do not substitute target HEAD, synthetic merge commits, or branch names. Check original paths for rename/delete requests and source-repository identity for forks. Detect a revision/iteration change during discovery rather than combining file paths and blocks from different snapshots.

Verify additions, deletions, edits, unchanged blocks, missing blocks, binary behavior, response truncation, and endpoint batching constraints. Compare a known text diff with independently known totals or local `git diff --numstat` when the exact objects already exist. Do not fetch or clone merely to populate dashboard statistics.

Verification: one live read-only protocol smoke check plus sanitized synthetic fixtures. If no accessible PR or complete supported response is available, report that blocker before claiming Azure totals are delivered. Do not substitute an unverified private browser endpoint.

### 2. Separate metadata from optional statistics

Touch `GitHostingProvider.ts`, `RepositoryDirectory.ts`, both provider adapters, and their supplied-service fixtures/tests.

Add a provider-neutral selected-PR statistics operation and schema carrying the exact comparison identity. Keep metadata/description retrieval fast and independently usable. Adapt existing combined details consumers deliberately so existing GitHub totals and review resolution keep working. The dashboard's selected-PR recovery path must retrieve metadata without triggering statistics.

The Azure adapter owns iteration selection, complete paginated changed paths, exact base/source revisions, and line-block aggregation. Add a nearby Azure statistics module if needed to keep `AzureDevOpsHttp.ts` readable. Count modified lines as both deleted original lines and added modified lines; ignore unchanged blocks. Validate nonnegative safe integers and sum overflow. Reject mismatched, duplicate, omitted, or partial file results. A verified empty comparison may be zero; unsupported/binary/partial data must remain unavailable rather than masquerading as zero. File count may remain available when line totals are not.

Add JSON POST support to `ProviderHttp.ts` using the same status mapping, redirect refusal, cancellation, and timeout policy as GET. The only new use is the read-only diff query. Decode responses with Schema in the adapter. Bound batch sizes, total work, and response sizes using step 1 evidence; exceeding a budget yields unavailable statistics, not a partial total. Preserve rate-limit retry hints.

Verification: transport tests for POST body, authentication header handling, redirect refusal, status failures, invalid JSON, timeout/interruption; Azure tests for exact revisions, paging, edit/add/delete/rename blocks, binary/partial responses, fork limitations, empty comparison, overflow, and concurrent revision movement. Retain GitHub and directory contract tests. Request-count assertions prove that PR listing and metadata reads do not fetch Azure diff blocks.

### 3. Add a bounded dashboard data lifecycle

Add a focused core dashboard service/module, proposed `packages/core/src/dashboard/DashboardData.ts`, with a public package export. Compose it once in the existing extension runtime. Keep the existing directory as the provider boundary rather than putting UI freshness rules into adapters.

Own completed statistics keyed by provider/authority, source and target repository identities, PR ID, and exact comparison revisions. Include comparison mode/version if it changes semantics. Keep completed values separate from active jobs. Retain bounded repository/filter snapshots and the last selected PR so returning to a repository can paint cached data immediately. Start with an explicit 100-comparison and 20-repository cache bound, using least-recently-used eviction; these are memory-policy defaults, not Azure service limits.

One refresh path handles selection, dashboard focus, window focus, and explicit refresh. Metadata age and immutable statistics are separate: after 60 seconds check metadata, but reuse matching successful totals indefinitely until eviction. Track failed attempts separately, honor provider retry-after delays for automatic requests, and permit explicit retries. Share concurrent work for the same key instead of launching duplicates. Do not persist tokens, paths, descriptions, or diff bodies as part of this cache.

Give active work an explicit dashboard lifetime. Switching selections cancels obsolete selection work, and generation/repository/PR/comparison guards reject late results. Completed cache entries can survive panel closure within the extension session; active jobs cannot. Removing or relocating repositories invalidates affected cache associations. Reconnection must not reuse inaccessible cached data as freshly authorized results.

Verification: Effect-aware tests with a controlled clock and supplied directory/provider. Cover cold load, instant cached return, 59/60-second boundary, unchanged revisions, target-only/source-only changes, retry after failure, explicit refresh, duplicate focus events, cache eviction, repository/filter isolation, relocation/removal, same PR numbers across repositories, cancellation, and disposal. Use deferred synchronization for races rather than sleeps.

Before implementation, load the coding standards and Effect skills and inspect the installed Effect 4.0.5 AGENTS.md and source for the chosen cache/clock/fiber APIs. Preserve the one-runtime boundary and named operations.

### 4. Wire native focus and retained rendering

Touch `DashboardCommands.ts`, `DashboardState.ts`, `DashboardHtml.ts`, associated tests, and the composition root. Extract the new lifecycle/controller glue into a small dashboard module rather than expanding the existing command file substantially.

- Subscribe to panel view-state changes and refresh only when it becomes active.
- On editor-window focus, refresh only if the dashboard panel is active and in dashboard mode.
- Route repository selection and reselection through the same freshness path. Keyboard movement among buttons alone does not fetch.
- Route PR selection through cached metadata and selected-only statistics loading.
- Keep catalog refresh and preference persistence intact. Distinguish background refresh from a destructive reset.
- Render description independently of statistics. Show loading, refreshing, stale, and unavailable states accurately. Preserve cached data through failures, but clear or label totals from a known old comparison.
- Keep manual Refresh, pagination, filters, restored dashboard tabs, and review-window mode working. Rapid switching and delayed replies must never publish another repository's result.

Verification: state/HTML tests for retained data and status labels; integration-level callback tests that drive panel activation, window focus, repository reselection, hidden/picker states, and panel disposal. Prove multiple focus events cause one provider request. Check that repository switching restores the correct PR/filter selection without changing persisted preference contracts.

### 5. Verify and record delivery

Run focused application suites while implementing, then the repository gate once the slice is complete:

```sh
bun run test:app
bun run check
bun run test
bun run build
```

Use `bun run format` and `bun run lint:fix` as needed. Rule tests require Node 22.18+. Run `bun run package` and an installed-artifact smoke check if packaging changes are required.

Exercise one clean VSCodium development host using separate user-data/extensions directories and `~/source/oss/gbfm`, preserving its Git state. Verify cold load, return to dashboard, repository switching/reselection, cached totals, manual refresh, delayed responses, and unavailable/stale rendering. Use supplied-service fixtures for deterministic failures; separately qualify live Azure requests. Preserve screenshots where available and do not close the owner's working windows.

Update `docs/blueprint/01-architecture.md`, add the accepted refresh/cache decision in `02-decision-log.md`, link this slice from `docs/implementation-plan.md`, and append observed checks and limits to `docs/implementation-log.md`. Mark implementation and live-provider verification separately. No commit, installation into the owner's main profile, or release is implicit.

## Risks and unresolved evidence

- Azure's file-diff route is preview and must be qualified on the actual service. SDK types alone do not prove complete binary, large-file, or fork support.
- Full-PR merge-base semantics must match the iteration file list. Correct-looking totals from the wrong base are unacceptable.
- Adding POST changes supplied transport contracts in Azure, GitHub, authentication, and directory tests; update all callers without weakening their assertions.
- The current optional-statistics path discards errors with `Effect.option`; the new workflow needs enough typed outcome information for retry/stale UI. Do not hide defects as successful empty statistics.
- Preserving data during refresh changes reset behavior. Existing pagination, repository relocation, preference restoration, and selection guards need regression coverage.
- Live endpoint access may be unavailable. Automated fixture tests are necessary but do not replace that evidence.

## Done

All [accepted facts](facts.md) have implementation and verification evidence. Azure totals are proven against the verified comparison contract; focus/repository refresh is lazy and cached; standard gates pass; native evidence and remaining qualification limits are recorded.
