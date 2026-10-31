# Revision-correct hover and definition peek

Status: problem-frame draft, not an implementation approval. Written 2026-10-30 against PR26 head `d5722d42f655ebfd3eafb1a3dde068c6fa5b5149`.

## Summary

Make the native Rune review useful for understanding TypeScript and React code: hover a symbol to read its type/documentation, invoke Go to Definition to inspect a read-only definition, then return to the exact review position. Answers must describe the displayed Git revision, including the old side of the diff, not the current branch or an edited checkout. This is one production-quality review capability, not a claim that the whole prototype is production-ready.

## Current state

- [Native app](../../scripts/rune-review-prototype/src/main.rs): Rust owns the Rune window, file navigation, layout and diff presentation. `DiffView` displays immutable old/new text returned by the bridge. It has syntax highlighting, text selection, hunk navigation and explicit viewed progress, but no language server integration.
- [Core bridge](../../scripts/rune-review-prototype/bridge/Bridge.ts): Node hosts one managed Effect runtime and decodes native requests with Schema. File reads use `fileSnapshots` and `BranchReview.read`, not checkout contents. Requests pass through a single semaphore.
- [Native IPC](../../scripts/rune-review-prototype/src/bridge.rs): one worker writes a request and waits for its matching response before reading the next request. The UI also has a global busy state. Adding frequent hover requests to this queue unchanged would compete with navigation and durable progress.
- [Saved reviews](../../packages/core/src/review/ReviewSessions.ts): saved state includes the exact review, immutable file comparisons, last file and viewed marks. Definition navigation must not impersonate opening or viewing a changed review file.
- [Managed workspaces](../../packages/core/src/dashboard/ReviewWorkspaces.ts): acquisition creates a detached source checkout and stores exact commits. Reopen preserves existing files rather than resetting edits. A managed checkout is therefore not an immutable language-analysis workspace.
- [Review](../../packages/core/src/review/BranchReview.ts): the old side is `review.baseCommit`, computed from the comparison's common ancestor, and the new side is `review.headCommit`. The old side is not necessarily the PR target tip.
- Rune is pinned to `aff5f631dffd2d65e3a3f031df4659756b567257`. Its [DiffView](https://github.com/anomalyco/rune/blob/aff5f631dffd2d65e3a3f031df4659756b567257/crates/rune-kit/src/diff/view.rs) exposes line-range selection, annotation, comment and visible-file callbacks, but no public symbol-position/hover callback. It expands tabs for display, so a displayed offset is not automatically a source offset. This revision needs an interaction extension, not just an LSP client.

## Problem

Reviewers can read a change but cannot inspect a symbol without leaving Duff and reconstructing its context in an editor. An incorrect integration would be worse: current-checkout types can look authoritative while describing another revision. Full project context, dependencies, diff-side mapping, query ownership and honest unavailable states are part of the feature, not follow-up polish.

## Users and callers

- A reviewer hovering or invoking Go to Definition inside an old/new diff, in unified or split mode.
- The same reviewer following an unchanged definition and returning without losing scroll position, selection or review progress.
- The standalone Rune app and Node bridge. The existing VS Code extension must retain its behaviour and dependency graph unless later implementation evidence requires a narrowly justified core capability.

## Goals

1. **Real hover:** TypeScript/TSX first. Show returned type/signature and documentation in a bounded native card with an explicit revision/side identity. Support keyboard dismissal and keep the card usable when the pointer enters it. Treat server text as untrusted presentation content, never executable markup.
2. **Real definition peek:** Cmd-click on macOS, the platform equivalent where qualified, and F12 open a read-only native peek at the definition range. It may be in an unchanged file. Multiple results must be selectable rather than silently choosing the first. Escape/Back restores the original diff position and selection. Arbitrarily nested navigation is not required for the first slice.
3. **Both displayed revisions:** deleted code uses the old path and base commit; added code uses the new path and head commit; context lines retain their actual side. Renames preserve that distinction. A nonexistent side has no invented language context.
4. **Honest readiness:** distinguish disabled/untrusted, starting, ready, missing context/dependencies, unsupported content, no result, timeout and server failure. Preserve ordinary diff reading and viewed writes when language analysis is unavailable.
5. **Responsive queries:** discard results for an obsolete file, side, revision, pointer position or closed peek. Cancel superseded work, bound startup/query/output/cache resource use and avoid hover requests blocking review controls. Exact limits belong in the contracts layer.
6. **Owned processes:** ordinary app close, review replacement, startup failure and cancelled work have explicit cleanup. Language-server and any child-server processes must not outlive their owner through the normal-close path. Do not reintroduce a Node-only force-kill fallback that strands descendants.

## Non-goals

- Editing, completion, rename, quick fixes, applying workspace edits, formatting or executing server-provided commands.
- Find References, diagnostics, semantic highlighting, inline comments or new provider writes in this first slice.
- A general plugin marketplace, every language, a terminal/debugger, cloud analysis or rewriting Duff's Effect core in Rust.
- A signed installer, full application accessibility audit, or general production hardening unrelated to this capability.
- Automatic dependency installation, package scripts, build/code generation, submodule/LFS downloads or changes to owner repositories/editor profiles.
- Copying code into the durable saved-review catalog. Any analysis files/cache need a separate explicit lifetime.

## Constraints

### Revision and dependency context

Language analysis must see a coherent project for the requested commit, not only changed files. Configs, source imports and available declaration files must be consistent with that side. Missing generated files, aliases, project references, dependency versions, React Native platform resolution or unsupported module modes must produce an honest limited/unavailable result; inferred `any` is not proof of full project readiness.

Do not silently share one current `node_modules` tree between two revisions. The dependency strategy, TypeScript version selection and validation of external library definitions are unresolved design work. Full dependency context is a prerequisite for an end-to-end claim on the owner's repository, not a reason to run its install scripts automatically.

### Trust and filesystem access

Ask for explicit trust before starting project-aware tooling; provider login or opening a PR is not that consent. Do not load executable project plugins or project-selected server binaries by default. No automatic typing downloads, shell commands, dependency installation or network bootstrap.

An isolated snapshot directory is not an OS sandbox: a language server runs with the owner's account privileges unless separately constrained. The trust UI must say so. Verify actual server options and plugin/loading behaviour before claiming these controls work.

Server-returned definition URIs must be decoded and restricted to the matching revision's sources and explicitly approved dependency/toolchain roots. Canonical paths and symlinks must not allow arbitrary local-file peeks. Do not dispatch command, HTTP or other arbitrary URI schemes. Define read-only handling for trusted standard-library/declaration targets separately from Git-pinned source targets.

### Native and protocol boundaries

Keep Rune presentation in Rust and application capabilities in the TypeScript/Effect side. Follow existing Schema decoding, typed expected failures and explicit environment injection. Rust deserializes protocol results into enums/structs, not loosely shaped unowned state.

Accurate symbol positions must account for UTF-8 bytes, the server's negotiated position encoding, surrogate pairs, CRLF, expanded tabs, horizontal scroll and wrapping. Do not derive source columns from fixed character widths. Shared unified context can display both sides; its chosen query side must be deterministic and visible.

No server I/O on the rendering thread. Do not hold the existing mutation/session gate while awaiting a hover. No raw source, documentation, paths, credentials, argv or server stderr in exported telemetry. Resource and failure observations stay finite and content-free.

## Invariants and acceptance evidence

| Invariant | Evidence needed before calling the slice complete |
| --- | --- |
| Each answer belongs to the displayed revision | A real temporary Git project changes the same symbol's type and moves its definition between base and head. Query both sides at the same logical use and assert different independently specified types/locations. Include an intermediate target-tip change to catch confusing target with merge base. |
| Local edits do not change pinned answers | Dirty the retained managed checkout and an unrelated owner-like checkout. Both sides still return the pinned answers; neither directory is modified by analysis. |
| Positions identify the intended symbol | Native hit-testing and real-server queries cover tabs, emoji/non-BMP text, CRLF, split/unified, wrapping and horizontal scroll. Include a nearby symbol with a different type so an off-by-one query fails visibly. |
| Definition reads remain bounded and authorised | Exercise unchanged files, renamed paths, zero/multiple targets, external declarations and a URI/symlink escape. No arbitrary file read or editable buffer results. |
| Responses cannot overwrite newer UI state | Delay a real query, switch file/revision or dismiss the card, then allow completion. The stale card/peek must not appear; viewed writes and navigation remain usable. |
| Closing owns cleanup | Close through the actual native shutdown path during startup and an active language request; verify server and child-server exit, not merely Node exit. Test failed startup and crash reporting too. |
| Failure does not falsify success | Missing dependencies/server, malformed or oversized responses and timeouts show finite states, not fabricated types or successful empty data. Review reading/progress still works. |
| The UI works on the owner's stack | Inspect real Mac native hover, definition peek, keyboard/pointer dismissal, return position and long documentation. Record interactions; confirm actual server responses against the pinned source and preserve owner progress/config. Do not substitute a scripted fixture for this qualification. |

## Open questions for the next design layer

These are implementation facts to resolve through source inspection or bounded experiments, not product questions to delegate to the owner.

1. Which pinned TypeScript language-server/toolchain combination supports hover/definition, encoding negotiation and demonstrably disabled plugin/automatic-download behaviour? Reusing project-selected executable code is not the default.
2. Can Rune expose source-position events through a small maintainable upstream/local dependency change, including the existing tab-expansion map, without replacing or vendoring its whole diff renderer?
3. Should language analysis materialise dedicated commit trees or use a server-compatible virtual filesystem? Which approach keeps configs/import resolution coherent, rejects symlink escapes and avoids altering retained checkouts? This must be decided before defining cache/storage layout.
4. How will matching dependency declarations be supplied for each revision without automatic installs? What limited mode remains useful and clearly labelled when the exact dependency context is absent?
5. What is the smallest IPC change that admits cancellable query IDs and readiness events without weakening serialized session/progress writes or existing shutdown ownership?
6. Where should reusable snapshot/language capabilities live versus standalone-only integration? Audit existing core capabilities first; do not create a new package or expose protocol DTOs from core merely for this consumer.
7. What trust identity, invalidation rules, resource budgets and supported-platform qualification does the first usable slice need? Cross-platform shortcuts are not evidence of Mac or Windows behaviour.

## Planning checkpoints

This file fixes the scope and correctness bar. After review, the next layer chooses the architecture and records genuine alternatives; subsequent layers define typed Rust/TypeScript contracts, flows, affected files, real-seam tests and usable delivery slices. No dependency addition or product implementation is part of this checkpoint.

Guidance: [resource ownership](https://ratstack.sh/lore/scopes-own-resources), [decoded boundaries](https://ratstack.sh/lore/schemas-define-the-boundary), repository `AGENTS.md` and coding standards for modules, async work, parsing and real-seam verification. This document specifies required behaviour; it does not claim an untested server or renderer integration already provides it.
