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

## 2026-10-10: Per-remote credential policy increment

Related: S03, D003, plugin Slice 1. Result: conventional HTTP(S) remotes now show configured helpers after resets, configured username, and `useHttpPath` with provenance. The native tree groups policy beneath each remote and keeps all helper declarations in a separate collapsed group. SSH explicitly reports that HTTP credential helpers do not apply.

Git supplies include/scope expansion, URL matching, and boolean decoding. Unique synthetic marker keys preserve every matching declaration; Duff folds them in config order rather than incorrectly selecting one most-specific helper. Temporary config goes through stdin, and subprocess input/output share the operation's cancellation signal. No credential helper, network authentication, login, fetch, or provider API was invoked.

Verification: the new public-service regression failed before implementation, then passed. Both typechecks, ESLint, all 9 tests, build, and VSIX packaging passed. Real Git fixtures cover helper accumulation, resets, path boundaries, last-matching scalar precedence, boolean defaults and implicit true, separate SSH, unresolved partial patterns, and the existing secret canary. Packaging initially failed because the temporary Bun vsce cache lacked usable dependencies; reinstalling that disposable cache fixed it without repository dependency changes.

Native verification reused one isolated VSCodium host. A disposable repository showed cache/host-only and manager/path-aware policies, a separate SSH state, an unresolved userinfo-bearing URL, and expanded safe declarations. DOM checks excluded the synthetic secret. Inspected screenshots: `.amp/in/artifacts/credential-http.png` and `.amp/in/artifacts/credential-declarations.png`. The fixture was removed, and the host returned to gbfm. gbfm's comparison against origin/prod still produced Git's two expected paths and opened the render.ts diff. Its branch and six preexisting untracked PNGs stayed unchanged.

Limits: userinfo-bearing remotes, encoded/nonstandard paths, and partial/user-qualified or unsupported credential patterns remain explicitly unresolved. This is a usable increment, not complete S03 or provider discovery. The new VSIX was packaged but not reinstalled for this increment. Authenticated telemetry export and ADO native discovery were not exercised. The approved frontend repositories remain available for the Azure slice.

Delivery: prepared as one atomic local feature commit, `feat(git-context): show per-remote credential policy`. No push, publication, merge, deployment, or shared infrastructure change. Blueprint progress now records implementation authorization; full-folder Plannotator feedback has not returned.

## 2026-10-10: Shared plugin contract and usable GitHub discovery

Result: one provider capability owns recognition, silent authentication, explicit connection, and paginated open-PR reads. The registry-driven core service preserves independent ordered outcomes, rejects ambiguous routes without I/O, validates issued cursors, and discards them on refresh. GitHub owns protocol decoding, trusted browser URLs, draft/fork normalization, session-bound pagination, and cooldowns. Native integration cancels replaced inspection/discovery work, retains partial pages, deduplicates repeated PRs, and keeps review independent. A setting disables provider reads entirely.

Native sessions and Effect HttpClient are supplied at construction. Construction does not authenticate or make requests. Connect is the only prompting operation and discloses broad permissions. HTTP requests reject redirects and have a 20-second deadline; native silent authentication has 12 seconds and Connect 120 seconds. The editor authentication promise is not cancellable underneath; generation checks prevent its late completion from publishing stale results. No credential helper runs. Named spans and truthful partial summaries retain the existing development-only export privacy projection.

Verification: workspace typechecks, ESLint, supplied-service/HTTP tests, GitHub adapter tests, existing Git regressions, and build passed. Deterministic native fixtures in one isolated VSCodium host on gbfm exercised draft/fork rows, explicit Load More, duplicate replacement across pages, completed pagination, a next-page outage that retained earlier PRs, and independent missing-authentication presentation. Inspected captures: `.amp/in/artifacts/provider-first.png`, `provider-complete.png`, `provider-partial.png`, and `provider-auth.png`. The fixture banner makes clear that these are not live provider results. The Azure fixture is part of the next adapter slice, not this commit's registry.

Limits: no real provider requests, sign-in, fetching, checkout, PR mutation, or authenticated telemetry export was used in these checks. Advanced credential patterns remain safe unresolved states; provider sessions do not depend on them. gbfm changed branch/worktree state externally during this session; Duff did not perform those changes. Opening a PR locally remains S06, not part of discovery.

Publication: at the owner's request, checked tracked history for common credential forms and unpublished artifacts, then created public `https://github.com/planetaryescape/duff` and pushed the committed baseline. Matches were synthetic canary fixtures. This is repository publication, not a package release or deployment. The feature increment is prepared as a separate atomic commit; its push follows verification.

## 2026-10-10: Azure DevOps parity and packaged verification

Result: the built-in Azure DevOps adapter is registered alongside GitHub without provider-specific host branches. It recognizes modern/legacy HTTPS and Azure v3 SSH remotes, uses a supplied Microsoft session, normalizes active PRs and forks, validates session-bound continuations, and observes retry cooldowns. Missing authentication remains a failure, not an empty result. Blueprint status now distinguishes implemented discovery from the proposed local-PR review follow-up.

Verification: both typechecks, ESLint, all 35 tests, build, and VSIX packaging passed. Azure adapter tests cover remote recognition, empty and multi-page results, drafts, forks, malformed responses, authentication failures, interruption, continuation validity, and cooldowns. Read-only GitContext inspection of the approved srx-app checkout fed the real Azure adapter and shared service with a supplied absent session: recognition succeeded, AuthenticationRequired was returned, and HTTP calls remained zero.

