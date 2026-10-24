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

## 2026-10-10: Provider-owned transport composition

Moved built-in provider HTTP wiring from extension.ts into core/pull-requests/Providers.ts. GitHubHttp.ts and AzureDevOpsHttp.ts now make the implementation choice visible beside their shared GitHostingProvider contract. The extension supplies native authentication only for this capability; its independent telemetry HTTP client remains unchanged.

The shared contract already exposed authentication and normalized PR-page jobs without HTTP dependencies, so no generic request transport or extra registry service was added. Core can substitute a CLI-backed implementation through makePullRequestsLayer without changing ReviewSession or editor consumers. The current blueprint records that seam, authentication/cancellation constraints and the distinction between supported contract and unimplemented CLI adapters. This follows rat-stack's job-shaped boundaries while preserving Duff's approved feature-owned runtime core.

Verification: both typechecks, ESLint, all 41 tests, build and VSIX packaging passed. The added composition test supplies fake Fetch and native-authentication seams and exercises both built-ins through PullRequests without host HTTP wiring. It verifies distinct normalized GitHub/Azure results and rejection of a redirect with manual redirect handling. No real provider requests, sign-in, telemetry export or native UI changes ran for this transport-only slice. Earlier native session verification is recorded above, not claimed as a new packaged-host smoke test.

Delivery at recording: verified local edits, awaiting atomic commit and the owner-authorized push. The two preceding local commits are also awaiting that push. No release, deployment or infrastructure changes are included. The unrelated untracked review-workspace-problem-ux.md draft remains untouched.

## 2026-10-10: Ref ownership and type-aware tooling

PullRequests now owns discovery generation through an Effect Ref. Each discovery captures its incremented value. This aligns service state with Effect ownership; no race in the preceding synchronous increment was demonstrated. This was committed separately from the tooling migration.

Type-aware Oxlint replaces ESLint. Pinned @effect/tsgo patches TypeScript 7.0.2, Oxlint 1.87.0 and its tsgolint companion during Bun install. Oxfmt and the complete vendored anti-slop package follow the sibling foldkit-mde setup. Existing application boundary rules remain enforced through native import restrictions and a small local runtime/span rule. Blueprint policy exceptions distinguish accepted function-valued services, unstable APIs, test composition and narrow framework/Schema exceptions from enforcement gaps. Application files were formatted; required lint adjustments preserve optional-property omission and decode virtual-document JSON through Schema.

Verification: frozen Bun install confirmed patched hashes; formatting, all three package typechecks and type-aware lint passed. All 41 application tests and anti-slop rule tests passed. Build and VSIX packaging passed. Disposable negative probes rejected VS Code imports in core, provider imports in editor views, runtime execution outside the entrypoint, floating Promises, unsafe JSON assignments, and an aliased floating Effect. Probe files were removed. No new native host smoke test, real provider request, sign-in or telemetry export ran for this tooling slice.

Delivery at recording: Ref slice committed locally; tooling verified and ready for its own atomic commit and the owner-authorized push. No Marketplace release, deployment or infrastructure change is included. The unrelated untracked review-workspace-problem-ux.md remains untouched.

## 2026-10-15: CLI-only Azure authentication

Azure now obtains an Azure DevOps resource token from the existing Azure CLI session. The REST adapter, wire decoding, active-only discovery and continuation policy remain in place. GitHub keeps native editor authentication. There is no Azure authentication selector, Microsoft editor fallback, login command, CLI default change or fabricated account identity. Source labels remain available on failed groups; Connect explains and rechecks the CLI session.

The core adapter owns shell-free subprocess execution outside the workspace, captured activation environment, numeric expiry decoding, redacted credentials, finite safe errors, a 12-second timeout and caller interruption. POSIX process-group cleanup covers the CLI wrapper and descendants. Known missing-login diagnostics are matched privately; unknown CLI failures remain unavailable rather than guessed. CLI command-file logging and dynamic extension installation are disabled for the child. Azure CLI still owns its own cache refresh behavior.

Verification: `bun run check`, `bun run test`, `bun run build` and `bun run package` passed, including 49 application tests and the anti-slop rule tests. Real executable fixtures cover valid credentials through Azure REST normalization, missing CLI/login, malformed and expired output, header injection, safe errors, timeout and interruption with actual descendant termination. Existing adapter tests cover same-token pagination and changed-token InvalidContinuation before a page request. Standards self-review covered parsing, typed errors, redaction, Effect lifetimes, boundaries and real test seams.

