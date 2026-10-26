# Contracts: Inline PR comments

Status: implementation proposal, 2026-10-25. Owner-confirmed scope is in [00](00-problem.md). The owner requested completion of all layers without intermediate checkpoints. Adjacent Markdown composition is an **agent-selected working decision**, not an explicit owner confirmation. No implementation or authenticated provider writes were performed for this spec.

## Evidence and limits

Inspected local TypeScript, Effect 4.0.5 `AGENTS.md` and `src/{Effect,Schema,FiberMap,Semaphore,SubscriptionRef}.ts`, and the installed `@types/vscode/index.d.ts`. Independent native API inspection reports installed types 1.120 and manifest `^1.123.0`; inspect the implementation worktree's actual pins rather than assuming the canonical working copy's package range is the installed API version. Use `Schema.Struct`, `Schema.TaggedStruct`, `Schema.TaggedError`, `Schema.decodeUnknownEffect`, `Context.Service`, named `Effect.fn`, scoped `FiberMap`, `SubscriptionRef`, and `Semaphore`. These APIs exist in the installed source. The sketches below are proposed TypeScript contracts, not copied implementation or a compiled API promise. Every persisted/wire type needs a matching Schema and invariant checks.

Provider sources inspected:

- [GitHub GraphQL pull-request reference](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread---object): `reviewThreads` and each thread's `comments` are separate connections. Thread IDs are GraphQL node IDs. `viewerCanReply`, `viewerCanResolve`, `viewerCanUnresolve`, `isResolved`, `isOutdated`, `diffSide`, current/original lines and root comment `commit`/`originalCommit` are available. `resolveReviewThread` and `unresolveReviewThread` take `threadId`; `clientMutationId` is correlation, **not documented deduplication**.
- [GitHub REST review comments](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request): create takes `body`, `commit_id`, `path`, `line`, `side`; optional `start_line`/`start_side` support ranges. Reply endpoint requires the **top-level** review-comment ID, not a reply ID. REST does not supply thread resolution state. GraphQL creation does not take a commit OID, so use REST for revision-pinned creation, not a pending review mutation. Do not create or submit a pending review.
- Azure 7.1 [threads list](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1), [create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1), [update](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/update?view=azure-devops-rest-7.1), and [comment create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1): list returns an envelope with `value`; no documented thread-list pagination parameters. Reply posts `content`, `parentCommentId`, `commentType: 1`; up to 500 comments per thread. State changes PATCH the thread with `status` only.
- Azure [iterations](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1) expose `sourceRefCommit`, `targetRefCommit`, `commonRefCommit`. [Iteration changes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1) take `$top`, `$skip`, `$compareTo`; follow `nextSkip`/`nextTop`. `$compareTo=0` means common commit. In a **thread context**, equal `firstComparingIteration` and `secondComparingIteration` means the left side is the common commit. Do not confuse that with the changes endpoint's zero convention.
- Azure thread `changeTrackingId` comes from the iteration change entry and is required for iteration-enabled PRs. `trackingCriteria` distinguishes original and tracked positions. `CommentPosition.line` starts at 1 and documented `offset` starts at 0, despite older examples using 1. Initial creation is whole-line only with offset 0; qualify this in a real test PR before claiming production support.
- [Stable native API](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts): writable `FileSystemProvider`, `onDidChangeTextDocument`, comment state/collapse, `canReply`, and thread-title menu contributions are available. There is no stable unsent-comment-input event/setter. No proposed APIs are allowed.

Public documentation is protocol evidence, not evidence of live permissions, stable custom-URI rendering, Azure tracking behavior, or installed-artifact success. Those are [test gates](06-test-plan.md).

## Shared domain boundary

Reuse `RepositoryIdentity`, `ComparisonIdentity`, `PullRequestSelection`, `Commit`, `GitPath`, `Review`, `FileComparison`, and `Snapshot` where they fit. Do not broaden existing Git schemas as unrelated cleanup. New scalar schemas additionally require safe integers and exact SHA lengths.

