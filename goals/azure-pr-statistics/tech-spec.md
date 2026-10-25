# Azure PR statistics and lazy refresh

Status: original technical design supporting the [approved plan](plan.md) and [accepted facts](facts.md), with implemented provider qualification and bounded-content refinement recorded below. See [core handoff](core-handoff.md) and [endpoint evidence](endpoint-evidence.md) for current interfaces and executed checks; native integration has separate ownership.

## Boundaries

| Owner | Responsibility |
| --- | --- |
| ProviderHttp | Authenticated GET and read-only JSON POST transport, status mapping, timeout, cancellation |
| Azure adapter | Wire schemas, iteration and comparison resolution, paging, file-diff requests, completeness checks, aggregation |
| RepositoryDirectory | Provider-neutral calls and repository/PR identity validation |
| DashboardData, new core service | Cached snapshots, freshness decisions, owned refresh jobs, revision-safe publication |
| Dashboard integration | Native events, dashboard lifetime, selection and rendering |

The extension uses declared core exports and its existing managed runtime. It does not inspect provider IDs or call Azure directly.

## Data contracts

These are proposed domain shapes, not committed TypeScript signatures. Encode boundary values with Schema and expected failures through Effect's typed channel.

**PullRequestMetadata:** PR identity, source/target repository identities and immutable revisions, description, and any statistics already supplied by the metadata response. Azure metadata retrieval performs no iteration paging or file-diff requests. GitHub can retain its response-supplied totals.

**ComparisonIdentity:** provider ID, authority, target repository identity, source repository identity, PR ID, target revision, source revision, resolved comparison-base revision, and comparison mode. Azure's iteration ID is provenance for resolving the snapshot, not a substitute for commit IDs.

**ChangeStatistics:** comparison identity, optional complete file count, and line result:

- `Complete`: nonnegative safe-integer additions and deletions.
- `Unavailable`: a fixed reason such as unsupported comparison, incomplete response, binary content, or work limit exceeded.

Authentication failures, rate limits, transport failures, and invalid wire data remain typed failures. The dashboard converts them into display state at the integration boundary. They are not cached as successful zero totals.

Split metadata retrieval from statistics retrieval at the provider/directory seam. A statistics request carries the expected immutable source/target identity. If resolving the iteration yields another snapshot, return a typed comparison-changed result and schedule a fresh metadata pass. Do not mix a new iteration's paths with an old request's revisions.

## Azure algorithm

1. Read selected-PR metadata using the existing CLI-authenticated session.
2. Resolve its latest applicable iteration and full-comparison base/source commits. Confirm correspondence with the metadata revisions.
3. Page `$compareTo=0` changes to completion, retaining original/current paths and file kinds. Reject ambiguous or incomplete pagination.
4. Check the completed-comparison cache once the base is known.
5. Query file-diff blocks for the exact base/source pair and requested paths, using bounded batches and a bounded response size.
6. Match each result to exactly one requested file. Validate counts and completeness before aggregating.
7. Publish only if the selection and expected comparison still match. Retain the completed comparison for subsequent cache hits.

Line aggregation: Add contributes modified count; Delete contributes original count; Edit contributes both; None contributes neither. Reject unknown change types, missing required counts, negative/fractional/unsafe counts, and sum overflow. An empty block list is not by itself proof of zero changes. Binary or omitted file results make aggregate line totals unavailable unless the protocol proves a complete textual count. A verified empty PR comparison can produce zero.

The candidate SDK operation is `getFileDiffs`, a read-only POST with base/target commit IDs and original/current paths. Confirm its deployed route, API version, truncation behavior, binary semantics, and fork support before implementation. Batch and response limits remain unresolved until that check; do not invent service guarantees from SDK types.

## Cache and job ownership

Use Effect's cache facilities where their eviction and lifetime contracts fit, after reading the installed source. Keep completed results separate from request ownership.

| Data | Key | Freshness / retention |
| --- | --- | --- |
| Repository snapshot | Provider, authority, repository, filter | Revalidate after 60 seconds; at most 20 repository entries |
| Selected metadata | Repository and PR identity | Revalidate after 60 seconds; retained within bounded repository snapshots |
| Complete statistics | Full comparison identity | Immutable; retain until eviction, at most 100 comparisons |
| Active request | Operation and selection/comparison key | Shared for concurrent callers; removed on completion/interruption |

Cache only completed numeric statistics and the metadata needed for the dashboard. Never retain credentials or raw diff responses in this cache. No disk persistence is added. Repository snapshots retain loaded pagination and selection for immediate return; bound retained pages/items explicitly during implementation rather than treating an entry-count limit as a byte bound.

The dashboard lifetime owns all requests. Closing it interrupts active work; completed results may survive in the extension runtime. Switching selection interrupts obsolete work. A generation token plus repository, PR, and comparison identity guard every publication. Shared duplicate events join or observe the existing job, rather than cancelling and restarting it.

