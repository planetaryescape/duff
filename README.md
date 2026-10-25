# Duff

Find pull requests across repositories and review their pinned source in VS Code.
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

## Pull request dashboard

Run **Duff: Open Pull Request Dashboard** for a repository-first editor dashboard.
Use **Add repositories** to select several remote repositories or local folders at once.
Browse GitHub accounts/organizations or Azure DevOps organizations/projects; local Git remotes suggest collections without loading them automatically.
Local-only repositories remain available for branch comparison. Discovery inspects selected folders and one level of children, not your whole disk.

Select a watched repository, choose Open, Merged or Closed, then **Open review in new window**.
Duff downloads missing objects automatically and opens a complete detached checkout at the pinned PR HEAD in a separate editor window. It never switches your original repository.
Reopening the same revisions preserves edits and untracked files; newer source or target revisions get another directory. Duff does not install dependencies, initialize submodules or run setup scripts. Language navigation still needs the appropriate editor extensions, SDKs and dependencies.

The watchlist and managed-review progress are shared across VS Code/VSCodium profiles for the same OS user on the same extension host. They are not cloud-synced.
Storage is independent of editor profiles: `$XDG_DATA_HOME/duff/dashboard` (or `~/.local/share/duff/dashboard`) on Linux, `~/Library/Application Support/Duff/dashboard` on macOS, and `%LOCALAPPDATA%/Duff/dashboard` on Windows.
SQLite stores metadata; Git stores review source in `review-workspaces`. Removing a watched repository does not delete its local files or managed checkouts. Concurrent progress conflicts fail instead of overwriting; reload the review window before retrying.

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

Duff opens with Changed Files and Pull Requests, not Git configuration. **Duff: Show Git Diagnostics** reveals local identity and safe credential configuration when you need to troubleshoot. Local inspection still supplies repository context for discovery and never executes credential helpers. Git acquisition can use configured helpers. Configured Git identity and provider API authentication are separate.

For github.com, Duff uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the active `gh` login for github.com. Empty variables count as absent. The CLI runs outside the workspace with an explicit host; `GH_HOST` cannot redirect credentials. If these sources are absent, an already-authorized VS Code session is the last authenticated fallback, followed by anonymous public reads. **Use VS Code account…** explicitly requests editor sign-in after a permission warning. Duff never runs `gh auth login`, switches CLI accounts, or retries rejected credentials under another identity.

The Pull Requests view shows PRs and actionable failures, without identity or authentication metadata rows. Tokens without access to `/user`, such as installation tokens, can still read permitted repositories. Failures identify the selected credential source. Fix an expired environment token or CLI login before refreshing; editor sign-in does not override it. Environment variables must be present when the editor starts, not merely set in an integrated terminal. GitHub Enterprise hosts remain unsupported; enterprise environment tokens are not used for github.com.

The built-in GitHub and Azure DevOps adapters share one job-shaped contract in the native **Pull Requests** view. Use the toolbar's filter button or **Duff: Show Open / Merged / Closed Pull Requests…** to browse open PRs (including drafts), merged PRs, or PRs closed without merging. Azure completed and abandoned PRs appear as Merged and Closed. Open is the startup default; refresh and pagination keep the selected filter. Switching filters clears the previous list and cancels its pending reads. Equivalent recognized remotes share a repository group. Groups update progressively as their reads finish. Use each group's **Connect Provider** and **Load More** actions, or **Check Pull Requests** to restart. Same-filter refresh retains previous PRs as Refreshing; failed refreshes and pages mark retained results Stale. Hover a status row for its full message. Clicking a PR prepares its immutable local review, including merged and closed PRs. **Open Pull Request in Browser** is a separate row action.

Use the Pull Requests toolbar's search button or **Duff: Search Pull Requests…** in the command palette to find PRs by title, number, repository or source/target branch within the selected state. Search filters loaded pages across the selected repository's remote groups, not all PRs on the hosting service. **Load More Pull Requests** stays visible even when nothing matches; it adds the next page without clearing your query. GitHub merged/closed filtering can leave an empty page with more results still available; use Load More to continue. **Check Pull Requests** refreshes discovery, and selecting a PR uses the same immutable local review flow as the tree.

Duff rereads the selected PR's details and pins the exact source and target commit IDs. It compares their unique common ancestor to the source commit, never your checkout's HEAD or a synthetic provider merge commit. New PR selections open managed review windows, configuring independent source/target remotes for forks and automatically acquiring exact revisions. Git authentication remains separate from provider API authentication. Legacy saved reviews in an existing workspace retain their consent-gated acquisition flow.

An approved fetch updates only two bounded acquisition refs under `refs/duff/reviews/`, without tags, FETCH_HEAD, remote-tracking updates, submodule recursion or checkout changes. Accepting a saved PR review also creates session retention refs, described below. If a fallback branch moved from the pinned SHA, preparation fails rather than silently changing the snapshot. Missing/shallow history and ambiguous common ancestors fail explicitly; Duff does not unshallow repositories. **Cancel PR Preparation** and failures retain the prior review. **Refresh PR Review** explicitly rereads and prepares a new snapshot; **Exit PR Review** restores the previous local comparison when available. **Open Workspace File** opens the current checkout directly, without confirmation; its content can differ from the reviewed revision.

