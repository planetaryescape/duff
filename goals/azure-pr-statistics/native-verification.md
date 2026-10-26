# Native verification handoff

Status: controlled native fixture exercised on 2026-10-25 while implementation was in flight. No live Azure request or installed-artifact qualification was performed. The original preparation checklist below remains future acceptance guidance, not a claim that every item passed.

## Executed fixture handoff

Scratch root, entirely outside source:

```text
/private/var/folders/pg/vp1mhynx13v3qrprvnbccpk40000gn/T/opencode/duff-azure-native
```

Its `README.md` contains controls, evidence, limitations and rebuild commands. `fixture.ts` supplies in-memory catalog/preferences and synthetic directory responses to the real dashboard controller and real `DashboardData.layer`. Production activation, shared storage, authentication and provider transports are not loaded. Git/review actions are disabled. No core or extension source was edited by this task.

After verifying PID 77486's exact test-profile command line, only that process received SIGTERM. One replacement host runs on CDP **9446**, main PID **98892** at handoff, development extension at the scratch root, extensions under its `extensions/`, user data at the approved temporary root's shorter `dqa-p/` path. The first launch exited because the longer profile path exceeded macOS's socket limit; it was not left running. Owner windows were not used.

```sh
QA=/private/var/folders/pg/vp1mhynx13v3qrprvnbccpk40000gn/T/opencode/duff-azure-native
cd "$QA"
sh build.sh
agent-browser --session duff-azure-stats connect 9446
agent-browser --session duff-azure-stats tab t1
```

Do not launch another host. Rebuild and run Developer: Reload Window in this scratch host after integration. Reload resets the synthetic state and holds the first statistics request; QA: Release Held Reads releases it. `metrics.json` records only synthetic request/cancellation counts. The fixture typecheck and bundle build passed; full repository gates were not run by this task.

Observed and screenshot-inspected, with evidence files under the scratch root:

| Behavior | Evidence |
| --- | --- |
| Metadata/description appears before held statistics | `loading-front.png` |
| Correct synthetic totals after release | `ready-a.png`, `ready-b.png` |
| Cached cross-repository return with identical PR IDs and no new reads | `cached-return-a.png`, `cached-switch-before.json`, `cached-switch-after.json` |
| Failed refresh retains values and offers stale Retry after notification dismissal | `stale-a-dismissed.png` |
| Switching repositories interrupts held statistics without contaminating B | `held-pr18.json`, `cancelled-a-keeps-b.json`, `cancelled-a-keeps-b.png` |
| Known revision change removes old totals while new statistics load | `revision-changed-loading.png` |
| Binary line totals unavailable rather than zero; file count retained | `binary-unavailable.png` |
| Untitled-editor round trip restores dashboard with no new reads | `tab-return-ready.png`, `tab-return-before.json`, `tab-return-after.json` |

**Earlier integration issue, fixed in the follow-up below:** the failed metadata refresh stayed labelled Refreshing until its error notification was dismissed, then became Stale. `runOperation` awaited `showErrorMessage`, delaying the failure transition. `stale-a.png` captures that intermediate state and must not be cited as stale proof. The owning source was left unchanged by this task.

`dist/observed.cjs` preserves the tested scratch bundle; `evidence-build.json` records its SHA-256. Do not treat future rebuilds as the same tested baseline. The final host remains useful on synthetic B PR18 revision 2 with 30/+240/-40 and no held jobs or armed failures. gbfm's pre/post branch, HEAD, status, tracked-diff and local-config hashes matched; untracked file contents were not hashed.

At the initial handoff, the following were unqualified: independent OS-window blur/focus, exact freshness clock boundary, hidden/picker suppression, polling absence, non-cancellable late completion, dashboard-close disposal, full pagination/filter restoration, actual Azure semantics, GitHub adapter and packaged artifact. Follow-ups below qualify specific additional cases. No secrets or owner catalog/preferences were read or written. No commits.

### Follow-up: stale transition with notification left open

Rebuilt the scratch extension from the current working source after the extension agent changed `runOperation` to fork notification work into the managed runtime. The first typecheck found the scratch fixture's obsolete comparison-mode literal; changing only the scratch fixture to `merge-base-v1` restored compatibility. Scratch typecheck and bundle build then passed.

