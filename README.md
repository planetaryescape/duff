# Duff

Review committed changes on your current Git branch inside VS Code.
Source: [planetaryescape/duff](https://github.com/planetaryescape/duff).

## Install the latest release

With [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) and your
editor CLI on PATH, run:

```sh
curl -fsSL https://raw.githubusercontent.com/planetaryescape/duff/main/scripts/install.sh -o /tmp/duff-install.sh
bash /tmp/duff-install.sh
```

The script downloads the latest published release, installs its VSIX, and removes
the download. It prefers `code`, then `codium`, then `code-insiders`; pass an editor
CLI explicitly, for example `bash /tmp/duff-install.sh codium`. Reload existing
editor windows afterward. No source checkout, Bun, or Node is needed. Until the
first release is published, there is no release VSIX to install. macOS and Linux
are supported; on Windows, download the VSIX from GitHub Releases and use
**Extensions: Install from VSIX…**.

## Run in development

Requires VS Code/VSCodium 1.123+ (Node 24.15 in the extension host). The Git dependencies require Node 24.11+; a separately installed Node does not upgrade the editor's runtime.

1. Run `bun install`.
2. Open this repository in VS Code.
3. Press F5 and select **Run Extension**. Bun watches and rebuilds the bundle in a background task.
4. In the Extension Development Host, open the Git repository you want to review.
5. Click the **Duff Review** icon in the Activity Bar, then **Compare Against Branch**.

After source edits, run **Developer: Reload Window** in the development window.
For manifest changes, stop the debug session and press F5 again.
Rebuilds are automatic; extension-host hot reload is not implemented.
Alternatively, run `bun run watch` and launch the development host yourself.

## Review a branch

- Choose a local or remote-tracking base branch. Duff does not fetch or switch branches.
- The changed-file list uses the common ancestor of the base and current committed HEAD, like `git diff base...HEAD`.
- Click a file for an immutable, side-by-side diff in a pinned tab. Opening another diff leaves existing tabs in place. Additions, deletions, and renames are supported.
- Use the inline **Open Workspace File** action, its context-menu entry, or **Cmd+Enter** (**Ctrl+Enter** on Linux/Windows) with a file selected in Duff's tree. Workspace files also open in pinned tabs. VS Code does not expose Cmd-click modifiers to custom tree commands.
- Click **Toggle File List / Tree** in the view toolbar to switch layouts. The workspace remembers your choice; list mode shows directories to distinguish matching filenames.
- Click **Refresh Comparison** after commits or branch changes.

Click the checkbox beside a file to mark it viewed or unviewed. In tree mode, a folder checkbox marks or unmarks every changed file beneath it, including nested and deleted files. A folder is checked only when all its reviewed files are viewed; partially viewed folders remain unchecked. Folder actions work even when children are collapsed. **Mark as Viewed** and **Mark as Unviewed** remain available in context menus and the active Duff diff's toolbar or command palette. Opening a diff never marks it. The Changed Files pane shows viewed/total progress in both layouts.

Local branch-comparison marks stay in this editor workspace and belong to the exact repository root, base commit, head commit and changed path. They survive unchanged refreshes, layout changes and editor reloads: choose the same comparison again after reload. Selecting different revisions or another repository replaces those local-comparison marks. PR reviews use separate saved sessions, described below. Old diff tabs cannot mark a different comparison. Workspace files and unrelated editors do not offer diff-marking commands. No provider viewed state is changed.

Uncommitted edits are excluded from the review. A workspace file can therefore differ from its committed diff.
TypeScript and JavaScript diffs support definitions, type definitions, implementations, references and hover information through the current workspace's language service. Navigation opens workspace files; it does not claim to resolve a historical TypeScript project. If the workspace differs, Duff forwards only positions on an identical, uniquely matching line. Changed or ambiguous lines and missing workspace files have no bridged result. Hover information is labelled **Current workspace TypeScript project**. Snapshot contents remain immutable; edits, rename and refactoring still belong in workspace files.
This first slice targets text-file review, not binary-file rendering.

## Checks

Install with Bun. The prepare script patches the pinned TypeScript and Oxlint binaries with `@effect/tsgo`; reinstall after changing tool versions. Anti-slop rule tests require Node 22.18+ because Oxlint RuleTester does not support Bun.

```sh
bun run check
bun run test
bun run build
```

`check` runs Oxfmt, strict typechecking, and type-aware Oxlint with Effect correctness diagnostics. ESLint is not required. Run `bun run format` for formatting or `bun run lint:fix` for safe lint fixes. The recommended Oxc editor extension uses the local tools for linting and format-on-save.

The local pre-commit gate runs all three commands. To enable it in a fresh clone:

```sh
git config --local core.hooksPath .githooks
```

Effect, its Node platform and test integration are pinned to stable 4.0.5. Local Git uses `@effected/git` for matching repository probes and `@effected/commands` for bounded custom commands. Duff retains exact-revision validation, configuration provenance and restricted fetch policy. There is no Alchemy in this repository.

## Releases

Duff uses release-please to propose one extension version and changelog from
Conventional Commits. Merging the release PR builds and attaches a versioned VSIX
to GitHub Releases; it does not publish to an extension marketplace. See the
[version policy, release flow, and GitHub setup](docs/releases.md).

## Git context and pull requests

Duff opens with Changed Files and Pull Requests, not Git configuration. **Duff: Show Git Diagnostics** reveals local identity and safe credential configuration when you need to troubleshoot. Local inspection still supplies repository context for discovery. Git helpers are never executed. Configured Git identity and provider API authentication are separate.

For github.com, Duff uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the active `gh` login for github.com. Empty variables count as absent. The CLI runs outside the workspace with an explicit host; `GH_HOST` cannot redirect credentials. If these sources are absent, an already-authorized VS Code session is the last authenticated fallback, followed by anonymous public reads. **Use VS Code account…** explicitly requests editor sign-in after a permission warning. Duff never runs `gh auth login`, switches CLI accounts, or retries rejected credentials under another identity.

The Pull Requests view shows PRs and actionable failures, without identity or authentication metadata rows. Tokens without access to `/user`, such as installation tokens, can still read permitted repositories. Failures identify the selected credential source. Fix an expired environment token or CLI login before refreshing; editor sign-in does not override it. Environment variables must be present when the editor starts, not merely set in an integrated terminal. GitHub Enterprise hosts remain unsupported; enterprise environment tokens are not used for github.com.

The built-in GitHub and Azure DevOps adapters share one job-shaped contract in the native **Pull Requests** view. Use the toolbar's filter button or **Duff: Show Open / Merged / Closed Pull Requests…** to browse open PRs (including drafts), merged PRs, or PRs closed without merging. Azure completed and abandoned PRs appear as Merged and Closed. Open is the startup default; refresh and pagination keep the selected filter. Switching filters clears the previous list and cancels its pending reads. Equivalent recognized remotes share a repository group. Groups update progressively as their reads finish. Use each group's **Connect Provider** and **Load More** actions, or **Check Pull Requests** to restart. Same-filter refresh retains previous PRs as Refreshing; failed refreshes and pages mark retained results Stale. Hover a status row for its full message. Clicking a PR prepares its immutable local review, including merged and closed PRs. **Open Pull Request in Browser** is a separate row action.

Use the Pull Requests toolbar's search button or **Duff: Search Pull Requests…** in the command palette to find PRs by title, number, repository or source/target branch within the selected state. Search filters loaded pages across the selected repository's remote groups, not all PRs on the hosting service. **Load More Pull Requests** stays visible even when nothing matches; it adds the next page without clearing your query. GitHub merged/closed filtering can leave an empty page with more results still available; use Load More to continue. **Check Pull Requests** refreshes discovery, and selecting a PR uses the same immutable local review flow as the tree.

Duff rereads the selected PR's details and pins the exact source and target commit IDs. It compares their unique common ancestor to the source commit, never your checkout's HEAD or a synthetic provider merge commit. Forks are matched by repository identity, not branch name. Available local objects need no fetch permission. If objects are missing, **Fetch PR Revisions…** asks before downloading through an existing matched Git remote. It uses your Git credentials, not the provider API token. Without a matching source remote, add one outside Duff or obtain the objects yourself, refresh Git context, and retry.

An approved fetch updates only two bounded acquisition refs under `refs/duff/reviews/`, without tags, FETCH_HEAD, remote-tracking updates, submodule recursion or checkout changes. Accepting a saved PR review also creates session retention refs, described below. If a fallback branch moved from the pinned SHA, preparation fails rather than silently changing the snapshot. Missing/shallow history and ambiguous common ancestors fail explicitly; Duff does not unshallow repositories. **Cancel PR Preparation** and failures retain the prior review. **Refresh PR Review** explicitly rereads and prepares a new snapshot; **Exit PR Review** restores the previous local comparison when available. **Open Workspace File** opens the current checkout directly, without confirmation; its content can differ from the reviewed revision.

### Saved PR reviews

Duff saves multiple PR sessions locally, for both Azure DevOps and GitHub. Reopening the same single-folder workspace automatically restores the last active PR's exact snapshot, viewed marks and last opened diff. **Resume Review…** lists saved reviews for the selected repository, most recently reviewed first, independently of the live open-PR list. Resume reads local Git objects and needs neither provider authentication nor a fetch. Normal background discovery remains controlled by `duff.automaticDiscovery`.

Clicking an already saved PR resumes it; **Refresh PR Review** explicitly checks for newer revisions. There is one current snapshot per PR, not a history. On update, only previously viewed files whose change kind, old/new paths, both object IDs and both file modes are unchanged stay viewed. Changed/new diffs are unviewed; removed files leave the list. Rebased commits can retain marks when their full file comparisons are identical. Failed preparation or saving keeps the accepted review. Opening a diff never marks it viewed.

**Exit PR Review** retains the session but clears its active selection, so the next restart stays inactive. **Forget Saved Review…** asks before deleting progress and releasing that session's pins. Neither action changes the provider, checkout or branches. Changes are saved during review; a crash before a write completes can lose that unacknowledged change. Missing Git objects or invalid storage produce an error without deleting saved progress. A second window using the same workspace storage reports it busy rather than overwriting the first window's progress.

**Storage and garbage collection:** metadata lives in `reviews.json` under VS Code/VSCodium's workspace-scoped `ExtensionContext.storageUri`, outside the repository. This contains PR labels, immutable commit IDs, file/object metadata, viewed paths and the last file, never file contents or credentials. Each session protects its base/source/target commits under `refs/duff/sessions/<workspace-owner>/<session>/<snapshot>/` in Git; linked worktrees use distinct root identities and share Git's ref storage safely.

There is no age-based expiry or automatic session limit. Update and Forget durably record the metadata change before releasing only obsolete owned session refs. A recovery journal retries unfinished releases on later session operations; failures prefer retained objects over lost work. Duff never runs `git gc`, `prune` or `repack`. Git may reclaim released objects through normal maintenance only when no branch, acquisition ref, other session, reflog or other root still retains them. Clearing the editor's workspace storage manually can orphan pins; use Forget first. Session storage does not sync between devices, and moving a repository/workspace does not migrate its sessions.

Background discovery never prompts for sign-in. **Connect Provider** is an explicit action and warns about broad repository permissions; Duff only performs reads. It uses the editor's GitHub authentication provider with the `repo` scope. Editors without that provider report authentication unavailable. A missing session can read public GitHub repositories; a rejected session is not retried anonymously.

Azure DevOps supports modern and legacy HTTPS remotes and Azure v3 SSH remotes. Install Azure CLI on the editor's PATH and run `az login` outside Duff first. Duff uses `az account get-access-token` for the Azure DevOps resource, then reads through its existing REST adapter. It never opens Microsoft editor sign-in, runs login, changes CLI defaults, or falls back to another authentication source. **Connect Provider** explains this and rechecks the existing CLI session. CLI failures remain visible, not empty PR lists. The source is labelled **Azure CLI**; a token does not establish a verified account identity. Custom provider hosts and SSH aliases are unsupported.

Set `duff.automaticDiscovery` to `false` to disable background provider reads. The **Check Pull Requests** button and toolbar action still perform a manual read without changing that setting. One ReviewSession owns inspection and provider jobs for the selected local repository. Repository selection and editor-session changes cancel old work; refresh retires old pagination while retaining same-repository PR content. Advanced Git credential patterns remain explicitly unresolved rather than guessed. Full credential retrieval, branch switching, PR mutations, polling, and persistent provider caches are not implemented.

## Design and next slices

See the [documentation map](docs/README.md) and [current capability/session contract](docs/blueprint/04-capabilities-and-review-session.md). There is no generic plugin lifecycle. Bitbucket is deferred.
Core owns provider contracts, implementations, transport composition and tests. The extension routes GitHub authentication to the editor and Azure authentication to the core CLI service, then consumes ReviewSession state and actions. Both providers read PRs through HTTP. There is no full CLI PR adapter or authentication selector.
The Azure CLI path requires numeric `expires_on` output from a current Azure CLI. It has no Duff token cache. Token changes invalidate old pagination; refresh starts again without silently appending pages under another credential. CLI-internal cache refreshes remain owned by Azure CLI. POSIX process-group cancellation is tested; Windows executable handling and descendant cleanup are not qualified.
