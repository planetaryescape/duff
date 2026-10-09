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

## 2026-10-09: List and tree layouts

Result: Changed Files now switches between a flat list and expandable directory tree using its toolbar or the command palette.
The workspace remembers the layout across development-window reloads. Both layouts retain immutable diffs and workspace-file actions.
List descriptions distinguish matching filenames in different directories. Tree mode includes only changed paths, not the whole workspace.

Verification: check, 3 existing Git tests, and build passed. An isolated native VS Code host exercised list/tree switching, nested folders, duplicate filenames, diff opening, workspace-file opening, and saved tree layout after reload and a new comparison.
Inspected screenshots: `.amp/in/artifacts/file-list.png` and `.amp/in/artifacts/file-tree.png`.
Delivery: prepared as one local feature commit, with no push or publication. Git-context inspection remains the next slice.

## 2026-10-09: Local Git-context inspection

Related: S03, D003. Result: native Git Context view with explicit inspection/refresh, effective configured identity and provenance, separate author/committer, sanitized fetch remotes, safe helper declarations, and SSH-command metadata.
No credential helper is executed, no key is read, and no network authentication is attempted.
Per-remote helper selection, credential username, and `useHttpPath` remain incomplete; the UI states that helper selection is unresolved.

The first isolated tests missed Apple Git's built-in `unknown` scope. The actual development host reproduced the failure. Duff now preserves that valid scope, with a platform-config regression check alongside isolated fixtures.
The failure panel updates before awaiting notification dismissal and clears previous identity rows.

Verification: check, 7 real-Git tests, and build passed. Native inspection succeeded with the host's inherited osxkeychain helper. Injecting invalid config into the disposable UI fixture produced an explicit failure state; the fixture was restored afterward.
Inspected screenshots: `.amp/in/artifacts/git-context.png` and `.amp/in/artifacts/git-context-failure.png`.
Delivery: local feature commit; no push, publication, or provider discovery.

## 2026-10-09: Authenticated Hetzner operation telemetry

Result: named operation spans and correlated outcome logs export through the existing authenticated Planetaryescape collector to Tempo and Loki in development mode.
The launcher scopes the decrypted SOPS token to VS Code's separate development profile. Missing or invalid authentication disables export. Normal extension mode does not export.
Serialization removes private attributes and exception details; Git errors no longer expose raw command diagnostics. Exporter lifetimes belong to the managed runtime.

Verification: check, all 8 tests, build, and Fish syntax checks passed. The telemetry test verifies nested parent spans, failure status, outcome correlation, authentication headers, and removal of private payloads.
An isolated, authenticated native host exercised Git-context inspection, branch selection, comparison, and immutable diff reads. Read-only queries against Hetzner Tempo and Loki confirmed real Duff data, not just a connectivity smoke trace.
Example comparison trace: `53c79e081f07317dc7494d1066c9497f`. Branch-listing trace `e5e7e55700ecb15e6ed4f9b51d2926f2` has the same trace ID in its Loki outcome log.

Two integration issues were fixed during validation: Bun's CommonJS output needed explicit import.meta definitions for Node activation, and the composition root needed provideMerge to retain the tracer for runtime operations.
Limits: the skill prefers protobuf; this exporter uses accepted OTLP HTTP JSON for privacy projection. The collector adds tunnel pod metadata to external logs. No shared infrastructure was changed.
The exact launcher has a syntax check; native authentication was exercised with an equivalent scoped launch using an isolated profile. Automatic extension-host hot reload remains unimplemented: Bun rebuilds, then Developer: Reload Window activates the changes.
Delivery: one local observability slice, with no push, publication, or deployment.

## 2026-10-09: Open the current file from a diff

Result: the existing Open Workspace File action is available in the Duff snapshot editor toolbar and command palette, not only on changed-file rows.
The active diff's modified-side snapshot supplies the repository and path independently of the latest comparison. The real file opens in a non-preview tab; committed diff contents remain unchanged.
Snapshot inputs are decoded with the existing Schema before opening a file. Missing working-tree files retain the existing safe error handling.