```ts
import { Context, Effect, Layer, Option, Schema, Stream } from 'effect'

const ThreadId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionThreadId'))
type ThreadId = Schema.Schema.Type<typeof ThreadId>
const DraftId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionDraftId'))
type DraftId = Schema.Schema.Type<typeof DraftId>
const AttemptId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionAttemptId'))
type AttemptId = Schema.Schema.Type<typeof AttemptId>
const LineNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
type LineNumber = Schema.Schema.Type<typeof LineNumber>

interface DiscussionKey {
  readonly providerId: string
  readonly repository: RepositoryIdentity
  readonly pullRequestId: string
}
interface ThreadKey {
  readonly discussion: DiscussionKey
  readonly id: ThreadId
}
interface LineRange {
  readonly start: LineNumber
  readonly end: LineNumber
}
type Side = 'base' | 'head'
interface CodeAnchor {
  readonly comparison: ComparisonIdentity
  readonly change: FileChange
  readonly side: Side
  readonly path: GitPath
  readonly commit: Commit
  readonly range: LineRange
}
interface DiscussionReview {
  readonly key: DiscussionKey
  readonly selection: PullRequestSelection
  readonly comparison: ComparisonIdentity
  readonly review: Review
}
type DraftTarget =
  | { readonly _tag: 'NewThread'; readonly anchor: CodeAnchor }
  | { readonly _tag: 'Reply'; readonly thread: ThreadKey }
```

`CodeAnchor` construction verifies key/comparison equality, `start <= end`, exact accepted base/head, and the selected file/side exists. Base rename uses `previousPath`, head uses `path`; added/deleted empty sides cannot be anchors. Core rereads immutable content to check bounds and reject binary/non-text, symlink and submodule targets. Native coordinates are zero-based and end-exclusive; conversion to inclusive one-based lines excludes the next line when `selection.end.character === 0`. No text-search or workspace-line heuristic is permitted. `SnapshotPosition.workspaceLine` is navigation-only and must not be reused.

`DiscussionKey` uses provider + authority + canonical target-repository key + PR ID, never local root or display labels. A draft also records its originating root for Return to Diff, but that root is not its remote identity. Repositories are routed through the existing provider selection, not a user-supplied URL. New UUID IDs come from one supplied ID allocator at the runtime/storage seam, deterministic in tests.

## Threads, placement and capabilities

```ts
type Resolution =
  | { readonly _tag: 'Open'; readonly detail: 'active' | 'pending' | 'unresolved' }
  | { readonly _tag: 'Resolved'; readonly detail: 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'resolved' }
  | { readonly _tag: 'Unknown' }
type Availability =
  | { readonly _tag: 'Allowed' }
  | { readonly _tag: 'CheckOnSend' }
  | { readonly _tag: 'Unavailable'; readonly reason: 'permission' | 'unsupported' | 'deleted' | 'read-only' }
interface DiscussionComment {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly publication: 'pending' | 'published'
  readonly publishedAt: string
  readonly deleted: boolean
}
type AnchorEvidence =
  | { readonly _tag: 'Exact'; readonly anchor: CodeAnchor; readonly outdated: boolean }
  | { readonly _tag: 'Unplaced'; readonly reason: PlacementReason }
type PlacementReason =
  | 'file-level' | 'outdated' | 'different-comparison' | 'missing-revision'
  | 'missing-path' | 'ambiguous-rename' | 'unsupported-range' | 'invalid-location'
  | 'unsupported-content' | 'legacy-azure-context'
interface DiscussionThread {
  readonly key: ThreadKey
  readonly comments: ReadonlyArray<DiscussionComment>
  readonly commentsComplete: boolean
  readonly resolution: Resolution
  readonly anchor: AnchorEvidence
  readonly reply: Availability
  readonly resolve: Availability
  readonly reopen: Availability
  readonly providerPage: Option.Option<string>
}
type Completeness =
  | { readonly _tag: 'Complete' }
  | { readonly _tag: 'Limited'; readonly reason: 'threads' | 'comments' | 'bytes' | 'requests' | 'iterations' | 'changes' }
interface DiscussionSnapshot {
  readonly key: DiscussionKey
  readonly threads: ReadonlyArray<DiscussionThread>
  readonly completeness: Completeness
}
type DiscussionState =
  | { readonly _tag: 'Inactive' }
  | { readonly _tag: 'Loading'; readonly review: DiscussionReview }
  | { readonly _tag: 'Ready'; readonly review: DiscussionReview; readonly snapshot: DiscussionSnapshot }
  | { readonly _tag: 'Refreshing'; readonly review: DiscussionReview; readonly snapshot: DiscussionSnapshot }
  | { readonly _tag: 'Stale'; readonly review: DiscussionReview; readonly snapshot: DiscussionSnapshot; readonly error: DiscussionReadError }
  | { readonly _tag: 'Failed'; readonly review: DiscussionReview; readonly error: DiscussionReadError }
```

