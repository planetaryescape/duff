# Vertical verification plan

Use TDD through the public feature seam: one discriminating failure, the smallest correct implementation, then refactor. Do not substitute ordinary unit mocks for a real language server or a temporary Git repository.

## 1. Revision-correct source context

- Red: base imports a number-typed symbol from one unchanged declaration; head imports a string-typed symbol whose definition moved. Target tip differs again. Dirty the managed checkout. Assert independently specified base/head types and definition paths.
- Green: resolve exact saved comparison revisions and immutable project sources.
- Refactor: keep Git/environment ownership in core and LSP projection outside it.

## 2. Safe, honest enablement

- Red: queries before trust fail; incomplete third-party context reports limited; missing server/startup failure never reports ready. A project plugin with a marker side effect and automatic typing acquisition must not execute/download.
- Green: pinned trusted toolchain, explicit enablement and finite readiness.
- Verify no changes to owner-like repositories, config, manifests, lockfiles or saved review contents.

## 3. Actual symbol coordinates

- Red: native events around tabs, non-BMP characters, wrapped punctuation, CRLF, split left-context and horizontal scroll hit neighbouring symbols with different types.
- Green: Rune shaped-text hit testing, inverse display transformation and boundary UTF-16 conversion.
- Refactor: use the same mapping for hover and actual modifier-click; ordinary text drag/copy still works.

## 4. Useful native hover and definition peek

- Red: actual pointer and F12 events query the intended side; hover remains usable when entered; unchanged definitions and multiple targets are inspectable; Escape/Back returns to the same diff position and selection without marking viewed.
- Green: native cards/peeks with real protocol results, bounded text and explicit no-result state.
- Inspect captures and record pointer/keyboard interactions at representative widths, split/unified, long docs and non-default states.

## 5. Boundaries and lifecycle

- Red: malformed/oversized LSP frames, invalid locations, arbitrary schemes and symlink/root escape cannot read files. A delayed result cannot overwrite a switched file or dismissed card. Viewed writes remain usable during language work.
- Green: typed boundary decoding, bounded transport, correlation and scoped cancellation.
- Close the actual native window during startup and an active language request; verify both LSP and tsserver descendants are gone. Exercise server crash and explicit retry.

## Completion checks

Run root `bun run check`, `bun run test`, `bun run build`, plus frozen clean install, native bootstrap/idempotence, locked Rust build and source-position tests. Reuse an isolated Mac host/data directory for a real owner-review qualification without installing PR dependencies. Public Git fixture evidence can go in PR26; keep private provider/source captures private. Repeat critical checks after review fixes and on the exact commit intended for merge. A generic fixture pass is not proof that the private project's dependency context is complete.
