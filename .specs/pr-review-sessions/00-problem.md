# Persistent PR review sessions

## Summary

Closing or restarting the editor must not discard a PR reviewer's place or explicit viewed marks. Design local persistent PR review sessions that can resume the exact reviewed Git snapshot. This is a design draft, not implementation authorization.

## Current State

Baseline: open PR #4, head 5cf4c333b298bc8906c124f73be5f5dced68c897, inspected on 2026-10-15.

- Core `PullRequestReview` holds the accepted PR, pinned source/target revisions, review and preparation activity in memory. Startup initializes an empty accepted review.
- Extension `ReviewCommands` writes a single `viewedFiles` workspace-state record containing repository root, comparison base/head and viewed paths. Selecting a different comparison replaces that record.
- Exact matching marks can be restored after manually selecting the same comparison. The selected PR review and current file are not restored by this mechanism.
- Immutable content comes from Git objects. Fetch acquisition retains at most two shared Duff refs, not per-session retention roots.
- Layout is saved separately as workspace state. PR metadata authentication and Git acquisition authentication remain separate.

## Problem

The user wants to close or accidentally lose the editor without losing their PR review progress. A single saved set of marks is not a resumable session, and switching PRs should not accidentally become destructive if multiple saved reviews are in scope.

## Users / Callers

The reviewer closes/reopens an editor workspace, reloads the extension, switches between PRs, or explicitly resumes a saved review. Both Azure DevOps and GitHub must use the same session behavior.

## Goals

- Preserve explicit viewed/unviewed decisions and the identity of the reviewed PR snapshot.
- Automatically restore the most recently active review and reopen its last diff in the same workspace (confirmed by the user). An explicitly left review stays inactive.
- Retain multiple PR sessions so reviewing another PR does not overwrite earlier work (confirmed by the user).
- Persist during review, not only on graceful shutdown. State the durability limit for changes interrupted before a save completes; do not promise recovery of unacknowledged writes.
- Resume the saved snapshot without requiring provider access when its Git objects are locally available.
- Keep the saved snapshot distinct from a newer remote PR revision.
- On explicit revision updates, keep viewed marks for unchanged diffs and reset marks for changed diffs (confirmed by the user).
- Keep one current saved snapshot per PR session, with no revision history (confirmed by the user). Replace it only after candidate preparation and persistence succeed; failure retains the previous accepted snapshot.
- Make missing repository, missing objects, invalid saved state and write failure visible without silently deleting saved progress.

## Non-Goals

Revision history is explicitly excluded. Other proposed exclusions for this slice: cloud/device sync, provider-side viewed state, review submission, comments/drafts, restoring every editor tab/cursor/scroll position, branch checkout, and carrying marks onto changed diffs. These other exclusions are proposals pending feedback. Carrying marks for unchanged diffs during explicit revision updates is in scope.

## Constraints

- Native VS Code/VSCodium UI; local storage adapter belongs in the extension, application contracts and behavior in core.
- Parse persisted data with Schema before restoring domain state.
- Git remains source of truth: store identities, immutable commits, changed paths and review progress, not copied file contents or credentials.
- No automatic provider authentication, fetch or checkout merely to resume a review.
- Existing source/target and merge-base identities must be preserved rather than reconstructed from moving branch names.

## Invariants

- Opening a file does not mark it viewed.
- A viewed mark belongs to its exact saved comparison and changed path; an old tab cannot mark another snapshot.
- Explicit update may transfer a mark only after establishing that the complete per-file diff is unchanged; filename, source blob or commit identity alone is insufficient.
- In-progress preparation, transient failure and cancellation must not overwrite a previously saved accepted session.
- Reopening cannot silently resolve the latest PR and present it with old viewed marks.
- A retained session requires a Git-object retention policy: two shared acquisition refs alone are insufficient for durable multi-session retention.
- Exiting a review and permanently forgetting its saved progress must be distinct if saved sessions are supported.
- Secrets and persisted review identities/content do not enter telemetry exports.

## Open Questions

1. Multiple saved PR sessions and automatic restoration of the most recently active session and last diff are confirmed. Explicitly leaving a review suppresses auto-restore until a session is activated again.
2. How should saved sessions be discovered and resumed in native UI? Do not add a new view before agreeing on the interaction.
3. One current saved snapshot per session and unchanged-diff mark preservation on explicit update are confirmed. Historical snapshots are not exposed as resumable sessions; already-open old diffs remain immutable.
4. Where should sessions live, how are worktree/repository identities distinguished, and what happens across multiple editor windows?
5. What bounded retention/deletion policy and Git refs protect saved snapshots from garbage collection?
6. What save acknowledgement and write-failure behavior make the crash-recovery promise honest?

## Source References

- `packages/core/src/review/PullRequestReview.ts`
- `packages/core/src/review/ReviewProgress.ts`
- `packages/core/src/review/BranchReview.ts`
- `packages/extension/src/review/ReviewCommands.ts`
- `packages/extension/src/extension.ts`