No raw provider anchor bags cross into UI. Adapters retain their thread/root-comment ID relationship internally and reconstruct it on demand after restart. Root REST IDs are decimal strings; do not coerce a GitHub BigInt ID through an unsafe JavaScript number. Nullable/deleted authors get an inert label. Unknown Azure status is not resolved. `pending` remains open with its detail shown; Resolve writes `fixed`, Reopen writes `active`, without rewriting other statuses merely by loading. Already resolved `wontFix`/`byDesign` remain truthful, not relabelled fixed. Unknown status disables state mutation until a supported fresh read.

### Exact placement and creation guards

The bounded target is **single-line new threads**, with same-side range reads supported when proven. Cross-side spans and file-level threads stay accessible in the native discussion list, not attached to a guessed line. Multi-line creation is deferred, not silently truncated.

| Provider | Read placement | New-thread creation |
| --- | --- | --- |
| GitHub | First supported path: current, non-outdated thread coordinates with fetched PR head/target equal to the displayed source/target; local unique merge base equals the displayed base. Require metadata before/after the read to agree. Both sides map through the actual changed-file entry; refuse ambiguous renames. Outdated/original anchors remain unplaced unless a later evidence-backed path proves them. | Initial support is **head-side single line only**, exact `commit_id = displayed head`, with current pair matching at preflight. Reject old saved comparisons before dispatch and preserve drafts. REST cannot atomically pin the target side or compare-and-set PR head. Do not offer base-side creation as if preflight solved that race. |
| Azure | Match an iteration's exact source/target/common commit triple to the displayed comparison. Request threads tracked into that explicit iteration; accept coordinates only with matching tracked context or matching original context, correct path and change-tracking entry. Equal iteration IDs represent the common/head diff. Do not read latest tracked lines into an older saved diff. | Head/base single line using the proven iteration triple and `changeTrackingId`; equal first/second iteration IDs for merge-base comparison. Never substitute latest iteration. Older saved comparison may create only when that exact retained iteration context is still accepted. Legacy/non-matching contexts remain read-only/unplaced. |

For GitHub the guaranteed creation address is the exact right-side blob/path/line, **not an atomic frozen comparison pair**. A target/head move after preflight can make the thread outdated; it must not move the code coordinate. Verify returned `original_commit_id`, path, side and original line. If the result contradicts the submitted location, retain a provider receipt and show a placement warning; never issue a corrective duplicate automatically. This protocol limit is an explicit agent-selected restriction. Broader GitHub anchoring needs new evidence, not an implementer's guess.

Adapters may return fewer placed threads than the provider has, but must retain those threads in `Unplaced`, with a visible reason. A partial result must never say “No comments.” Provider-page links are validated HTTPS, matched to the recognized provider authority, and opened only on an explicit action.

## Provider and routing jobs

Add `discussion: Option.Option<ProviderDiscussion>` to `ProviderRepository`; built-ins supply it, supplied test/unsupported adapters can explicitly supply None. Keep authentication and routing in `PullRequests`/`Providers`; no second registry or token source.

