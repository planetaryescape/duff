# Flows: Inline PR comments

Status: proposed, not implemented or runtime-qualified. Contracts and protocol evidence are in [03](03-contracts.md). Adjacent Markdown composition and workspace-backed visibility are agent-selected, with the limitations stated there.

## Current versus proposed

| Entry | Current inspected behavior | Proposed change |
| --- | --- | --- |
| Accepted PR review | Immutable comparison plus viewed progress | Discussion activation runs independently; no code refresh |
| Native diff URI | Bare root/commit/path Snapshot | Deterministic PR/comparison/logical path/side envelope, content Snapshot retained |
| Content/navigation decode | Bare Snapshot readers | One shared legacy-or-qualified decoder; legacy readable but never commentable |
| Review toolbar | Workspace navigation/progress actions | One shown/hidden comments toggle for qualified PR diffs |
| Provider reads | PR metadata/discovery/statistics | Bounded normalized threads, permissions and proven anchor evidence |
| Provider writes | None delivered in discussion scope | Explicit Create/Reply/Resolve/Reopen, journalled, no retries |
| Drafts | No Duff draft store | Core workflow, host-local store, adjacent native document |

## Activate, read and render

```text
PullRequestReview.accepted
  -> extension projects DiscussionReview from accepted selection/resolved/review
  -> shared URI builder qualifies every PR diff, including empty sides
  -> Discussions.activate(Some(review))
       cancel old read scope; advance generation; publish Loading
       independently restore local draft/attempt page and route provider read
  -> ProviderRepository.discussion.read(review)
       silent existing auth; provider-owned request URLs
       decode wire pages -> check budgets/cursors/PR identity
       fetch revision/iteration evidence -> normalize thread anchors
  -> core validates exact snapshot content bounds/side
  -> publish Ready only for same review + generation
  -> extension renders placed native threads on matching qualified URIs
       resolved initially collapsed, canReply false
       unplaced/limited state in review discussion tree
```

Opening an inactive old diff or a legacy tab does not reactivate another PR implicitly. Code review without a PR has no discussion controller targets. An explicit qualified diff refresh/reopen can rebuild the correct URI from the accepted snapshot; it cannot rewrite old tabs into another comparison silently.