Released the initial synthetic statistics request, armed QA: Fail Next Metadata Read, and clicked the dashboard Refresh button. **Passed:** the panel displayed Stale PR details, Stale change statistics and Retry while the original error notification remained open. Description and 3/+12/-4 totals remained visible. No notification dismissal was needed or performed after the failure.

Inspected evidence under the same scratch root:

- `stale-notification-open-fixed.png`: stale content and the open error toast in the same actual host capture.
- `notification-fixed-workbench.txt` and `notification-fixed-webview.txt`: accessible notification and read-only synthetic DOM diagnostics.
- `stale-notification-open-fixed.json`: controlled request counts.
- `dist/notification-fixed.cjs` and `notification-fix-evidence.json`: preserved follow-up bundle and SHA-256, separate from the original evidence bundle.

The host remains on synthetic A PR17 with stale content and its error notification open for inspection. gbfm's fingerprint still matches the pre-replacement baseline. No core/extension source or owner storage was edited.

Separate active OS-window focus remains **blocked/unqualified**: a read-only probe of `Browser.getWindowForTarget` returned CDP `-32601`, method not found. This Electron endpoint cannot provide that window-management route; no minimize/restore, owner-window control, synthetic blur/focus events or replacement host was attempted. Bringing a page forward alone is not evidence of an independent blur/focus cycle.

This follow-up verifies only the notification-related failure transition. Cache/navigation integration was still in flight and was not rerun or declared complete.

### Final integration follow-up: navigation, pagination and cancellation

Rebuilt the scratch fixture against the completed extension integration. Scratch typecheck and build passed. The private directory now supplies three synthetic pages, filter-labelled PRs, held page responses and full/removed/empty list modes. No runtime source edits, new hosts, owner storage or provider requests were involved.

**Passed through native pointer/keyboard actions and inspected screenshots:**

| Check | Observed result and evidence under the scratch root |
| --- | --- |
| A → B → A navigation restore | A restored Merged, selected PR20 from page two, query `PR 20`, page-two rows and 3/+12/-4 cached totals. B independently restored Open, PR18 and `PR 18`. `navigation-fresh-a-restored.png`, `navigation-b-configured.png`, `navigation-selection-cancelled-b.png` |
| Fresh cache hit preserves pages/statistics | A-side list/metadata/statistics counters were identical in `navigation-fresh-before.json` and `navigation-fresh-after.json`. The first captured return already showed cached totals. Clearing only the search field exposed retained page-two PR19: `navigation-restored-loaded-pages.png`. This is not a frame-by-frame no-flash timing measurement. |
| Cursor restored with loaded pages | Load More after the return requested `page-3`, not page two, and displayed PR21: `navigation-restored-cursor-page3.png` and matching JSON |
| Manual first-page replacement/removal | With PR20 absent and its recovery metadata deliberately unavailable, Refresh selected PR17 and removed old page-two/three rows and Load More: `navigation-removal-refresh.png` |
| Empty replacement | Empty first page plus unavailable prior selection metadata cleared rows, detail statistics, selection and Load More: `navigation-empty-refresh.png` |
| Old page reply rejected | A page-two request stayed pending while a forced first-page replacement completed. Releasing it afterward did not restore PR18/19/20 or the cursor. `navigation-page-held.json`, `navigation-page-replaced-before-release.json`, `navigation-old-page-rejected.json`, `navigation-old-page-rejected.png` and DOM text |
| Stale failure and open notification | Forced metadata failure retained description/totals with Stale and Retry while the error toast remained open: `navigation-stale-notification-open.png` and notification snapshot |
| Selection cancellation | Held A PR18 statistics was interrupted when switching to B. Pending became empty, cancellation count increased by one, and B retained its own PR18/query/totals after release: `navigation-selection-held.json`, `navigation-selection-cancelled-b.json`, `navigation-selection-cancelled-b.png` |

An earlier A return crossed the freshness interval and revalidated, so its counters are not cited as fresh-cache proof. The explicit fresh repeat above showed unchanged A counters. During the delayed-page test the loading notice moved the Refresh button; an initial pointer attempt hit the notice, so the test was repeated using its actual read-only DOM rectangle. Only the successful final attempt is cited.