Verification: check, all 8 existing tests, and build passed. An isolated native host exercised the toolbar and command palette. The committed diff showed value 2; the action opened the same file's uncommitted value 99 in a normal editor tab.
Inspected screenshots: `.amp/in/artifacts/open-current-diff.png` and `.amp/in/artifacts/open-current-file.png`.
VSCodium also exercised the deleted-file information state. A real-repository check in `~/source/oss/gbfm` matched Git's two changed files against origin/prod and opened the real render.ts from its diff toolbar. The branch and pre-existing untracked files remained unchanged.
Inspected real-repository screenshots: `.amp/in/artifacts/gbfm-current-diff.png` and `.amp/in/artifacts/gbfm-current-file.png`.
Renamed-file selection follows the modified-side path by construction but was not independently exercised in this native check.
Delivery: local feature slice; no push, publication, or deployment.

## 2026-10-09: Feature-owned Bun workspace

Related: D006. Result: two private workspace packages, headless core and VS Code extension, with explicit exports and one lockfile. Review and Git-context modules now keep schemas, errors, service contracts, Git Layers, and tests together. The proposed third Git package was discarded before committing.
The root coordinates check, test, build, watch, and packaging. F5 and the Fish launcher now use `packages/extension`. The extension supplies GitContext's environment at activation instead of core capturing it on import.
This intentionally follows OpenCode v2's runtime-capable core rather than rat-stack's strict adapter-package separation. The fence rejects core imports of VS Code and extension code; it does not prove every alias or re-export boundary.

Verification: frozen Bun install, both package typechecks, ESLint, all 8 existing tests, build, VSIX packaging, and Fish syntax passed. A negative ESLint probe rejected VS Code and relative extension imports from core.
The VSIX contains the manifest, bundled CommonJS, and icon, with no workspace symlinks, source, node_modules, or source maps. It installed successfully into the isolated VSCodium profile.
The installed artifact compared gbfm's current branch against origin/prod, showed the same two changed paths as Git, opened the render.ts committed diff, and opened its current file through the toolbar. gbfm's branch and existing untracked files were unchanged.
Inspected screenshot: `.amp/in/artifacts/workspace-installed-diff.png`. This packaging check used normal extension mode, so no telemetry exporter ran. Full F5 automation and authenticated Hetzner delivery were not rechecked in this structural slice.
Delivery: prepared as a local workspace commit. Feature command extraction is the next behavior-preserving slice. No push, publication, or deployment.

## 2026-10-09: Feature-owned extension registration

Result: review and Git-context command registration live beside their respective views. The 24-line extension entrypoint assembles Layers, coordinates the two features, and owns runtime disposal. Shared operation failure/telemetry handling and workspace-folder selection have separate editor-boundary modules, used by both features.
The workspace slice above was committed locally as `refactor: group features in a Bun workspace`. This second slice preserves command IDs, messages, saved layout, pinned diffs, cancellation handling, subscriptions, and Git-context invalidation on successful comparison or refresh.
The fence additionally rejects relative imports of core source from extension code; a negative stdin probe confirmed the restriction. Existing runtime-construction restrictions remain in place.

Verification: both typechecks, ESLint, all 8 existing tests, build, and VSIX packaging passed. A clean VSCodium development host on gbfm exercised branch selection against origin/prod, the two expected files, immutable diff rendering, current-file opening, list-to-tree switching, context inspection, and comparison refresh. DOM checks confirmed successful identity inspection and that refresh cleared identity rows while retaining the two-file tree.
Inspected screenshot: `.amp/in/artifacts/feature-owned-diff.png`. gbfm's branch and existing untracked files stayed unchanged. Obsolete test hosts were closed before replacement; one development host remains for inspection.
Limits: the pending-inspection race and full F5 launch were not independently automated in this slice. Their existing request-generation and launch wiring were preserved. No authenticated telemetry export was attempted during this refactor.
Delivery: prepared as a separate local refactor commit. No push, publication, deployment, provider integration, or infrastructure changes.
