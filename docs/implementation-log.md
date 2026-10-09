# Implementation log

## 2026-10-09: Local review and development workflow

Related: S01, S02, D001, D002.
Baseline: inspected local commits titled `feat(review): compare branches in native diffs` and `build(dev): start Bun watcher with F5`.

Result: Duff now has a dedicated Activity Bar entry, branch comparison, a changed-file list, native immutable diffs, and workspace-file navigation.
Effect and @effect/vitest are pinned to stable 4.0.2, confirmed against the package registry.
The local pre-commit hook runs check, test, and build.

| Check | Result | Evidence or limit |
| --- | --- | --- |
| `bun run check` | Passed | Strict TypeScript and type-aware ESLint |
| `bun run test` | Passed, 3 tests | Real Git repositories test divergence, dirty edits, unusual paths, renames, detached HEAD, empty reviews, and typed failures |
| `bun run build` | Passed | Node-targeted CommonJS extension bundle |
| Native UI | Passed for exercised flows | Isolated VS Code host: icon, compare button, picker, four file statuses, side-by-side diffs, workspace-file action |
| Dirty workspace distinction | Passed | Committed diff shows value 2; separate real-file editor shows value 99 |
| Bun watch | Initial build and rebuild observed | Background task matcher updated to Bun's actual `Bundled` output |
| Full F5 session | Not independently exercised | Launch/task wiring inspected; development host launched separately |
| Provider features | Not run | Not implemented |

Visual evidence is local under `.amp/in/artifacts/`, not committed or public.
Known limits: historical LSP behavior, binaries, large repositories, and automatic branch refresh are not qualified.
The fence is partial compared with rat-stack; see [architecture limits](blueprint/01-architecture.md#fence-and-limits).

Delivery: review slice and development workflow committed locally as separate commits with the titles above.
No push, merge, publication, or deployment was performed.

## 2026-10-09: Identity and provider blueprint

Related: D003–D005, S03–S06.
Result: documented the owner's required order, safe Git-context inspection, and GitHub/Azure provider-plugin boundaries.
Used the owner's `maintaining-blueprints` skill and templates from `~/dotfiles`.
Provider requirements are accepted but not implemented. Built-in plugin packaging and authentication mechanisms remain proposals.

Verification: repository-relative document links and status claims checked against current files and executed evidence.
This documentation does not establish runtime behavior for identity inspection or provider discovery.
Remaining work: implement and verify S03 before provider discovery, then settle packaging/authentication choices for S04.
Delivery at authoring: local documentation edits, pending their own atomic documentation commit. No provider code was changed.

## 2026-10-09: Editor Node-global configuration

Result: explicitly enabled Node ambient types and configured VS Code to offer the workspace TypeScript version.
The owner reported `Cannot find name 'AbortController'` in the editor. The current command-line compiler did not reproduce it.
Verification: check, all 3 tests, and build passed. Installed Node declarations include AbortController.
Remaining uncertainty: the original editor's language-server state was not inspected. The owner may need to select Workspace Version and restart TS Server.
Delivery: separate local commit titled `fix(types): declare Node globals for the editor`. No runtime cancellation code was changed.
