# Inline PR comments

Status: proposed problem frame. Read, start threads, reply, resolve, reopen, and an easy comments toggle are owner-confirmed. Display and thread creation are limited to immutable diffs for the first slice. Other proposed behavior below awaits review. Design only, no implementation.

Follow-up: the owner requested all remaining layers without intermediate checkpoints. [03 contracts](03-contracts.md) through [07 delivery slices](07-pr-slices.md) now answer the design questions below with bounded proposals and explicit qualification limits. Adjacent composition and workspace-backed visibility are agent-selected, not additional owner confirmations; duplicate-window visibility remains a disclosed requirement gap.

## Summary

Bring PR discussion into Duff's immutable diffs so a reviewer can read a thread beside the relevant code, start a new thread, reply, and resolve it without leaving the editor. Provide an easy way to hide and show comments while reviewing.

## Current state

- Duff supports GitHub and Azure DevOps through headless core adapters. The [provider contract](../../packages/core/src/pull-requests/GitHostingProvider.ts) exposes PR reads but no thread, reply, or resolution operations.
- [ReviewCommands](../../packages/extension/src/review/ReviewCommands.ts) opens native immutable diffs. Snapshot documents and editable workspace files are distinct surfaces.
- [Saved PR sessions](../../docs/blueprint/04-capabilities-and-review-session.md#persistent-pr-review-sessions) retain exact comparisons and viewed progress. Resuming one does not imply that its revisions match today's provider state.
- [Managed review windows](../../docs/implementation-plan.md#s10-repository-dashboard-and-managed-review-windows) provide full pinned checkouts that can acquire local edits.
- No native comment controller or thread implementation was found in the inspected packages.
- The [current overview](../../docs/blueprint/00-overview.md#non-goals-for-these-slices) excludes comment sync and provider writes from delivered slices. This proposal deliberately extends that scope with replies and resolution; it does not claim those operations already exist.
- The working tree includes ongoing dashboard/statistics work. This spec records the inspected state without treating those edits as committed delivery.

## Problem

Reviewing code and discussing it currently require separate surfaces. Duff needs to display existing conversations and support thread creation, replies, and resolution in context. Correct placement matters: provider threads can refer to a different PR revision, deleted lines, or renamed paths while Duff continues to show an older saved comparison. New threads must likewise target the code actually displayed, not silently attach to today's PR head.

Comments must also be easy to hide when the reviewer wants an uninterrupted view of the diff.

## Users / callers

- A reviewer opens a PR in Duff and reads existing discussion alongside code.
- The reviewer starts a thread from code in an immutable diff, submits a reply to an existing thread, or resolves that thread.
- The reviewer toggles comment visibility while continuing the same review.
- Native editor callbacks enter core-owned workflows; provider adapters perform remote reads and writes.

## Goals

Owner-confirmed:

1. Read existing inline PR threads.
2. Reply to existing threads.
3. Resolve threads.
4. Easily toggle comments on/off.
5. Start new threads from immutable diffs.
6. Show inline comments only in immutable diffs for the first slice, not editable workspace files.
7. Reopen resolved threads.
8. Show comments by default, with a one-click toggle in the diff toolbar. Remember the visibility choice per review window across reloads.
9. Start resolved threads collapsed.
10. Persist unsent new-thread and reply drafts locally across visibility changes, PR switches, reloads, and closing/reopening Duff. Effect owns storage workflows; durable local storage retains the data.

Proposed acceptance expectations:

- Cover both built-in providers, with explicit handling of differences in permissions and resolution semantics.
- Place threads only where their relationship to the displayed revision, file, and diff side is established. Expose outdated or unplaceable threads truthfully rather than guessing a line.
- Distinguish loading, empty results, stale results, and failed reads.
- Make reply and resolve outcomes visible. Preserve reply text on a failed submission; an uncertain network result must not invite blind duplicate posting.
- Apply the same submission guarantees to new threads. Bind creation to the displayed revision, path, side, and selected location. If a provider cannot accept that anchor, surface the limitation rather than silently moving the comment.
- Hiding comments changes presentation, not remote resolution state or viewed progress. Preserve in-progress reply text across a visibility toggle.

## Non-goals

- Editing/deleting comments, reactions, or applying suggested changes.
- Showing or creating inline comments in editable workspace files.
- Submitting a review, approving, requesting changes, or merging.
- A general PR activity feed or top-level PR conversation composer.
- Changes to checkout, Git credentials, or code as a side effect of comment actions.

Reopening resolved threads is included as the inverse of Resolve.

## Constraints

- Keep review UI native. The exact native comments API behavior on Duff snapshot documents needs investigation before selecting the design.
- Core owns domain behavior, provider adapters, and typed failures. VS Code objects stay in the extension.
- Reuse the existing authentication boundary. Permission to read a PR does not establish permission to reply or resolve; provider capability and permission behavior need verification.
- Keep local code review usable when discussion cannot load.
- Follow the existing single managed-runtime ownership and cancellation conventions.
- Do not export comment text, author identities, provider URLs, or raw provider errors through telemetry.

## Invariants

- PR/thread identity includes the provider and repository, not just a numeric thread ID or path.
- A comment action targets its originating PR and thread, even if the user switches reviews while work is pending.
- A late response cannot populate another review's comments.
- Live discussion updates do not silently replace the accepted code snapshot or reset viewed progress.
- Only an explicit thread submission, Reply, Resolve, or Reopen action requests a provider mutation. Opening, refreshing, or toggling comments does not.
- New-thread submission retains the immutable comparison and selected anchor from which the user composed it. Switching reviews or a moving PR head cannot silently retarget it.
- A timeout or cancellation after dispatch does not prove the provider rejected the write. Recovery must distinguish failure from an unknown outcome.
- Provider content is untrusted display data, not executable editor commands or trusted markup.

## Open questions

1. Which anchors can new threads use: either diff side, single lines, or line ranges? What should happen when a saved comparison is older than the provider's current PR revision? Verify provider support before choosing the creation contract.
2. How should a per-window visibility preference be identified and restored in the existing review-window lifecycle? The owner confirmed persistence across reloads; persistence across a full close and reopen is not yet specified.
3. Where should outdated, file-level, and otherwise unplaceable threads remain accessible?
4. When should discussion refresh: opening the review, explicit refresh, focus, or polling? How should an offline saved session behave?
5. How does the native editor expose unsent text changes and restoration? Draft survival is required; its capture mechanism needs verification.
6. Which GitHub and Azure APIs supply thread identity, revision anchors, permissions, thread creation, replies, and resolution? What are their pagination, write ambiguity, and concurrency guarantees?

These questions belong to subsequent design checkpoints. No transport, storage schema, or native UI API is selected by this problem frame.