The first commit hook exposed an existing Git fixture isolation defect: inherited hook repository variables redirected temporary Git commands into Duff metadata. Recovery restored the known starting feature ref and configuration without resetting source files; generated test commits remain reachable through private recovery refs. The primary main ref stayed unchanged. BranchReview fixtures now supply an isolated environment. Both production local Git adapters remove repository-redirection variables, retaining user configuration and identity overrides. BranchReview now receives its environment at activation. A real two-repository regression verifies target comparison and context inspection while source refs and status remain unchanged under inherited redirection variables. The normal hook must pass before delivery; it is not bypassed.

The self-contained VSIX was installed in the isolated VSCodium profile and launched from its installed directory as an Extension Development Host, not from workspace source. Installed and built bundle SHA-256 hashes matched. Read-only discovery on the owner-approved Azure repository returned 12 active PRs; abandoned PR 7152 was absent. The UI showed Azure CLI and Account identity not verified. An isolated PATH without az exercised the missing-CLI state, Recheck and Cancel. Sanitized, inspected screenshots and a real 16-second interaction clip are retained locally under `.amp/in/artifacts/azure-cli-*`. The host uses custom dialogs for capture; normal profile settings and working windows were not changed.

Packaged local review on gbfm showed 49 committed changed files against fix/youtube-embed-referrer, matching Git, and opened the exports.ts side-by-side diff. Repository branch/status/config fingerprints were unchanged for both owner repositories. One useful isolated host is retained with the real CLI environment.

Grafana returned HTTP 200 for fresh Duff traces and logs. Trace 193e0afa99e2c6d711810361e27631f4 contains AzureCliAuthentication.session, ProviderAuthentication.session, AzureDevOps.listOpenPullRequests and the discovery workflow, with 41 spans, zero span attributes and zero events after privacy projection. Eighteen recent Duff log records were found. In-memory trace/log audits found no bearer/token patterns; only safe audit projections were saved. Diagnostic forwards were stopped after use.

Limits: all 12 real PRs fit one page, so real paging and natural token rotation/expiry were not exercised. Deterministic tests cover those boundaries. Windows CLI executable handling and descendant cleanup, other tenants and native GitHub sign-in remain unqualified. Normal production mode still disables telemetry export; the installed-artifact Development Host uses the existing SOPS-scoped header. No credentials or raw provider/CLI outputs were saved as evidence.

Delivery at recording: verified feature-worktree changes prepared for the owner-authorized commit, push and PR. The primary checkout remains clean on main. No merge, deployment, Marketplace publication or provider write is included.

## 2026-10-15: Explicit viewed progress

Added reversible Mark as Viewed / Mark as Unviewed actions to changed-file rows and the active immutable diff toolbar/palette. Opening a diff does not mark it. Both native layouts show hollow/checked icons, accessible viewed labels and a viewed/total count. ReviewProgress in core owns snapshot identity, changed-path membership, mark/unmark transitions, saved-state shape and exact two-sided diff targeting. The extension decodes one workspace-state record and persists only the current root/base/head comparison. Selecting the same comparison after editor reload restores marks; choosing another comparison replaces them. Provider state, Git data, navigation and development-only telemetry policy are unchanged.

Verification: `bun run check`, `bun run test`, `bun run build` and `bun run package` passed, with 52 application tests plus the existing anti-slop suite. Three new public-contract tests cover persistence round trips, exact root/base/head isolation, stale mark rejection, empty added/deleted sides, rename paths and generated mark/unmark histories. Temporary mutations that omitted base-commit identity or ignored the original diff side each caused the relevant test to fail; both were restored and the targeted suite passed again.

The packaged VSIX was installed into the existing isolated VSCodium profile, then run from its installed directory as a Development Host with third-party extensions disabled. Built and installed bundle hashes matched. A read-only gbfm smoke comparison showed 49 files and explicit marking on exports.ts; branch/status/config and working-diff fingerprints remained unchanged. A disposable real-Git fixture exercised added, modified, deleted and renamed files, both diff focus sides, row and toolbar actions, command-palette marking, unchanged refresh, list/tree switching and editor reload followed by comparison selection. A new fixture commit reset marks to 0/4; the open old diff retained its original content and offered no mark command. An ordinary workspace editor likewise offered no palette/toolbar mark target. Stale tree-item rejection and other-repository/base isolation are covered through the core contract rather than native injected objects.