Native fixture captures show both providers, completed and failed pagination, and independent authentication states; see the preceding entry. Reloading the latest fixture bundle also confirmed accessible provider/PR labels include provider names, IDs, and draft state. These are supplied-service results, not authenticated account evidence.

The new VSIX contains only the manifest, bundle, and icon. It installed successfully into the isolated VSCodium profile. One normal installed-extension window replaced the fixture host on gbfm, with automatic discovery disabled. The comparison against origin/prod showed Git's 22 committed changed paths on the current feat/admin-featured-mix branch, opened the exports.ts native diff, and opened its real file through Open Workspace File. Inspected screenshot: `.amp/in/artifacts/providers-installed-review.png`. Existing dirty gbfm files were left untouched. The Azure checkout remained clean. Scratch verification code and the fixture harness were removed after checking; obsolete test windows were closed.

Limits: real provider requests and native sign-in remain unverified. No fetch, checkout, provider mutation, authenticated telemetry check, deployment, or shared infrastructure change ran. Advanced credential patterns remain explicitly unresolved. The packaged VSIX is a local artifact, not a Marketplace release. Public repository publication is authorized separately by the owner at `https://github.com/planetaryescape/duff`.

## 2026-10-10: Manual pull-request checks

The owner requested a button inside the Pull Requests pane. Automatic discovery being off now shows a native Check Pull Requests button. The button, toolbar action, and post-connection refresh perform explicit manual discovery through fresh Git-context inspection without enabling background reads or prompting for login.

Verification: check, all 35 tests, build, and packaging passed. A disposable supplied-service fixture in VSCodium on gbfm showed zero discovery reads at startup, one read after activating the button, the expected fixture PR, and no additional read after ordinary Git-context refresh. The setting remained false. Inspected screenshots: `.amp/in/artifacts/manual-pr-button.png` and `manual-pr-result.png`. No real provider requests or sign-in ran. The fixture was removed and the updated VSIX installed into the existing isolated profile.

## 2026-10-10: Discoverable Git-hosting contract

The shared GitHub/Azure DevOps contract now lives in core/plugins/GitHostingProvider.ts, separate from generic lifecycle in Plugin.ts and execution policy in ProviderDiscovery.ts. Errors and schemas remain beside their owning contract. Both adapters and callers import the explicit @duff/core/git-hosting-provider export; no compatibility barrel or additional abstraction was added.

Reference: OpenCode v2 keeps generic plugin lifecycle in packages/plugin/src/effect/plugin.ts and domain contracts in adjacent files such as vcs.ts. Its provider.ts concerns AI models, so Duff uses the more specific GitHostingProvider name. This is a behavior-preserving file-ownership change, not a copy of its plugin machinery.

Verification: both typechecks, ESLint, all 35 existing tests, build, and VSIX packaging passed. Tests changed only their import paths. No provider network requests or native sign-in ran; the existing test window was left alone.

## 2026-10-10: Core-owned pull requests and review session

Replaced generic plugin lifecycle and editor-owned discovery with job-shaped GitHostingProvider, grouped PullRequests and one Effect-owned ReviewSession. Equivalent remotes share one repository group; reads emit progressively with four-way concurrency. Continuations remain private. Same-repository refresh retains PRs as Refreshing, failure marks them Stale, and repository replacement cancels jobs and clears previous rows. Pagination deduplicates by target repository and PR ID. Rate-limit delays use the Effect clock.

Core owns GitHub/Azure DevOps recognition, protocol normalization, HTTP service, authentication contract and adapter tests. Extension commands/views consume session state and group actions only. The composition root supplies native authentication and HTTP transport through the built-in Layer export. ESLint rejects VS Code in core and provider construction in editor commands/views; negative import probes confirmed both restrictions. Generic Plugin, ProviderDiscovery and PluginLayers are removed. Blueprint D007 supersedes the historical plugin chapters without deleting their design history.

Verification: both typechecks, ESLint, all 40 tests, build and VSIX packaging passed. Tests cover grouping, ambiguity, fast-before-slow progression, retired IDs, continuation cycles/retries, cancellation, refresh retention, stale failures, cooldowns, deduplication, scope disposal, and paging a Ready group while another is still discovering. Failed connection interrupts a slow sibling and leaves retained pages explicitly Stale with pagination disabled.

A disposable supplied-provider fixture exercised real core/session code and native commands/views in VSCodium on gbfm, without API requests. Inspected captures under `.amp/in/artifacts/`: `session-ready.png`, `session-progressive.png`, `session-paged.png`, `session-refreshing.png`, `session-stale.png`, `session-error-tooltip.png`, `session-switched.png`. The full error is available on hover when native row descriptions truncate. Repository replacement with discovery disabled removes every prior group/PR and restores Check Pull Requests.

The fixture was removed, obsolete test windows closed, and the updated VSIX installed. One normal VSCodium window remains on gbfm with automatic discovery disabled. Native comparison against origin/prod showed 23 changed files, matching Git, and opened the exports.ts immutable diff and then its real workspace file. Existing dirty gbfm files were left unchanged.

Limits: real provider requests, native sign-in and the account-change path remain unverified. No fetch, checkout, provider mutation, telemetry export, deployment or infrastructure changes ran. Bitbucket, opening PRs as local reviews, polling and persistence remain deferred. This is local delivery, not a Marketplace release or remote push. The unrelated untracked review-workspace-problem-ux.md draft remains untouched.