```ts
interface ProviderDiscussion {
  readonly read: (review: DiscussionReview) => Effect.Effect<DiscussionSnapshot, DiscussionReadError>
  readonly checkCreate: (review: DiscussionReview, anchor: CodeAnchor) => Effect.Effect<void, DiscussionWriteRejected>
  readonly create: (input: CreateThreadInput) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
  readonly reply: (input: ReplyInput) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
  readonly setResolution: (input: ResolutionInput) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
}
interface CreateThreadInput {
  readonly attempt: AttemptId
  readonly review: DiscussionReview
  readonly anchor: CodeAnchor
  readonly body: string
}
interface ReplyInput {
  readonly attempt: AttemptId
  readonly thread: ThreadKey
  readonly body: string
}
interface ResolutionInput {
  readonly attempt: AttemptId
  readonly thread: ThreadKey
  readonly desired: 'resolved' | 'open'
  readonly expected: Resolution
}
type ProviderReceipt =
  | { readonly _tag: 'Comment'; readonly commentId: string; readonly thread: Option.Option<ThreadKey>; readonly providerPage: Option.Option<string>; readonly placement: 'verified' | 'unverified' }
  | { readonly _tag: 'Resolution'; readonly thread: ThreadKey; readonly resolution: Resolution }
```

Proposed `PullRequests.discussion(selection)` returns a captured `ProviderDiscussion` or typed unsupported/routing failure, using the same canonical repository resolution as existing `resolve`. It must not require a current discovery GroupId: restart/offline drafts and saved reviews can outlive discovery. Bind and check `ThreadKey` on every operation, including GraphQL node reads; do not assume a valid node belongs to the expected PR.

Implementation correction, 2026-10-26: `checkCreate` is a read-only provider preflight before opening a new-thread draft. It establishes supported anchor/current comparison or iteration evidence without posting. `create` repeats this check before dispatch. Consumers must not use a mutation to probe whether composition is supported.

`ProviderHttp.get/post` currently collapse failures into `DiscoveryError` and do not preserve dispatch ambiguity; `post` is also used for GraphQL **queries** in upstream dashboard work. Do not change all POST semantics to mutations. Add a distinct provider-private `mutate` job in `ProviderHttp`:

```ts
interface MutationRequest {
  readonly method: 'POST' | 'PATCH'
  readonly url: string
  readonly token: Option.Option<Redacted.Redacted>
  readonly body: Schema.Json
  readonly headers: Readonly<Record<string, string>>
}
type MutationHttpResult =
  | { readonly _tag: 'Received'; readonly status: number; readonly body: unknown; readonly headers: Readonly<Record<string, string>> }
  | { readonly _tag: 'Uncertain'; readonly reason: 'transport' | 'timeout' | 'body-limit' | 'response-decode' }
```

`mutate(request): Effect.Effect<MutationHttpResult>` constructs only adapter-owned URLs, never follows redirects, never retries, bounds response streaming and wait time. A 2xx undecodable/over-limit body is uncertain, not rejected. Known 401/403/404/422/429 can be translated to finite rejection reasons; 408/5xx after dispatch are uncertain. Redirects are rejected without following but should conservatively be uncertain if the origin might have acted. GraphQL HTTP 200 can contain errors and partial data: only a decoded matching mutation receipt proves success; a known authorization/validation failure with no execution can prove rejection, otherwise uncertain. Raw messages never reach errors or telemetry.

## Error boundary

```ts
type DiscussionReadError = DiscoveryError | DiscussionUnsupported | DiscussionLimitExceeded
class DiscussionUnsupported extends Schema.TaggedError<DiscussionUnsupported>()('DiscussionUnsupported', {}) {}
class DiscussionLimitExceeded extends Schema.TaggedError<DiscussionLimitExceeded>()('DiscussionLimitExceeded', {}) {}
class DiscussionWriteRejected extends Schema.TaggedError<DiscussionWriteRejected>()('DiscussionWriteRejected', {
  reason: Schema.Literals(['authentication', 'permission', 'missing-thread', 'unsupported-anchor', 'comparison-changed', 'invalid-body', 'rate-limited', 'conflict']),
}) {}
class DiscussionWriteUncertain extends Schema.TaggedError<DiscussionWriteUncertain>()('DiscussionWriteUncertain', {
  reason: Schema.Literals(['transport', 'timeout', 'interrupted', 'invalid-response']),
}) {}
type DiscussionWriteError = DiscussionWriteRejected | DiscussionWriteUncertain
class DraftStorageError extends Schema.TaggedError<DraftStorageError>()('DraftStorageError', {
  reason: Schema.Literals(['unavailable', 'busy', 'invalid', 'conflict', 'write-failed', 'limit']),
}) {}
class DiscussionCommandRejected extends Schema.TaggedError<DiscussionCommandRejected>()('DiscussionCommandRejected', {
  reason: Schema.Literals(['inactive', 'stale-command', 'busy', 'unsaved', 'uncertain-attempt', 'invalid-anchor', 'invalid-body']),
}) {}
```