Repository removal invalidates its snapshots. Relocation invalidates the old identity and starts from the canonical one. Authentication failures stop automatic statistics work and do not mark old data freshly authorized. Reconnection triggers metadata revalidation.

## Refresh transitions

| Event | Action |
| --- | --- |
| Cold dashboard / repo / PR selection | Show loading; fetch metadata, render it, then load selected-only statistics |
| Cached selection, age under 60 seconds | Render immediately; no automatic network call |
| Cached selection, age at least 60 seconds | Retain data with refreshing status; revalidate metadata |
| Dashboard becomes active | Run the shared freshness check for its current repository and PR |
| Editor window regains focus | Same check, only when dashboard is active and in dashboard mode |
| Repository selected or reselected | Restore its cached state, then run the same freshness check |
| Manual Refresh | Bypass metadata age; still reuse complete immutable statistics |
| Unchanged comparison | Reuse totals; update metadata freshness |
| Changed comparison | Stop showing old totals as current; load matching totals |
| Refresh fails | Retain prior data as stale, with a retry action |
| Dashboard hidden / picker active | No focus-triggered refresh or polling |
| Dashboard closes | Interrupt owned work; reject late publications |

Automatic failure retries use the same 60-second minimum interval and honor a later provider retry-after deadline. Manual retry bypasses local freshness, not an active provider rate-limit deadline. There is no periodic timer or eager refresh of all repositories.

## View state

Keep metadata and statistics states independent so a slow count cannot hide the description. Each can be loading, current, refreshing with a retained value, stale with a retained value, or unavailable without a value. State transitions must carry the comparison identity where totals are retained.

Render unavailable totals as a placeholder with an accurate reason. Render refresh failure as stale, not as unsupported-provider text. If metadata proves that revisions changed, old totals must be removed from the current counters or explicitly labelled as a previous comparison. Never combine file count from one comparison with line totals from another.

## Verification

- Provider seam: exact revisions and paths, complete pagination, add/delete/edit/rename blocks, unchanged blocks, empty comparisons, binary/missing/truncated responses, overflow, fork behavior, and snapshot movement.
- HTTP seam: POST body encoding, status mapping, redirects, timeout, cancellation, and no credential leakage.
- Lifecycle seam: controlled clock at the freshness boundary, duplicate events, explicit refresh, failures/retry-after, cancellation, eviction, relocation, and rapid cross-repository switching with identical PR IDs.
- Native callback seam: dashboard activation, active-window focus, repository reselection, hidden/picker suppression, disposal, and retained rendering.
- Regression: GitHub totals, filters/pagination, persisted selections, description rendering, and immutable review opening.
- Delivery: repository check/test/build, clean VSCodium exercise, and separate live Azure qualification as specified in the approved plan.

## Implementation gate

The original first-step gate was the live read-only Azure protocol check. The executed checks now establish the deployed route, selected immutable comparison, and corrected totals described in [endpoint evidence](endpoint-evidence.md). Broader encoding, binary, fork and large-file cases retain the explicit limits recorded there.

## Implemented refinement: ambiguous EOF counting

Live qualification established the file-diff route and exposed a terminal empty-segment discrepancy: one added file had 69 provider segments but 68 physical lines. Raw block arithmetic cannot normalize arbitrary EOF changes. Following explicit owner authorization, the adapter now adds bounded read-only content queries only for added/deleted/EOF-sensitive files. Interior files with a validated unchanged suffix retain the block-only fast path. Metadata and listing remain free of content/diff work.

Content queries use exact common/source commit IDs and original/current paths, the same authenticated transport, and returned path/commit checks. UTF-8 reconstruction must reproduce the declared Git blob hash. This rejects silent truncation and lossy decoding rather than treating a string as proof of complete content. UTF-8, lossless ASCII legacy encodings, and independently verified empty blobs are accepted; binary or unsupported encodings remain unavailable.

The comparison owns at most twenty content reads with a 512-KiB JSON response bound each, 256-KiB decoded side bound, two-MiB total decoded bound and 10,000-line side bound. Added/deleted files use physical line counts. Edited EOF uses the pinned, inspected `diff@9.0.0` library with terminal newline and CRLF/LF differences preserved, max edit length 1,000 and a 25-ms library abort budget. No hand-written diff, per-block subtraction, Git fetch/clone, temp worktree, persisted content, raw-content cache, or content telemetry is introduced. Successful numeric results alone enter the existing completed-comparison cache.

Live application output for the thirteen-file comparison was 158 additions / 176 deletions using one fallback content read. A separate bounded all-file source comparison, verifying twenty-five blob reads and stable revisions, independently returned the same totals. Cache reuse added no content reads or diff POSTs. The earlier raw 159-addition sum is not published. Limits and synthetic-versus-live qualification are explicit in the evidence record.
