# Shape: Inline PR comments

Status: owner-accepted direction. Native composition needs a follow-up choice based on [Layer 2 findings](02-alternatives.md). Scope and confirmed UX choices are in [Layer 0](00-problem.md). Names below describe proposed responsibilities, not implemented APIs.

Follow-up: [03 contracts](03-contracts.md) selects the adjacent Markdown editor as an agent working decision and requires PR/comparison/change/side-qualified native URIs. [04 flows](04-flows.md) through [07 delivery slices](07-pr-slices.md) complete the requested design. Earlier candidate language below records the accepted shape, not a competing implementation contract.

## Key domain concepts

- **Discussion:** live provider threads for one provider/repository/PR identity. Its freshness is independent of the accepted code snapshot.
- **Thread:** an ordered conversation, provider identity, resolution state, available actions, and an anchor when available. Resolve and Reopen act on the thread, not an individual reply.
- **Anchor:** the provider's revision/path/side/location evidence. A new-thread anchor starts with the exact immutable comparison and selected code range.
- **Placement:** the result of matching an anchor to an open immutable diff. Either established placement or a reason it cannot be placed. An outdated thread may still be placeable in the matching saved snapshot.
- **Draft:** locally durable unsent text addressed either to an existing thread or a new-thread anchor. A PR refresh never silently moves its destination.
- **Submission:** one explicit send attempt, with confirmed success, definite failure, or uncertain outcome. Sending again is not the default recovery for an uncertain result.
- **Visibility:** a window-local presentation preference. Hidden comments retain drafts and discussion state; resolved threads initially collapse when visible.

```text
Immutable review snapshot             Live provider discussion
            |                                  |
            +---------- placement -------------+
                            |
                    Native diff threads
                      |            |
               compose/reply   resolve/reopen
                      |            |
                 durable draft     |
                      +----- explicit action
                                   |
                         core discussion workflow
                                   |
                             provider adapter
```

## Boundaries and seams

| Owner | Responsibility | What crosses the boundary |
| --- | --- | --- |
| Extension review UI | Native thread rendering, diff selections, toolbar toggle, text capture and restoration | Parsed review identity, anchors, draft edits, explicit user actions; domain state returns |
| Core discussion workflow | Loading, freshness, operation ownership, draft saves, writes, and publication of outcomes | Job-shaped operations and observable domain state, never VS Code objects |
| Core placement logic | Establish whether an anchor matches the displayed immutable file and side | Snapshot metadata and normalized anchor evidence; placement or explicit limitation |
| Existing provider adapters | Read threads, create threads, reply, resolve and reopen using each provider's protocol | Decoded discussion values, supported actions, typed errors and mutation outcomes |
| Local draft storage | Durable drafts and the minimum submission recovery record | Draft identity, destination, text, version and submission state; no credentials |

Keep these responsibilities within existing core and extension packages. Extend the existing provider boundary with discussion jobs rather than building a second authentication or provider registry. Choose the storage adapter after inspecting the existing host-local storage ownership; do not choose a new database merely for this feature.

The likely native surface is a VS Code CommentController over Duff snapshot URIs. This is a candidate, not a verified API choice. Draft change capture and restoration are a design gate: native comment boxes must not be assumed to expose autosave events.

## High-level flow

1. An accepted PR review supplies its stable PR identity and immutable comparison to the discussion workflow.
2. Load matching local drafts and fetch provider discussion independently. Code review remains usable if the fetch fails.
3. Normalize threads and establish placement against the displayed snapshot. Never approximate a provider anchor using matching text alone.
4. Render placed threads in native diffs when comments are enabled. Show resolved threads collapsed. Surface unplaceable threads through a native review list with the reason and a provider-page action, proposed pending UX approval.
5. Selecting a supported diff location starts a new-thread draft; replying creates a draft bound to the existing thread. Persist edits in order, and expose save failures rather than claiming the text is saved.
6. Explicit submission first saves the draft and records the attempt, then calls the provider. Only confirmed success clears the submitted draft version. Text edited during a send must not be deleted by completion of the earlier send.
7. Resolve or Reopen sends an explicit thread-state operation. Publish confirmed provider state; retain the prior state and show a failure or uncertainty when confirmation is unavailable.
8. Refresh discussion after confirmed mutations. Proposed read triggers are review activation and an explicit Refresh Comments action, without polling in the first slice. Refreshing comments does not refresh the code snapshot.
9. Hiding comments removes inline presentation, not drafts or remote state. Switching reviews detaches old UI and cancels obsolete reads; dispatched writes retain their original destination and a recoverable outcome.

## Key decisions

### Confirmed by the owner

- Read, start threads, reply, resolve and reopen, within immutable diffs first.
- Comments default to visible, with a one-click diff-toolbar toggle remembered per review window across reloads.
- Resolved threads start collapsed.
- Unsent drafts survive toggles, review switches, reloads and closing/reopening Duff.

### Proposed design direction

- **Separate live discussion from frozen code.** Their lifetimes differ; neither silently updates the other.
- **Keep remote state authoritative.** Local drafts are durable, but Duff does not claim a comment is posted or a thread resolved until confirmed.
- **Use Effect for owned workflows, storage for durability.** In-memory fibers cannot preserve work across process exit. Recover saved drafts and pending attempts at startup; never automatically replay uncertain comment creation or replies.
- **Save drafts independently of visibility.** Hiding a comment box is not discarding its text. Explicit discard removes a draft; a confirmed send removes only the version sent.
- **Respect provider capabilities.** Unsupported anchors and unavailable actions produce clear limitations. GitHub and Azure resolution states must be mapped deliberately rather than flattened without evidence.
- **Bound stale-review creation.** Permit thread creation on an older displayed revision only if its provider can express that exact anchor. Otherwise retain the draft and offer an explicit path to refresh/re-anchor; do not post against another revision automatically.
- **Keep a small first refresh policy.** Load on review activation and refresh explicitly or after mutations. Offline review can recover drafts even when live discussion is unavailable; durable caching of remote comment bodies is not assumed.

## Risks and design gates

1. **Native draft capture:** verify stable VS Code/VSCodium APIs expose text changes and permit restoration on custom snapshot URIs. If they do not, present a native composition alternative for approval before promising transparent autosave.
2. **Provider anchor differences:** inspect GitHub and Azure thread APIs before contracts. Base-side positions, ranges, renames, merge-base comparisons, and older revisions may have different support.
3. **Ambiguous writes:** a lost response can follow a successful post. Persist enough attempt state to reconcile where possible; otherwise preserve text and label uncertainty. Matching body text alone is not proof of identity.
4. **Save timing:** close/reload hooks alone cannot guarantee persistence. Define when edits become durably saved and expose the unsaved interval, including what happens on abrupt process termination.
5. **Concurrent windows and edits:** draft identity and version checks must prevent one window or an older send completion from deleting another edit. Determine whether ownership follows the existing review-window/storage model before choosing locks or conflict rules.
6. **Unplaceable discussion:** a hidden or misplaced thread undermines review. Keep unavailable placement explicit and confirm the native fallback UX.
7. **Permissions:** existing read authentication may not permit writes. Handle action-specific denial without making code review unavailable or silently changing authentication.

Next checkpoint: validate native draft capture and provider anchoring, then compare alternatives only where those findings leave a real choice. Typed contracts follow after the shape is accepted.