Pre-dispatch auth, routing, or read failures are mapped to known not-sent failures. A provider write error's meaning is about **this attempt**, not a blanket conclusion from an HTTP class. Core persists uncertainty before publishing it. Interruption remains Effect interruption during reads; the write owner uses a finalizer/recovery record to represent a possibly dispatched write. Do not hide defects as empty discussion.

## Draft and attempt storage

Actual local ownership today:

- `extension.ts` creates one `ManagedRuntime` and disposes it on deactivation. Discussion must join it, not create a second runtime.
- Unmanaged saved reviews use `context.storageUri/reviews.json` through `SavedReviewStore`, with lease, atomic rename, file sync, and a workspace-root-dependent identity.
- Managed reviews use `SharedReviewStore`, one `reviews-<checkout-digest>.sqlite` under `dashboardDataDirectory`, with SQLite transactions and optimistic revision checks. The data directory is host/OS-user scoped, independent of editor profiles.
- Neither existing store contains drafts. Workspace review identity cannot be reused as remote draft identity.

Agent-selected storage: a **separate** `discussion.sqlite` under the existing supplied host-local data directory, implemented in the extension adapter using the already shipped `node:sqlite` seam. No change to existing review/catalog databases or repository files. Core owns persistence contracts and transitions. This new file/schema is design only; implementation must follow the owner's database-change confirmation policy before initialization.

```ts
interface Draft {
  readonly id: DraftId
  readonly key: DiscussionKey
  readonly target: DraftTarget
  readonly origin: DiscussionReview
  readonly version: number
  readonly body: string
}
interface AttemptIntent {
  readonly id: AttemptId
  readonly key: DiscussionKey
  readonly input:
    | { readonly _tag: 'Draft'; readonly draft: Draft }
    | { readonly _tag: 'Resolution'; readonly command: ResolutionInput }
}
type Attempt =
  | { readonly _tag: 'Prepared'; readonly intent: AttemptIntent }
  | { readonly _tag: 'Dispatching'; readonly intent: AttemptIntent }
  | { readonly _tag: 'Uncertain'; readonly intent: AttemptIntent }
  | { readonly _tag: 'Rejected'; readonly intent: AttemptIntent; readonly reason: DiscussionWriteRejected['reason'] }
  | { readonly _tag: 'Confirmed'; readonly intent: AttemptIntent; readonly receipt: ProviderReceipt }
interface DraftPage {
  readonly drafts: ReadonlyArray<Draft>
  readonly attempts: ReadonlyArray<Attempt>
  readonly next: Option.Option<string>
}
interface DraftRecoveryPage {
  readonly drafts: ReadonlyArray<Draft>
  readonly attempts: ReadonlyArray<Extract<Attempt, { readonly _tag: 'Prepared' | 'Dispatching' | 'Uncertain' }>>
  readonly next: Option.Option<string>
}
interface DiscussionDraftStore {
  readonly list: (key: DiscussionKey, cursor: Option.Option<string>) => Effect.Effect<DraftPage, DraftStorageError>
  readonly listAll: (cursor: Option.Option<string>) => Effect.Effect<DraftRecoveryPage, DraftStorageError>
  readonly get: (id: DraftId) => Effect.Effect<Option.Option<Draft>, DraftStorageError>
  readonly create: (draft: Draft) => Effect.Effect<Draft, DraftStorageError>
  readonly save: (input: { readonly id: DraftId; readonly expectedVersion: number; readonly body: string }) => Effect.Effect<Draft, DraftStorageError>
  readonly discard: (input: { readonly id: DraftId; readonly expectedVersion: number }) => Effect.Effect<void, DraftStorageError>
  readonly prepare: (intent: AttemptIntent) => Effect.Effect<Attempt, DraftStorageError>
  readonly dispatch: (id: AttemptId) => Effect.Effect<Attempt, DraftStorageError>
  readonly finish: (attempt: Attempt) => Effect.Effect<void, DraftStorageError>
  readonly getAttempt: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, DraftStorageError>
  readonly acknowledgeUncertain: (id: AttemptId) => Effect.Effect<void, DraftStorageError>
}
```