Inspected, privacy-checked captures are retained in the primary workspace under `.amp/in/artifacts/`: `viewed-list-unviewed.png`, `viewed-list-viewed.png`, `viewed-tree.png`, `viewed-deleted.png`, `viewed-stale-diff.png` and `viewed-mark-unmark.mp4`. The 19.4-second clip records real host frames and genuine pointer/click events across adjacent toolbar and row controls. A yellow cursor overlay follows those pointer events; no review content or state was fabricated. Captures contain only the disposable fixture, without identity, home paths or credentials.

Standards self-review found no remaining correctness or boundary findings in the changed paths. Existing lint policy gaps remain as documented in the architecture chapter. The normal pre-commit check/test/build gate is required for delivery and is not bypassed. No provider calls, sign-in, telemetry-export validation, deployment or owner-repository mutations were needed for this slice. Binary and large-repository review remain outside the qualification.

Delivery at recording: local feature worktree ready for the authorized commit, push and PR against main. Primary main is clean and synchronized to origin/main after merged PR #2. One isolated fixture host remains available for inspection; owner windows were not used. This is not a merge, release or deployment.

## 2026-10-15: Immutable local PR review for GitHub and Azure

Selecting a discovered PR now prepares a local immutable review instead of opening a browser. Both adapters reread one selected PR behind the shared provider boundary. PullRequests binds exact source/target SHAs to independently matched repository identities, including forks. Missing source access or exact revisions fails without substituting HEAD or a synthetic merge commit. BranchReview compares the unique common ancestor of those pinned commits to source; unrelated/shallow history and criss-cross ambiguity fail explicitly.

Local objects need no permission. Missing objects pause for an explicit native consent action, then Git acquires only required revisions into two bounded Duff-owned refs. Fetch disables tags, pruning, FETCH_HEAD, remote-tracking refmaps, submodules, hooks and automatic maintenance; safe configured HTTPS/SSH remotes use existing Git credentials, never API tokens. Raw-SHA fetch can fall back to a named branch only when its resulting SHA matches the pinned revision. No source URL is invented for an unmatched fork. Git subprocesses have output/time bounds and owned POSIX process-group cancellation. The existing repository-redirection environment isolation remains in place.

PullRequestReview owns preparation fibers, the consent pause and retained accepted snapshot. Superseded work is interrupted; repository replacement clears it. Failure/cancel retain the review. Native commands expose explicit PR refresh and exit; immutable diffs and current-snapshot viewed marks are reused. A new comparison resets marks, and old tabs cannot mark it. Local comparison completions are guarded against newer preparation. Marking does not overwrite preparation/failure messages. Opening a workspace file warns about current-checkout differences. Browser opening remains a secondary row action. Telemetry export policy is unchanged.

Verification: `bun run check`, `bun run test`, `bun run build` and `bun run package` passed, with 59 application tests plus the rule suite. Public-contract tests cover both providers' fresh details and fork identity, absent Azure revisions, pinned consent, supersession/cancellation and retained accepted state. Real temporary Git repositories cover local commits independent of HEAD, asymmetric divergence, dirty index/worktree invariants, consent gating, bounded fetch mutations, moved fallback branches, shallow/unrelated history, multiple merge bases and actual transport-descendant termination. Standards self-review traced parsing, typed failures, async ownership, package boundaries and privacy through the changed workflow.

The packaged artifact was installed and its bundle hash matched the build. A new disposable VSCodium profile and extensions directory under primary `.amp/in/pr-native/`, on CDP 9444, replaced use of the existing shared profile after that profile changed repositories unexpectedly. The shared window was left untouched from then on. Installed-artifact gbfm smoke testing showed 60 committed changed files, matching Git, and opened a populated immutable CHANGELOG diff. Only Git reads and diff commands were issued against gbfm. Its broad before/after fingerprint changed during the session, so whole-session content stability cannot be certified; nothing was restored or overwritten. Disposable real-Git tests independently verify mutation invariants.

Sanitized native captures use a disposable supplied-provider harness with the actual GitHub/Azure adapters, preparation service, commands/views and real Git. This is not live-provider proof. It exercised Preparing, explicit fetch consent and acquisition, GitHub and Azure ready states, list/tree, mark/unmark, unchanged refresh, failed refresh retaining files/diff, cancellation retaining marks, explicit new-revision refresh resetting marks while the old diff kept its content and lost its mark target, and Exit PR Review clearing the PR view. The fixture checkout remained on main; no FETCH_HEAD was written. A real moving-pointer clip crosses adjacent workspace/mark controls, marks/unmarks, toggles layout, refreshes through Preparing and selects the Azure PR. Screenshots and the clip were inspected for rendered state and privacy. Final primary artifacts are named `pr-ready-list.png`, `pr-ready-tree.png`, `pr-viewed.png`, `pr-preparing.png`, `pr-consent.png`, `pr-azure-ready.png`, `pr-failure-retained.png`, `pr-refresh-stale-diff.png` and `pr-interaction.mp4` under `.amp/in/artifacts/`.

