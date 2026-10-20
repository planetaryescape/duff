# Duff

Review committed changes on your current Git branch inside VS Code.
Source: [planetaryescape/duff](https://github.com/planetaryescape/duff).

## Run in development

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
- Click a file for an immutable, side-by-side diff. Additions, deletions, and renames are supported.
- Use the inline **Open Workspace File** action, or its context-menu entry, for editing and full workspace navigation.
- Click **Toggle File List / Tree** in the view toolbar to switch layouts. The workspace remembers your choice; list mode shows directories to distinguish matching filenames.
- Click **Refresh Comparison** after commits or branch changes.

Use **Mark as Viewed** or **Mark as Unviewed** on a file row (inline or context menu), or in the active Duff diff's toolbar or command palette. Opening a diff never marks it. Hollow circles mean unviewed; checked circles mean viewed. The Changed Files pane shows viewed/total progress in both layouts.

Marks stay local to this editor workspace and the exact repository root, base commit, head commit and changed path. They survive unchanged refreshes, layout changes and editor reloads: choose the same comparison again after reload. Selecting different revisions or another repository replaces the saved marks, not a review history. Old diff tabs cannot mark the new comparison. Workspace files and unrelated editors do not offer diff-marking commands. No provider viewed state or Git data is changed.

Uncommitted edits are excluded from the review. A workspace file can therefore differ from its committed diff.
Historical virtual documents can have limited language intelligence. Open the real workspace file for deeper navigation.
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

Effect and its test integration are pinned to stable 4.0.2. There is no Alchemy in this repository.

## Releases

Duff uses release-please to propose one extension version and changelog from
Conventional Commits. Merging the release PR builds and attaches a versioned VSIX
to GitHub Releases; it does not publish to an extension marketplace. See the
[version policy, release flow, and GitHub setup](docs/releases.md).

## Git context and pull requests

Duff inspects local Git identity and safe credential configuration before discovering open PRs. Git helpers are never executed. Configured Git identity and provider API authentication are separate.

The built-in GitHub and Azure DevOps adapters share one job-shaped contract and read open PRs, including drafts and forks, in the native **Pull Requests** view. Equivalent recognized remotes share a repository group. Groups update progressively as their reads finish. Use each group's **Connect Provider** and **Load More** actions, or **Check Pull Requests** to restart. Same-repository refresh retains previous PRs as Refreshing; failed refreshes and pages mark retained results Stale. Hover a status row for its full message. Clicking a PR prepares its immutable local review. **Open Pull Request in Browser** is a separate row action.

Duff rereads the selected PR's details and pins the exact source and target commit IDs. It compares their unique common ancestor to the source commit, never your checkout's HEAD or a synthetic provider merge commit. Forks are matched by repository identity, not branch name. Available local objects need no fetch permission. If objects are missing, **Fetch PR Revisions…** asks before downloading through an existing matched Git remote. It uses your Git credentials, not the provider API token. Without a matching source remote, add one outside Duff or obtain the objects yourself, refresh Git context, and retry.

An approved fetch updates only two bounded `refs/duff/reviews/` refs, without tags, FETCH_HEAD, remote-tracking updates, submodule recursion or checkout changes. If a fallback branch moved from the pinned SHA, preparation fails rather than silently changing the snapshot. Missing/shallow history and ambiguous common ancestors fail explicitly; Duff does not unshallow repositories. **Cancel PR Preparation** and failures retain the prior review. **Refresh PR Review** explicitly rereads and prepares a new snapshot; **Exit PR Review** restores the previous local comparison when available. Viewed progress follows the same exact-snapshot rules. **Open Workspace File** warns that the current checkout can differ from the reviewed revision.

Background discovery never prompts for sign-in. **Connect Provider** is an explicit action and warns about broad repository permissions; Duff only performs reads. It uses the editor's GitHub authentication provider with the `repo` scope. Editors without that provider report authentication unavailable. A missing session can read public GitHub repositories; a rejected session is not retried anonymously.

Azure DevOps supports modern and legacy HTTPS remotes and Azure v3 SSH remotes. Install Azure CLI on the editor's PATH and run `az login` outside Duff first. Duff uses `az account get-access-token` for the Azure DevOps resource, then reads through its existing REST adapter. It never opens Microsoft editor sign-in, runs login, changes CLI defaults, or falls back to another authentication source. **Connect Provider** explains this and rechecks the existing CLI session. CLI failures remain visible, not empty PR lists. The source is labelled **Azure CLI**; a token does not establish a verified account identity. Custom provider hosts and SSH aliases are unsupported.

Set `duff.automaticDiscovery` to `false` to disable background provider reads. The **Check Pull Requests** button and toolbar action still perform a manual read without changing that setting. One ReviewSession owns inspection and provider jobs for the selected local repository. Repository selection and editor-session changes cancel old work; refresh retires old pagination while retaining same-repository PR content. Advanced Git credential patterns remain explicitly unresolved rather than guessed. Full credential retrieval, branch switching, PR mutations, polling, and persistent provider caches are not implemented.

## Design and next slices

See the [documentation map](docs/README.md) and [current capability/session contract](docs/blueprint/04-capabilities-and-review-session.md). There is no generic plugin lifecycle. Bitbucket is deferred.
Core owns provider contracts, implementations, transport composition and tests. The extension routes GitHub authentication to the editor and Azure authentication to the core CLI service, then consumes ReviewSession state and actions. Both providers read PRs through HTTP. There is no full CLI PR adapter or authentication selector.
The Azure CLI path requires numeric `expires_on` output from a current Azure CLI. It has no Duff token cache. Token changes invalidate old pagination; refresh starts again without silently appending pages under another credential. CLI-internal cache refreshes remain owned by Azure CLI. POSIX process-group cancellation is tested; Windows executable handling and descendant cleanup are not qualified.