`DiscussionDraftStore` becomes a `Context.Service` with this interface. SQLite projection: schema version 1; `drafts(id PRIMARY KEY, discussion_key, revision, payload_json)` and `attempts(id PRIMARY KEY, discussion_key, target_key, phase, payload_json)` with indexes for PR paging and a unique unresolved-attempt target reservation. Payload JSON includes versioned DTO envelopes `{ version: 1, value }`, encoded/decoded through Schema JSON codecs. No tokens, remote cached thread bodies or arbitrary files. Submitted body is retained only while recovery needs it. CAS on draft revision is transactional; conflicts never overwrite the other window. `prepare` atomically checks the sent draft version and reserves the target; `dispatch` requires Prepared. `finish` atomically stores the receipt and removes **only an unchanged submitted draft version**. Newer text survives. Confirmed attempts can be reduced to minimal receipts, deleting submitted body. Prepared on restart is safely not dispatched by contract, but still requires an explicit new Send. Dispatching is treated as uncertain on read and cannot be replayed. Do not globally rewrite live Dispatching rows during another window's startup.

An unresolved attempt blocks another send/state change for that draft/thread across windows. No lock held over network. “Acknowledge uncertainty” is an explicit warning confirmation that releases the reservation while retaining the historical receipt; it is **not** evidence of rejection. Only then may another explicit Send create a new attempt. No automatic expiry, replay, body-text deduplication, hidden HTML markers, or guessed reconciliation. If a known remote ID was received, read that exact ID; absence from a bounded list is not proof nothing posted.

Storage durability acknowledgment follows transaction commit with SQLite `synchronous=FULL` and private file/directory permissions, using the safety checks established by `SharedReviewStore`. Busy writes fail visibly; there is no in-memory “success” fallback. Corrupt/unknown schema is preserved and blocks writes. CAS spans processes, not just fibers. Draft body max 64 KiB UTF-8, empty allowed for drafts but whitespace-only forbidden for Send. Do not truncate oversized text. List pages are 100 records, local bodies are loaded lazily, and deletion is explicit. No age eviction of drafts or uncertain attempts. Closed draft tabs are not discard. Forget Review does not delete discussion drafts.

## Consumer service and UI seam

### Snapshot URI identity must change before inline display

Independent native API inspection found that current `ReviewView.snapshotUri` encodes only `Snapshot { root, commit, path }`. Two PRs, opposite diff sides, and absent-file placeholders can therefore alias a native URI. Native comments belong to a URI, so checking only the current review in a callback does not prevent cross-PR display leakage.

Use one shared extension decoder with this proposed query envelope:

```ts
type SnapshotDocument =
  | { readonly _tag: 'Legacy'; readonly snapshot: Snapshot }
  | {
      readonly _tag: 'PrReview'
      readonly version: 1
      readonly snapshot: Snapshot
      readonly discussion: DiscussionKey
      readonly comparison: ComparisonIdentity
      readonly logicalPath: GitPath
      readonly side: Side
    }
```

The deterministic PR URI encodes canonical provider/repository/PR identity, full source/target/base comparison, logical changed-file path and side, plus the actual content `Snapshot`. Identical envelopes encode identically, including property order; opposite sides and different PRs encode differently even when their content snapshot is identical/absent. Do not include titles, author identities, random IDs or tokens. Source root is local lookup authority, not remote PR identity. Check all redundant fields agree before accepting the envelope. Content reads use only its decoded Snapshot through `BranchReview.read`; absent content stays empty, but its URI is still PR/change/side-qualified. Comment targets additionally require the envelope to equal the active accepted review and logical file/side. Legacy tabs remain readable/navigable, but have **no comment or creation authority**; offer reopening the current qualified diff.

Update both diff-opening paths in `ReviewCommands`, active-file detection, content provider, workspace-file readers and `SnapshotNavigation` through the shared decoder. Never let a parser that only understands the old bare Snapshot discard the PR qualification. Plain local branch comparisons retain legacy content behavior with comments disabled. The decoder belongs in extension, not VS Code types in core.