A live installed-artifact Azure read returned two active PRs and selected-detail resolution reached missing-object consent in a disposable clone. That acquisition did not complete before the shared-host ownership conflict, so it is not evidence of a completed live Azure local review. GitHub native sign-in, live fork acquisition, Windows descendant cleanup, binary rendering and large-repository qualification remain unverified. Deterministic adapter and real-Git tests cover the shared workflow, not those live environments.

Delivery at recording: one coherent feature branch based on merged PR #3, verified locally and prepared for the authorized normal-hook commit, push and PR. Primary main remains synchronized to origin/main. No merge, deployment, provider mutation, credential/default change or Marketplace release is included.

## 2026-10-15: PR snapshot labeling follow-up

Review of PR #4 identified inconsistent branch direction in the native PR header and indistinguishable old/new diff titles. PR headers now use source → target, matching the summary. Local comparison headers retain base → head. Diff titles use eight-character immutable base/head commit IDs rather than movable branch names. Preparing and missing-object messages mention a retained review only when one is actually displayed. Preparation, acquisition and snapshot contracts are unchanged; no polling or stale-tab machinery was added.

Full check, 59 application tests plus rule tests, build and package passed. The final VSIX was reinstalled into a separately named disposable extensions directory, and its bundle hash matched the build. Replacement native fixture captures show consistent GitHub/Azure context, empty Preparing without the retained-review claim, Preparing with accepted files/diff, consent, viewed tree progress and distinct old/new snapshot tabs. Explicit refresh reset marks; selecting the old SHA tab retained value 3 while the new SHA tab showed value 4, and the old editor offered no mark action. These are supplied-provider/real-Git fixtures, not completed live-provider qualification.

The original pointer clip proves layout and mark/unmark interactions, not an end-to-end PR-selection flow. Its PR evidence is replaced by a 33.7-second actual-pointer retry recording: a refused moved fixture branch is followed by fresh PR selection, Preparing, missing-object consent, Fetch Revisions and populated files. The initial refusal is a fixture-revision mismatch, not a successful preparation. The final fixture host uses `final-profile`, `final-extensions` and CDP 9446 under primary `.amp/in/pr-native/`. Reload unexpectedly changed the earlier isolated host's repository; input there stopped and a fresh directly launched host was used without reload. No owner window was closed or owner-repository writes issued.

Final primary captures use the `pr-final-` filename prefix under `.amp/in/artifacts/`; `pr-review-verification.md` lists exact paths, remaining limits and delivery state. Delivery at recording: bounded follow-up prepared for a normal-hook additive commit and push to the existing PR #4, without rewriting its first commit. Main, production telemetry policy, provider state and deployment state remain unchanged.

## 2026-10-15: Persistent PR review sessions

Addressed both remaining PR #4 review findings before merging it: reject shallow repositories before merge-base can produce a plausible but wrong ancestor, and distinguish selected-directory refresh from canonical-root replacement. Real-Git and session regressions passed with the full gate. Both review threads were answered and resolved; PR #4 merged into main. Persistent-session work then began on a new branch from that merged main.

Under D011, multiple local PR sessions now survive switching and editor restart. Selecting an existing session resumes its accepted snapshot without provider resolution; explicit Refresh prepares a replacement and transfers viewed marks only for unchanged full file comparisons. The native Resume/Forget pickers are independent of live PR discovery. Startup in the same single-folder workspace restores the active review and last diff. Exit durably clears active selection; Forget confirms deletion. Local branch comparison retains its separate prior behavior and does not require writable PR-session storage when no PR is accepted.

The extension stores parsed metadata in workspace-scoped `reviews.json`, with an exclusive lease, dead-PID recovery and atomic durable replacement. Core serializes progress and acceptance. A journal protects ordering between metadata and per-session Git retention refs; Update/Forget release obsolete owned prefixes after durable metadata change. Cleanup failures retain retryable pins, never discard progress or run Git garbage collection. No silent expiry, copied file contents, credentials, provider writes or new telemetry payloads were added. Clearing editor storage manually may orphan pins; Forget is the supported cleanup operation.

