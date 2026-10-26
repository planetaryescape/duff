# Alternatives: Draft composition

Status: comparison drafted; Option B is the agent-selected working decision for subsequent layers. The owner accepted [Layer 1](01-shape.md) and then requested completion of all remaining layers and implementation without intermediate checkpoints. That instruction permits progress but is not explicit owner confirmation of adjacent composition. See [contracts](03-contracts.md) for the bounded implementation and qualification gates.

## Evidence

Inspected public upstream sources on 2026-10-25. These are source/documentation findings, not native-host verification.

- VS Code's [stable comments API](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts) provides thread creation, ranges, state, collapse, actions, and `CommentReply.text` passed to a command. `CommentController` and `CommentThread` expose no documented unsent-input change event or reply-input setter.
- The [commentsDraftState proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.commentsDraftState.d.ts) adds a Draft/Published label to comments. It does not provide draft text autosave. The [activeComment proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.activeComment.d.ts) exposes focused-thread identity, not input changes.
- Therefore Effect can persist text it receives, but cannot by itself capture every edit in the built-in reply box. Do not promise transparent autosave from the stable comments API. Editor-internal retention across reloads is not an established Duff persistence contract.
- GitHub's [REST review comments API](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request) accepts `commit_id`, path, side, line and optional range start. Its docs explicitly note that an older commit can produce an outdated comment. Replies target the root comment. These fields support explicit revision addressing but do not alone prove compatibility with every Duff comparison.
- Azure's [thread creation API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1) supplies left/right positions, iteration context and a required change-tracking ID for iteration-enabled PRs. Matching the pinned comparison to provider iterations is necessary. Its resolution vocabulary includes active, fixed, wontFix, closed, byDesign, pending and unknown.
- GitHub thread-resolution reads/mutations, Azure update semantics, installed-editor API compatibility, and exact diff-side behavior remain to be verified before contracts. No authenticated reads or writes were performed.

## Option A: Built-in inline composer with explicit Save Draft

Keep the normal inline input. Add a Save Draft command that receives the current `CommentReply.text` and persists it through core. Restore saved drafts as editable local draft comments using their saved body; qualify the exact editing/action flow in the host.

This preserves inline composition, but only text explicitly handed to Duff is durably saved. Text typed since the last Save Draft cannot be promised to survive restart. It changes the agreed automatic draft-survival expectation and requires owner approval.

## Option B: Inline threads with a native Markdown draft editor

Keep reading, Resolve and Reopen inline. Start Thread and Reply originate from the immutable diff/thread and open a native Markdown document beside it, bound to that exact destination. Stable document-change events feed ordered core draft saves. Provide explicit Send, Discard and Return to Diff actions.

The text editor is a composition surface, not a workspace source file and not another comment-placement surface. Draft storage remains outside the repository. This preserves native UI and enables observable autosave, but typing happens in an adjacent editor rather than inside the thread. That UX adjustment requires owner approval.

An editable document cannot be implemented with a read-only content provider. Select and verify an appropriate file/document adapter in the contracts layer. Show saving/saved/failed state; do not claim the last keystroke survives an abrupt crash before storage acknowledges it.

## Option C: Custom webview composer

Keep native thread display but compose in an owned webview with text-change messages and restored text. This permits custom autosave UI, but departs from the native review-UI constraint and adds a second rendering/messaging surface. It also does not make a webview an embeddable native inline comment editor.

## Comparison

| Dimension | A: Inline + Save Draft | B: Native draft editor | C: Webview composer |
| --- | --- | --- | --- |
| Inline typing | Yes | No, adjacent editor | Separate custom surface |
| Durable automatic text capture | Not through the inspected stable comment API | Stable document events, adapter qualification required | Owned messages, adapter qualification required |
| Native UI | Yes | Yes | No |
| User burden | Must remember Save Draft | Switch to a draft tab | Switch to custom composer |
| Implementation cost | Lowest | Moderate | Highest |
| Primary risk | Losing unsaved input | Document lifecycle and destination clarity | Extra UI and message lifecycle |
| Product change needed | Weaker draft-survival promise | Adjacent composition instead of inline typing | Relax native UI requirement |

## Recommendation

Choose **B** if automatic durable drafts are the priority. It preserves the native-editor constraint and starts every action from the exact diff/thread, while making text capture an owned, observable boundary.

Choose **A** if typing inside the thread is essential and an explicit Save Draft action is acceptable. Do not quietly substitute either choice for the owner's requirements.

Provider anchoring remains behind the accepted adapter boundary. There is no evidence here that warrants replacing it or creating a separate provider architecture.