```ts
interface DraftState {
  readonly draft: Draft
  readonly save: 'saved' | 'saving' | 'failed' | 'conflict'
}
interface DiscussionsService {
  readonly changes: Stream.Stream<DiscussionState>
  readonly current: () => Effect.Effect<DiscussionState>
  readonly activate: (review: Option.Option<DiscussionReview>) => Effect.Effect<void>
  readonly refresh: () => Effect.Effect<void>
  readonly drafts: (key: DiscussionKey, cursor: Option.Option<string>) => Effect.Effect<DraftPage, DraftStorageError>
  readonly allDrafts: (cursor: Option.Option<string>) => Effect.Effect<DraftRecoveryPage, DraftStorageError>
  readonly draft: (id: DraftId) => Effect.Effect<Option.Option<Draft>, DraftStorageError>
  readonly start: (review: DiscussionReview, anchor: CodeAnchor) => Effect.Effect<Draft, DraftStorageError | DiscussionCommandRejected>
  readonly startReply: (thread: ThreadKey) => Effect.Effect<Draft, DraftStorageError | DiscussionCommandRejected>
  readonly save: (input: { readonly id: DraftId; readonly expectedVersion: number; readonly body: string }) => Effect.Effect<Draft, DraftStorageError>
  readonly discard: (input: { readonly id: DraftId; readonly expectedVersion: number }) => Effect.Effect<void, DraftStorageError>
  readonly send: (input: { readonly id: DraftId; readonly expectedVersion: number }) => Effect.Effect<Attempt, DraftStorageError | DiscussionCommandRejected>
  readonly setResolution: (input: { readonly thread: ThreadKey; readonly expected: Resolution; readonly desired: 'resolved' | 'open' }) => Effect.Effect<Attempt, DraftStorageError | DiscussionCommandRejected>
  readonly attempt: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, DraftStorageError>
  readonly acknowledgeUncertain: (id: AttemptId) => Effect.Effect<void, DraftStorageError>
}
```

`Discussions` is a core `Context.Service`; Layer captures provider routing, Git review, store and ID allocation. Provider writes publish Rejected/Uncertain/Confirmed as attempt values, not thrown framework errors. `send` waits for a bounded owned operation; review switches cancel reads, not an already dispatched write. Runtime disposal may interrupt network, but the durable Dispatching record remains. The native callback observes the outcome and only refreshes visible comments when the original review/generation still matches. Draft completions are addressed by draft ID even if another PR is active.

Extension-only contracts:

```ts
interface DraftDocumentBinding {
  readonly uri: vscode.Uri
  readonly draftId: DraftId
  readonly documentVersion: number
  readonly persistedVersion: number
}
interface DiscussionUi {
  readonly accept: (review: Option.Option<DiscussionReview>) => Promise<void>
  readonly dispose: () => void
}
interface VisibilityPreference {
  readonly read: () => Effect.Effect<'shown' | 'hidden', DraftStorageError>
  readonly write: (value: 'shown' | 'hidden') => Effect.Effect<void, DraftStorageError>
}
```

Use a writable `duff-draft:/<draft-uuid>.md` file-system provider backed by the store, not a read-only content provider, workspace source file, or `untitled` editor with no binding. URI carries only opaque ID. Reject unknown IDs, directories, rename and arbitrary create/delete requests; Discard goes through core. The provider implements required stable methods; `readFile/stat` return durable content/metadata and `writeFile` enters the same save lane as document changes. Map typed storage errors to native file-system errors at this seam only.

`onDidChangeTextDocument` starts a per-draft owned serialized `document.save()` loop; `FileSystemProvider.writeFile` delegates the exact saved bytes to the durable core save. Do not run a second independent event-to-store path. Observe version and text before/after save, acknowledge a document version only when those exact bytes committed, and loop again if newer edits arrived. Coalesce only unsaved intermediate bodies; one in-flight save plus newest body is sufficient. Show Saving until the newest body is committed. On failure/conflict retain text in the editor, disable Send, and offer explicit save retry or recovery copy. A storage conflict requires loading/reconciling the latest version, never blind overwrite. The caller owns its ordered editor lane; the store still enforces cross-process CAS. Ctrl-S joins the same lane, not an independent stale write. All callbacks are owned by the existing runtime/awaited promises. Do not emit external-file-change events against a dirty buffer to overwrite it.