Verification: `bun run check`, `bun run test`, `bun run build` and `bun run package` passed, including 77 application tests and the policy-rule suite. Real-Git tests cover two-session restart, concurrent progress, source/base/mode changes, stale snapshots, exact namespace isolation, failed publication and cleanup recovery. Storage tests exercise corrupt-record preservation, competing writers, atomic replacement and a real subprocess killed before lease recovery. Preparation tests cover durable-before-publish ordering and cancellation during commitment.

The final self-contained VSIX was installed in an isolated Linux VSCodium profile under `/tmp/duff-native`, with no third-party user extensions. Its installed bundle SHA-256 matched the build. A disposable real-Git repository and synthetic Azure/GitHub labels were seeded through the actual session/storage services. Native checks exercised automatic exact snapshot/diff restore, mark/unmark followed by full host restart, independent viewed counts while switching sessions, and Exit followed by restart remaining inactive with both saved records retained. Native Forget removed GitHub progress and reduced owned retention refs from six to three while preserving the Azure session. A native OS confirmation required desktop input because Electron CDP cannot see that dialog; the dialog was inspected before confirming. The fixture was reseeded afterward for a useful inspection state. No owner windows or working repositories were used.

Inspected captures are retained under `.amp/in/artifacts/`: `sessions-restored.png`, `sessions-picker.png`, `sessions-inactive.png`, `sessions-forget.png` and `sessions-switch.mp4`. The 9.8-second pointer clip crosses adjacent session options and toolbar controls and switches between separate progress states. Sanitized public copies are included as PR evidence. Screenshots establish appearance; executed restart, catalog and ref checks establish behavior.

Limits: these are offline real-Git fixtures, not live-provider or macOS persistence qualification. Multi-root automatic repository selection, repository/workspace migration, multi-window concurrent editing, binary rendering, natural provider token expiry and large-repository performance remain unqualified or outside scope. Production telemetry export remains disabled. Delivery at recording: verified feature branch prepared for the owner-authorized normal-hook commit, push and new PR; not merged, released or deployed.

## 2026-10-16: Effected Git replacement candidate

The owner requested a working PR showing how effected could replace Duff's Git plumbing, accepting upstream telemetry attributes. Both hand-written Git process runners are replaced: repository-root/current-branch/shallow probes use `@effected/git@0.22.0`; unsupported or policy-specific operations use the README's recommended `@effected/commands@0.13.0` collector. One internal policy layer supplies Effect's Node spawner, the activation environment and SSH configuration provider, repository-redirection isolation, noninteractive pins and process-group cleanup. Duff still owns config provenance, Schema validation, immutable snapshots, unique merge bases, failure translation and restricted consent-gated fetches. Azure CLI subprocess handling is unchanged.

The collector's standard budget is 16 MiB per stream, not the previous review runner's combined 16 MiB. Custom commands retain a 60-second timeout; the small upstream probes use Git's own 30-second timeout and unbounded collector. These are explicit candidate tradeoffs, not claims of identical runner behavior. Upstream Git attributes are accepted for this adoption; user-facing diagnostics remain safe and production mode still has no exporter. The pre-1.0 packages are exact-pinned. Effect, platform-node and vitest move together to 4.0.5 to satisfy the Node backend's peer requirement.

