# Shape

## Ownership

- Rust owns code-position events, hover/peek presentation, correlation with the current review and restoring navigation.
- The standalone Node composition owns trusted language-server startup, protocol translation and query cancellation in Effect-owned lifetimes. It does not run project-selected executables.
- Core owns immutable Git sources; any new tree-reading operation belongs with the existing Git review capability and uses its environment/command policy. No new package is needed.
- Analysis gets separate source contexts for `baseCommit` and `headCommit`; the retained editable checkout is never its source of truth.

## Flow

1. Reviewer explicitly enables code intelligence for this review, after reading its trust/limited-context explanation.
2. Prepare bounded, revision-keyed source contexts using pinned Git objects, including unchanged imports and configuration.
3. Start trusted pinned TypeScript tooling with automatic typing acquisition and project plugin loading disabled; prove those settings before claiming support.
4. Rune maps the actual native text event back through display transformations to original file, side, source line and UTF-8 byte column.
5. Rust converts the original prefix to UTF-16 and issues a correlated hover/definition request.
6. Node selects the correct revision context and decodes bounded LSP results.
7. Rust rejects obsolete results and shows native, read-only content. Peeking at unchanged code does not alter review progress.
8. Dismiss/review replacement cancels query ownership; app close disposes server processes and retained analysis resources before Node exits.

## Renderer dependency

Upgrade upstream Rune and rune-kit together to `3062e9b86b5a02b97c8ed4e8f49fcfc4d6902fc1`. Latest still lacks source-position callbacks. Carry a narrow, reproducible source patch, not an entire vendored renderer or undocumented app-side tree-key/character-width calculations. Bootstrap a project-local ignored checkout at the exact upstream commit and apply the known patch. Explicit Cargo patch configuration and lockfile keep the build reproducible from arbitrary working directories. Never mutate the global Cargo cache. Document the bootstrap as a build prerequisite.

## Concurrency

Keep saved-review mutations ordered. Make transport response IDs independent of arrival order so language queries do not block navigation/progress. Each UI query has a generation; cancellation is an optimisation, generation matching is the correctness boundary. Do not add unbounded task queues or replay transient hover work after restart.

## Known limits

Without revision-matched third-party declarations, source-local answers are useful but the context is explicitly **limited**, not fully ready. No automatic install/build/plugin execution is part of enablement. The server runs as the user, not inside an OS sandbox. Failure of language analysis leaves the existing review functional.