`dist/navigation-qualified.cjs` preserves this bundle. `navigation-evidence.json` records its SHA-256 and assertions. Earlier preserved bundles remain separate. The host is left useful on synthetic B, Open PR18, query `PR 18`, 30/+120/-40, with no held work or armed failure. gbfm's fingerprint again matched its original baseline.

No blocker was found in these exercised native cases. Remaining qualification limits: independent OS-window focus, exact freshness timing, hidden/picker suppression, full cache-eviction bounds, the five-page/250-item cap, non-cancellable selection completion, dashboard disposal, real Azure semantics and installed artifact. Three-page native fixtures do not replace core tests or the separate live Azure qualification. Full repository gates were not run by this task.

## Initial host inspection, before authorized replacement

- One running VSCodium main process was found: PID `77486`, workspace `~/source/oss/gbfm`, development extension `packages/extension`, profile `~/.cache/duff-codium-dev`, extensions `~/.cache/duff-codium-extensions`, third-party extensions disabled.
- It has no remote-debugging argument and no TCP listener on its main PID. No VSCodium listener appeared in the TCP-listener inspection. It is not currently ready for agent-browser CDP automation.
- Historical `.amp/in/pr-native/` profiles and references to ports 9444/9446 are not evidence of running hosts. Old disposable Git fixtures remain, but no reusable native dashboard fixture entrypoint was found in the inspected harness paths.
- No window was activated, reloaded, closed, or launched. Coordinate ownership of the existing host before any replacement. Do not run another `bun run dev` alongside it.

Recheck immediately before testing:

```sh
ps -axo pid,ppid,command | rg '/Applications/VSCodium.app/Contents/MacOS/VSCodium'
lsof -nP -iTCP -sTCP:LISTEN | rg -i 'codium|9444|9446|9222|9333'
```

## Isolation and fixture seam

**A separate editor profile is not enough.** On macOS, `packages/extension/src/dashboard/DataDirectory.ts` uses the shared host-local Duff directory regardless of profile. `XDG_DATA_HOME` does not override that macOS path. Do not seed, reorder, remove, or rewrite entries in the owner's catalog for this test.

Available seams, not a ready-made native runner:

- `registerDashboardCommands(context, runtime)` consumes supplied services. A scratch extension entrypoint can call the real controller with private storage and a controlled provider boundary, without editing the production activation path.
- `makeRepositoryStoreLayer(privateDirectory)` supports a disposable catalog/preferences database. `makeReviewWorkspacesLayer` must use that same private directory if present in the scratch runtime. Do not invoke managed review preparation merely to test statistics.
- `RepositoryDirectory` is the provider-neutral service seam. Supply synthetic list, metadata, statistics, avatar, and authentication behavior using the final interface after the core agent finishes. Retain the real new `DashboardData` lifecycle so native testing exercises actual caching/cancellation, not canned render messages.
- Alternatively, supply provider adapters through `makeRepositoryDirectoryLayer(providers)` to exercise directory validation too. `RepositoryDirectory.test.ts` shows controlled HTTP/authentication construction. Neither form requires real tokens or CLI calls.
- `DashboardHtml.test.ts` renders generated webview JavaScript with supplied state. That is useful rendering coverage, not native event coverage. The inspected baseline has no callback integration harness for `DashboardCommands`.

Suggested synthetic scenario: repositories A and B both contain PR `17`, with distinct titles, descriptions, revisions and totals. Add a second PR per repository to prove selected-only statistics. Expose test-only commands in the scratch entrypoint to delay/release/fail the next metadata/statistics read, change revisions, and report request counts. Keep only synthetic keys, aggregate counts and cancellation counts in diagnostics. Never change DOM state to manufacture evidence.

## Commands once implementation is ready

Run from the Duff root, coordinated with the other agents:

```sh
bun run check
bun run test
bun run build
```

The existing launcher builds and uses a fixed shared development profile. Its default telemetry path decrypts a secret, so do not use plain `bun run dev` for this preparation. `DUFF_TELEMETRY=off bun run dev /Users/guidefari/source/oss/gbfm` avoids that decryption but still does not enable CDP or isolate the shared dashboard catalog.