Display destination in tab/title/status and Send confirmation: provider/repository/PR, new-thread path/side/line and pinned commit, or reply thread. Body contains only the comment text. Send flushes the current buffer before taking its draft version; Discard asks before deleting nonempty text. Initial safety policy: first Send after a review switch shows destination confirmation. Hiding comments may leave the draft editor open; it never sends/discards.

Native threads set `canReply = false` and offer **Reply in Draft Editor** via thread-title command; do not leave a second non-durable inline composer enabled. Do not install a `commentingRangeProvider`, which would expose the uncapturable native composer. New Thread comes from an explicit Duff snapshot-selection context action, not native gutter input. Thread menus expose Resolve/Reopen according to availability. Resolved instances begin collapsed; refresh existing instances by stable thread key without repeatedly overriding the user's expansion choice. Hide disposes inline thread instances, not the controller's durable state or drafts; show reconstructs them. An unplaced native tree/list under review shows all unplaced discussion and recovered drafts, with reasons and safe provider links. No extra webview.

### Visibility persistence and a known requirement gap

`workspaceState` is workspace-scoped, not documented window-scoped; managed `SharedReviewStore` is deliberately shared across windows/profiles. Neither can alone prove the owner-confirmed per-window preference. Stable `vscode.env.sessionId` is documented as changing when the editor starts, not as a reload-stable window ID. Do not infer the missing guarantee from its name or use an undocumented `VSCODE_WINDOW_ID` variable.

Practical agent-selected first implementation: `context.workspaceState` key `discussionVisibility.v1`, decoded `{ version: 1, visibility: 'shown' | 'hidden' }`, default shown. Runtime visibility is local to the open window and changes only on its explicit toggle, not on cross-window storage notifications; each toggle awaits persistence before claiming it is remembered. Reload restores the workspace-backed last saved value. Separate managed checkouts have separate workspace state. **Duplicate windows of the same workspace can overwrite the remembered choice, so independent per-window reload persistence is not guaranteed.** This is an explicit limitation against the owner-confirmed requirement, not a claim that workspace and window mean the same thing. Parent must surface this limitation for review/acceptance; do not secretly depend on sessionId or undocumented host internals. Full-close visibility survival is not required. Draft IDs/storage are independent and survive full restart regardless of this limitation.

## Read budgets

These are proposed Duff work limits, not provider maxima. Define one policy value consumed by adapters and tests, not scattered literals:

- 20 seconds per HTTP request, bounded body streaming at 4 MiB, no automatic retries or polling.
- 100 total requests and 60 seconds for one discussion refresh; at most four concurrent read requests. Final metadata consistency reads count against this budget.
- GitHub 50 threads/page and 50 comments/thread/page; page **both** connections, deduplicate by IDs, reject repeated/mismatched cursors. Cap 500 threads, 500 comments/thread and 5,000 comments total. Keep continuation private. On a cap show Limited and a provider-page action; no automatic unlimited load-more loop.
- Azure thread/iteration endpoints have no documented list paging: enforce response bytes while streaming, 500 threads/5,000 comments total, 500 comments/thread and 1,000 iterations. Do not invent `$top` pagination for threads. An over-byte response fails/retains stale data; never parse a clipped JSON prefix as complete. Iteration changes use `$top=100`, follow positive advancing `nextSkip/nextTop`, maximum 10,000 changes/100 requests within the shared refresh budget.
- A requested anchor not proven before any limit is unsupported/limited, never “not found, use latest.” Partial thread/comment data is marked as such. Missing root identity disables reply even when some replies were loaded.

## Remaining gates, not invented guarantees

Custom draft URI autosave/close/reopen, Comments API rendering on both qualified immutable diff sides, and live Azure offset/tracked-context semantics require qualification. Independent per-window reload visibility remains an explicit requirement gap for duplicate workspace windows. Current evidence supports a bounded implementation with explicit unsupported states; it does not support unrestricted historical placement, GitHub left-side creation or automatic exactly-once recovery. [07](07-pr-slices.md) makes these limits and gates part of delivery.
