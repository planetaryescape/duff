# Shape: Persistent PR review sessions

Status: proposed; multiple saved PR sessions, one current snapshot per PR without revision history, unchanged-diff mark preservation and automatic restoration of the last active review/diff are confirmed. See [problem frame](00-problem.md).

## Key Domain Concepts

- Saved PR session: repository/worktree context plus provider, provider repository identity and PR ID. PR numbers alone are not unique.
- Reviewed snapshot: pinned source, target and comparison-base commits and changed paths. One session's current accepted snapshot is distinct from its mutable remote PR.
- Progress: explicit viewed decisions belonging to that snapshot, plus last opened changed-file path. Layout remains a view preference.
- Active session: the session selected for this workspace. Selecting another does not delete either session.
- Saved-session entry: cached PR label, viewed count and resume action. It remains available without network discovery or even after the PR leaves the open-PR list.

```text
workspace opens -> load saved sessions -> resume last active snapshot
PR A -> save progress -> PR B -> resume PR A without resolving its latest revision
```

## Boundaries and Seams

- Core review capability owns session identity, valid transitions, active-session selection and progress rules. Extend the existing ownership rather than introducing a parallel review engine.
- A supplied local session-store port owns loading and saving session records. The extension supplies the native local-storage adapter; storage format is parsed at that boundary.
- The Git adapter protects accepted snapshot commits using per-session retention refs and reconstructs immutable diffs from Git. Cached file contents are unnecessary.
- Provider adapters are used for explicit update/new review preparation, not basic resume. Azure and GitHub share session behavior.
- Native UI renders saved sessions independently of live PR discovery and opens the saved file after restoration. Exact sidebar placement is not decided here.

## High-Level Flow

1. When opening a new PR, prepare its exact snapshot as today.
2. Protect accepted snapshot commits and persist the session before acknowledging it as durably saved. A transient preparation is not a saved session.
3. Persist viewed changes as they occur, with owned, ordered writes. Save the last opened file separately or together according to the eventual storage contract; no unbounded queue or shutdown-only flush.
4. Switching PRs activates another session without overwriting earlier records. A PR with a saved session resumes that session by default; checking for a newer revision is explicit.
5. On activation, parse and load saved sessions. Restore the last active session for the matching workspace/repository and reopen its last changed-file diff when available, without authentication or fetching.
6. If repository/objects are unavailable, retain the saved record and progress and show a repairable unavailable state. Do not substitute moving refs or delete the session.
7. Explicit Update Review prepares a candidate snapshot while preserving the accepted saved snapshot. Failure/cancellation leaves it intact. On acceptance, transfer viewed marks only for unchanged per-file diffs; changed and new diffs are unviewed, and absent files leave the current list.
8. Leave Review removes the active selection but retains the saved session. Forget Review explicitly deletes its saved progress and associated retention refs, with recoverable ordering between storage and Git.

## Key Decisions

- Multiple sessions is confirmed. Do not implement crash recovery by retaining just one global viewed record.
- Automatic restoration is confirmed: reopen the last active saved review and its last diff in the matching workspace without provider access. Explicit Leave Review clears active selection without deleting the session; do not reactivate it on startup.
- Propose local persistence scoped to the current workspace/repository context for this slice; no cross-device sync.
- One current saved snapshot per PR session is confirmed, not a user-facing timeline of past revisions. Replace the accepted snapshot only after preparation and persistence succeed; failure retains the previous accepted snapshot. Temporary retention during safe replacement is recovery plumbing, not user-visible revision history.
- Resume means the saved snapshot, not an API request to latest PR details. A resumed merged/closed PR remains readable when objects exist.
- Opening a file never marks it viewed. A durable mark is not reported as safely saved before its write completes; persistence failure must remain visible.
- Leaving is non-destructive. Forgetting and retention cleanup are separate explicit actions; no silent eviction policy is selected yet.
- No full editor layout restoration is required: the proposed place marker is the last opened changed file, not every tab/cursor/scroll offset.

## Risks

- Crash ordering between metadata saves and Git retention can leave orphan refs or metadata without objects. Save/forget operations require a recoverable protocol, not a claim of a cross-system transaction.
- Two editor windows can lose each other's progress without a chosen storage ownership/concurrency strategy. Storage choice must settle this before contracts are final.
- Last-write races during mark/unmark or switching sessions can overwrite new progress with an older save. Session identity and ordered persistence must survive asynchronous UI callbacks.
- Workspace identity changes, worktrees sharing Git refs, removed repositories and corrupt records need explicit handling without cross-applying progress.
- Carrying viewed marks to a new PR snapshot is unsafe if based only on unchanged filename or source blob. Any proposal must account for the complete old/new diff, including its base side and rename identity.
- Pinning Git objects retains disk usage. Session listing/deletion and bounded loading must be designed; do not silently discard user work to satisfy an arbitrary cap.

## Unchanged-Diff Rule

The user confirmed preserving viewed marks for unchanged diffs on explicit updates. The following conservative equivalence rule is proposed:

- Compare the change kind, old/new paths, and both sides' Git object IDs and file modes. An absent side is explicit (added/deleted), not an empty-file blob.
- Use the actual comparison base (merge base), not the target branch tip, for the old side. Compare against the source snapshot for the new side.
- Commit IDs may change without changing the diff. A rebase or unrelated commit does not reset a mark if all per-file comparison values match.
- A changed base-side blob resets the mark even if the source blob is unchanged. This conservatively treats changes to full file context as a changed diff; identical patch text alone is not sufficient.
- Rename source/destination, change-kind and mode changes reset the mark. Do not infer file identity across different paths or transfer marks just because two files share content.
- A previously unviewed file stays unviewed. Removed entries leave the current list; reintroduced changes do not recover historical marks through a revision timeline.
- If comparison evidence cannot be read, do not silently accept the update or clear the saved session. Keep the accepted snapshot and show the preparation failure.
- Old open diff tabs remain immutable and cannot mutate marks in the newly accepted snapshot, including marks that were transferred.

Git tree/object metadata supplies this evidence; there is no need to persist file contents or hash rendered patches.

## Restoration Behavior

The user confirmed automatic restoration. On reopening, restore the last active saved snapshot and last-opened changed-file diff without a network request. If the user explicitly left the review before closing, leave it inactive. If repository or objects are unavailable, preserve the session and show the unavailable state rather than resolving a newer revision. If there was no last-opened file (or it is no longer in the accepted snapshot), restore the changed-files list without inventing a place marker.

Still to settle: native saved-session placement, workspace/storage ownership across windows, and explicit forgetting/retention policy. No implementation is authorized by these design confirmations.