Only after the current test-host owner confirms replacement, launch one scratch host. The following is a command template, not an executed launch or an existing fixture runner. Set `QA` to a new private directory under the approved OpenCode temporary directory and `FIXTURE_EXTENSION` to the scratch extension containing its manifest and built fixture bundle. Its activation must use private storage as described above.

```sh
codium --new-window --user-data-dir "$QA/profile" --extensions-dir "$QA/extensions" --extensionDevelopmentPath="$FIXTURE_EXTENSION" --disable-extensions --remote-debugging-port=9446 /Users/guidefari/source/oss/gbfm
agent-browser --session duff-azure-stats connect 9446
agent-browser --session duff-azure-stats tab
agent-browser --session duff-azure-stats snapshot -i
```

First confirm port 9446 is free. In the workbench command palette run `Duff: Open Pull Request Dashboard` (`duff.dashboard`). Use `tab` and, if needed, `frame` to locate the webview. Re-snapshot after each state change. Drive real tab activation and window focus transitions, not synthetic DOM focus events. Browser focus alone does not prove `vscode.window.onDidChangeWindowState` fired; confirm through the controlled service request counters and callback tests.

```sh
agent-browser --session duff-azure-stats screenshot "$QA/cached-return.png"
agent-browser --session duff-azure-stats screenshot "$QA/stale-retained.png"
```

Inspect images before sharing. Hide incidental filesystem paths and use only synthetic repository content. Do not use `close --all`, auto-connect, or blanket process termination.

## Smoke checklist

- [ ] Cold repository/PR load renders metadata and description before delayed statistics finish. Listing and unselected PRs cause no statistics reads.
- [ ] Return to the dashboard tab, regain editor focus and reselect the current repository within 60 seconds: cached data paints immediately, with no additional metadata/statistics reads.
- [ ] After at least 60 seconds, activate the dashboard or regain focus while it is active: retain rows/description, show refreshing, and issue one shared revalidation. An unchanged comparison reuses completed statistics.
- [ ] Repeated overlapping activation/focus/reselection events do not restart or duplicate the same job. Prove exact 59/60-second timing with controlled-clock core tests, not native wall-clock guesses.
- [ ] Hide the dashboard behind an ordinary editor, then regain window focus. Repeat in repository-picker mode. Neither path refreshes provider data. Keyboard focus movement among repository buttons alone causes no fetch.
- [ ] A → B → A restores each repository's own PR/filter/page selection. Identical PR IDs never share totals or descriptions. Cached return does not blank the panel.
- [ ] Hold an A statistics reply, select B, then release A. B remains unchanged. Repeat with delayed metadata and same-repository PR switching.
- [ ] Manual Refresh bypasses metadata freshness but reuses unchanged immutable totals. Changed source or target revisions remove old totals from current counters until matching totals arrive.
- [ ] Fail metadata/statistics refresh after success: retain prior content with accurate stale/retry state, not zero totals or an unsupported-provider claim. Retry succeeds. Honor provider retry-after deadlines.
- [ ] Binary, incomplete and unsupported statistics show accurate unavailable placeholders. A verified empty comparison alone may show zero.
- [ ] Close the dashboard during a delayed request, then release it: no late publication or leaked work. Reopen and distinguish reusable completed cache from interrupted jobs.
- [ ] Regress filters, pagination, saved selections, description rendering and GitHub totals. Test review opening separately with a disposable Git fixture, not a synthetic PR against gbfm.
- [ ] Keep gbfm branch, files and Git configuration unchanged. Do not fetch, checkout, install into the owner's main profile, or touch the shared catalog.

## Original preparation blockers, historical

1. Core and extension implementations must settle before compiling a fixture against their new interfaces.
2. No running CDP-capable VSCodium host is available; replacement requires coordination, not a duplicate launch.
3. A scratch native fixture bundle with private storage and deterministic controls still needs to be assembled. None was created by this preparation task.
4. Native fixture results cannot qualify Azure's live file-diff endpoint or comparison completeness. Record that separate protocol evidence and its limits independently.

Record each checkbox as passed, failed, or not run with the final build baseline. This checklist is not delivery evidence.