### Saved PR reviews

Duff saves multiple PR sessions locally, for both Azure DevOps and GitHub. Reopening the same single-folder workspace automatically restores the last active PR's exact snapshot, viewed marks and last opened diff. **Resume Review…** lists saved reviews for the selected repository, most recently reviewed first, independently of the live open-PR list. Resume reads local Git objects and needs neither provider authentication nor a fetch. Normal background discovery remains controlled by `duff.automaticDiscovery`.

New PR selections resolve the latest revisions into managed windows; **Resume Review…** restores a saved snapshot without updating it. **Refresh PR Review** checks for newer revisions: managed reviews open another checkout, leaving the old window and its edits intact. Legacy unmanaged sessions keep one current snapshot per PR. Their updates retain viewed marks only when change kind, old/new paths, both object IDs and both modes are unchanged. Failed preparation or saving keeps the accepted review. Opening a diff never marks it viewed.

**Exit PR Review** retains the session but clears its active selection, so the next restart stays inactive. **Forget Saved Review…** asks before deleting progress and releasing that session's pins. Neither action changes the provider, checkout or branches. Changes are saved during review; a crash before a write completes can lose that unacknowledged change. Missing Git objects or invalid storage produce an error without deleting saved progress. A second window using the same workspace storage reports it busy rather than overwriting the first window's progress.

**Storage and garbage collection:** managed review metadata uses per-checkout SQLite databases in the shared user directory above. Legacy unmanaged reviews use `reviews.json` under VS Code/VSCodium's workspace-scoped `ExtensionContext.storageUri`, outside the repository. Metadata contains PR labels, immutable commit IDs, file/object metadata, viewed paths and the last file, never file contents or credentials. Each session protects its base/source/target commits under `refs/duff/sessions/<workspace-owner>/<session>/<snapshot>/` in Git; linked worktrees use distinct root identities and share Git's ref storage safely. Managed checkouts remain on disk until manually removed; Forget deletes progress, not checkout files.

There is no age-based expiry or automatic session limit. Update and Forget durably record the metadata change before releasing only obsolete owned session refs. A recovery journal retries unfinished releases on later session operations; failures prefer retained objects over lost work. Duff never runs `git gc`, `prune` or `repack`. Git may reclaim released objects through normal maintenance only when no branch, acquisition ref, other session, reflog or other root still retains them. Clearing the editor's workspace storage manually can orphan pins; use Forget first. Session storage does not sync between devices, and moving a repository/workspace does not migrate its sessions.

Background discovery never prompts for sign-in. **Connect Provider** is an explicit action and warns about broad repository permissions; Duff only performs reads. It uses the editor's GitHub authentication provider with the `repo` scope. Editors without that provider report authentication unavailable. A missing session can read public GitHub repositories; a rejected session is not retried anonymously.

Azure DevOps supports modern and legacy HTTPS remotes and Azure v3 SSH remotes. Install Azure CLI on the editor's PATH and run `az login` outside Duff first. Duff uses `az account get-access-token` for the Azure DevOps resource, then reads through its existing REST adapter. It never opens Microsoft editor sign-in, runs login, changes CLI defaults, or falls back to another authentication source. **Connect Provider** explains this and rechecks the existing CLI session. CLI failures remain visible, not empty PR lists. The source is labelled **Azure CLI**; a token does not establish a verified account identity. Custom provider hosts and SSH aliases are unsupported.

Set `duff.automaticDiscovery` to `false` to disable background provider reads. The **Check Pull Requests** button and toolbar action still perform a manual read without changing that setting. One ReviewSession owns inspection and provider jobs for the selected local repository. Repository selection and editor-session changes cancel old work; refresh retires old pagination while retaining same-repository PR content. Advanced Git credential patterns remain explicitly unresolved rather than guessed. Full credential retrieval, branch switching, PR mutations, polling, and persistent provider caches are not implemented.

## Design and next slices

See the [documentation map](docs/README.md) and [current capability/session contract](docs/blueprint/04-capabilities-and-review-session.md). There is no generic plugin lifecycle. Bitbucket is deferred.
Core owns provider contracts, implementations, transport composition and tests. The extension routes GitHub authentication to the editor and Azure authentication to the core CLI service, then consumes ReviewSession state and actions. Both providers read PRs through HTTP. There is no full CLI PR adapter or authentication selector.
The Azure CLI path requires numeric `expires_on` output from a current Azure CLI. It has no Duff token cache. Token changes invalidate old pagination; refresh starts again without silently appending pages under another credential. CLI-internal cache refreshes remain owned by Azure CLI. POSIX process-group cancellation is tested; Windows executable handling and descendant cleanup are not qualified.