GitHub reads use `reviewThreads(first: 50, after)` and root/comment pages, with metadata consistency checks and independent child cursors. Null roots or pending/unsubmitted provider-review content must not become fabricated published threads. If pending content is returned, label it read-only pending and do not submit it. Current coordinates are placed only under [03's matrix](03-contracts.md#exact-placement-and-creation-guards). Azure resolves exact iteration evidence before using tracked positions. No matching iteration means unplaced discussion remains readable, not latest-iteration fallback.

Load local drafts even if auth/network fails. Empty is only a successful complete empty snapshot. A failed refresh retains prior data as Stale with its revision placement evidence; it never relabels stale anchors as current. Limited results keep their limitation visible. Remote comment bodies are not a durable offline cache.

## Toggle and refresh

```text
toolbar action with qualified active diff
  -> verify active accepted envelope
  -> persist chosen visibility through extension preference adapter
  -> update local UI state/context key and dispose/rebuild inline instances
  -> no remote write, no viewed mark, no draft discard

Refresh Comments / activation / confirmed mutation
  -> one owned read generation
  -> Refreshing(previous) -> Ready(new) | Stale(previous,error)
```

No focus polling or automatic retry. Hidden discussions may finish an existing read but do not trigger extra requests on each toggle. The native fallback list remains a way to recover drafts and inspect limitations; hiding inline code comments is not hiding all error/recovery UI. Workspace-backed preference persists across reload but not independently for duplicate same-workspace windows; surface that limitation as specified in 03.

## Start thread and compose

```text
snapshot selection context action(raw editor/selection)
  -> extension shared decoder -> qualified active accepted envelope
  -> convert zero-based selection -> one-based inclusive range
  -> core CodeAnchor constructor verifies side/path/commit/file/content
  -> reject unsupported multi-line or provider creation side before composing,
     with explicit explanation, not range truncation
  -> Discussions.start -> store.create(empty version 1 draft)
  -> open writable duff-draft:/opaque-id.md beside origin diff
  -> native TextDocumentChange -> owned per-draft document.save loop
  -> FileSystemProvider.writeFile(exact bytes)
  -> Discussions.save(expected revision) -> store CAS transaction
  -> commit -> acknowledge exact document text/version -> Saved
```

Reply uses a verified thread-title binding, not a provider text-supplied command. `startReply` fresh-checks that the thread belongs to the originating PR and has an available reply path; it captures the originating accepted review before opening the editor. A subsequent PR switch cannot change that target. If a thread is deleted later, draft remains and Send is rejected visibly. Multiple drafts can target one thread but only one unresolved send reservation may own it. Draft tabs can stay open when changing reviews.

The document-save loop keeps one in-flight save and the newest edit. When a save finishes after another edit, it acknowledges only the earlier bytes and immediately schedules the newest body. Native dirty state and Duff Saved state must agree on what was actually committed. A tab close is not Discard; a close/reload hook may flush best-effort, but durable survival begins at storage acknowledgment, not keystroke arrival. No claim that a crash preserves the last unacknowledged keystroke. A failed save leaves native dirty text and recovery controls visible.

## Explicit Send

```text
Send(bound draft ID)
  -> capture current editor text/version and flush serialized save lane
  -> ensure exact latest body is durable; validate nonblank/body byte limit
  -> show destination confirmation when required
  -> Discussions.send(id, expectedVersion)
       allocate stable attempt ID
       store.prepare: CAS version + immutable body/target + target reservation
       perform fresh silent auth/thread/anchor capability preflight
       persist Dispatching before provider invocation
       provider.create or provider.reply exactly once
       translate result to Confirmed | Rejected | Uncertain
       store.finish atomically; clear only unchanged submitted draft version
  -> publish attempt outcome to originating draft
  -> if original review still active, refresh comments independently
```

Auth/anchor preflight failure proves not sent and persists Rejected from Prepared. A crash after Prepared is not automatically redriven. A crash after Dispatching, even before the actual network call, is conservatively uncertain. Network is interruptible; journal transitions and final outcome commit are short uninterruptible storage sections. Do not wrap a 20-second network operation in a database transaction or uninterruptible region. An outcome-storage failure after remote success leaves Dispatching for recovery, with the draft intact and no retry.

GitHub create posts REST `commit_id` for the displayed head, never a newly read head; only current-pair head-side creation is initially available. Root comment IDs are read/bound before replies. Azure create posts exact iteration/change-tracking context, and reply posts to that thread's comments resource with its root parent ID. A provider receipt can confirm posting even if native thread ID discovery/read refresh fails: say “Posted, comments refresh failed,” not “Send failed.” A response with a mismatching anchor is a posted receipt with warning, not license to post again.

## Resolve and Reopen

```text
thread-title explicit action
  -> decode binding ThreadKey and expected resolution
  -> fresh thread read verifies same PR, availability and current state
  -> reject stale conflicting expected state; ask user to refresh
  -> reserve thread + persist attempt intent
  -> Dispatching
  -> GitHub GraphQL resolveReviewThread/unresolveReviewThread(threadId)
     or Azure PATCH thread {status:'fixed'|'active'}
  -> decode receipt -> persist confirmed state -> refresh
```

If the desired state already holds on the fresh read, acknowledge the observed state without another mutation. No rollback to an invented optimistic state. Azure external concurrent changes between read and PATCH cannot be prevented by an unimplemented ETag contract; state the last-writer race and refresh afterward. GitHub viewer flags are hints rechecked at send, not permanent authorization. No automatic replay even for resolution after uncertain dispatch: another reviewer may since have changed the state.

## Recovery, discard and review changes

| Event | Owner and outcome |
| --- | --- |
| Full restart | Store decodes bounded drafts/attempts. Prepared is not sent; Dispatching is displayed as uncertain without rewriting another live window's row. Nothing is replayed. |
| Uncertain creation/reply | Retain submitted version/text, exact target and attempt identity. Open provider page/refresh; body/time similarity cannot prove success. Known returned IDs can be read exactly. |
| User wants to send again | Warning acknowledges possible duplicate, persists acknowledgment and releases reservation. A later explicit Send is a new attempt. No generic Retry button on an uncertain outcome. |
| Discard | Explicit action + confirmation for nonempty draft, exact version CAS; cannot delete a newer edit or erase unresolved attempt recovery. |
| Review switch/exit | Cancel old reads and detach UI; retain writes in runtime-owned lifetime and drafts in storage; suppress stale rendering. |
| Runtime deactivation | Dispose UI subscriptions/controller then runtime; dispatched records remain conservative recovery evidence. Flush only best-effort unsaved text. |
| Forget saved review | Remove review session under existing behavior, not discussion drafts/attempts. Return to Diff may be unavailable; body recovery still works. |
| Two windows edit same draft | Store CAS admits one version; losing window keeps dirty text and shows conflict. No silent merge or target reassignment. |

## Authorization and safe presentation

Use current captured activation environment and existing credential precedence. Explicit Connect remains the only sign-in prompt path. Read access does not imply write access. Refreshing a discussion, showing a draft, or opening a provider page cannot mutate auth defaults or Git configuration. Git credentials never carry API tokens.

Treat provider Markdown as untrusted. Native Markdown uses `isTrusted = false`, HTML disabled, command links disabled and no automatic remote images. Display author/body text without executable interpolation; external navigation validates HTTPS/authority first. Draft body, identities, URLs, file paths, commit IDs, argv and raw errors never enter telemetry. Named spans and bounded outcome tags are sufficient. Existing `runOperation` must not silently swallow a write interruption and present it as “cancelled/not posted”; discussion-specific projection includes the stored attempt outcome. These changes need no new exporter or observability infrastructure.