The manifest now requires VS Code/VSCodium 1.123+. The [VS Code 1.123 runtime pin](https://github.com/microsoft/vscode/blob/1.123.0/.npmrc) is Electron 42.3.0, whose [release metadata](https://releases.electronjs.org/release/v42.3.0) specifies Node 24.15, above the dependencies' Node 24.11 floor. Older editors are deliberately no longer advertised as supported. The native smoke host was VSCodium 1.140.06880 with Electron 43.7.3 / Node 24.21.0; minimum-version runtime execution and Windows remain unqualified.

Verification: `bun install --frozen-lockfile`, `bun run check`, `bun run test`, `bun run build` and `bun run package` passed. All 61 application tests and the rule suite passed. Existing real-Git tests continue to cover provenance/stdin, exact revisions, fork acquisition, moved branches, shallow/unrelated/ambiguous history and transport-descendant cancellation. A public snapshot-read test checks UTF-8 content at exactly 16 MiB and safe rejection one byte above it.

The self-contained VSIX was installed into a clean disposable VSCodium profile and extension directory. Its installed bundle hash matched the build. Against a fresh clone at `~/source/oss/gbfm`, the installed extension listed 1,574 committed changes from origin/dev's merge-base to prod, matching `git diff --name-only origin/dev...HEAD`, and opened a populated two-sided immutable `.gitignore` diff. Git context inspection also completed through the replacement backend. The clone stayed on prod with a clean worktree; no checkout, fetch, configuration write or file edit was issued against it during verification. The inspected capture is `.amp/in/artifacts/effected-git-installed-smoke.png` in this thread. This is installed-artifact/local Git evidence, not live-provider or minimum-editor qualification. Prepared for PR review, not merged or released.

## 2026-10-23: Effected replacement review and snapshot correction

Fresh review of PR #6 found a snapshot-fidelity regression in the upstream command collector: `Stream.decodeText` removes a leading UTF-8 BOM and does not flush an incomplete final sequence. A real-Git `BranchReview.read` regression test over bytes `EF BB BF 61 C3` returned `a` instead of the previous decoder's `\uFEFFa\uFFFD`. A version-pinned Bun patch to `@effected/commands@0.13.0` preserves the BOM and flushes the decoder while retaining bounded streaming capture. The test failed before the patch and passed after it. Remove the patch only when an upstream release passes this public-contract regression.

`bun install --frozen-lockfile`, check, all 62 application tests plus rule tests, build and package passed. The Git review, Git context and telemetry suites also passed under Node 24.15.0 (17 tests), the runtime identified by the minimum editor's official Electron pin. The transport-descendant cancellation test passed in three additional independent runs. Production activation still supplies no exporter; development serialization strips span attributes, events and raw exception text. No further confirmed defect was found in these reviewed contracts. Windows cleanup and execution inside the full minimum-version editor remain unqualified.

The rebuilt VSIX was reinstalled into the same isolated VSCodium host; its installed bundle hash matched the build. Branch comparison again listed 1,574 changes, matching Git, and opened a populated immutable `.gitignore` diff. The inspected capture is `.amp/in/artifacts/effected-git-reviewed-smoke.png` in this thread. The gbfm clone remained clean on prod. The finding was posted to PR #6; this follow-up is prepared for an additive commit and push, with merge left to the coordinating review thread.

## 2026-10-24: Past pull requests and a quieter sidebar

The normal sidebar now shows changed files and pull requests without routine identity, authentication, host and remote rows. Git Diagnostics is hidden until explicitly opened with its command. Errors and connection actions remain available. D012 adds an Open/Merged/Closed filter to the native PR list and search, with Open as the default and Closed excluding merged PRs. Refresh, pagination and authentication retain the selection; changing it cancels old discovery and retires stale continuation IDs.

GitHub and Azure adapters normalize historical state and bind pagination to that state. GitHub separates merged and unmerged closed results while preserving continuation through empty filtered pages. Live testing also exposed GitHub's numeric repository paths in pagination links; validation now accepts only the repository ID decoded from that response and still validates the API host and query. Opening a historical PR uses the existing exact-revision immutable review and saved-session flow. It does not check out a branch or create a worktree.

Verification: `bun run check`, `bun run test` (98 application tests plus the policy-rule suite), build and package passed. Provider tests cover historical revisions, state filtering and cursor isolation. Session tests cover cancellation, refresh and stale paging after filter changes. The numeric GitHub pagination regression failed before its fix and passed afterward.

The self-contained VSIX was installed in an isolated VSCodium profile with no third-party extensions; its installed bundle hash matched the build. Against `~/source/oss/gbfm`, native checks exercised Open, Merged and Closed lists, the filter picker, search pagination and opening merged PR #390. Its eight changed paths matched the independent Git comparison, and `artwork.ts` opened a populated immutable two-sided diff. The clone remained clean on prod at the same HEAD, and its local Git configuration digest was unchanged. Normal Duff retention refs were allowed; no checkout or worktree was created. Final inspected captures are `past-pr-open.png`, `past-pr-filter.png`, `past-pr-merged.png`, `past-pr-closed.png` and `past-pr-browse-final.webm` under `.amp/in/artifacts/` in this thread.

Limits: historical Azure behavior is covered by adapter tests, not live Azure qualification. The native smoke host is Linux VSCodium, not minimum-editor or macOS qualification. Production telemetry remains disabled. Delivery at recording: verified local feature branch prepared for the owner-authorized commit, push and PR; not merged, released or deployed.
