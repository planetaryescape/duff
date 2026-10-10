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

Uncommitted edits are excluded from the review. A workspace file can therefore differ from its committed diff.
Historical virtual documents can have limited language intelligence. Open the real workspace file for deeper navigation.
This first slice targets text-file review, not binary-file rendering.

## Checks

```sh
bun run check
bun run test
bun run build
```

The local pre-commit gate runs all three commands. To enable it in a fresh clone:

```sh
git config --local core.hooksPath .githooks
```

Effect and its test integration are pinned to stable 4.0.2. There is no Alchemy in this repository.

## Git context and pull requests

Duff inspects local Git identity and safe credential configuration before discovering open PRs. Git helpers are never executed. Configured Git identity and provider API authentication are separate.

The built-in GitHub and Azure DevOps adapters share one job-shaped contract and read open PRs, including drafts and forks, in the native **Pull Requests** view. Equivalent recognized remotes share a repository group. Groups update progressively as their reads finish. Use each group's **Connect Provider** and **Load More** actions, or **Check Pull Requests** to restart. Same-repository refresh retains previous PRs as Refreshing; failed refreshes and pages mark retained results Stale. Hover a status row for its full message. Clicking a PR opens its provider page, not a local checkout.

Background discovery never prompts for sign-in. **Connect Provider** is an explicit action and warns about broad repository permissions; Duff only performs reads. It uses the editor's GitHub authentication provider with the `repo` scope. Editors without that provider report authentication unavailable. A missing session can read public GitHub repositories; a rejected session is not retried anonymously.

Azure DevOps supports modern and legacy HTTPS remotes and Azure v3 SSH remotes. It uses the editor's Microsoft authentication provider with Azure DevOps `user_impersonation` permission. Without a session it reports authentication required, not an empty PR list. Custom provider hosts and SSH aliases are unsupported.

Set `duff.automaticDiscovery` to `false` to disable background provider reads. The **Check Pull Requests** button and toolbar action still perform a manual read without changing that setting. One ReviewSession owns inspection and provider jobs for the selected local repository. Repository selection and editor-session changes cancel old work; refresh retires old pagination while retaining same-repository PR content. Advanced Git credential patterns remain explicitly unresolved rather than guessed. Full credential retrieval, fetching, branch switching, PR mutations, polling, and persistent caches are not implemented.

## Design and next slices

See the [documentation map](docs/README.md) and [current capability/session contract](docs/blueprint/04-capabilities-and-review-session.md). There is no generic plugin lifecycle. Bitbucket is deferred; opening a discovered PR as a local review remains proposed.
Core owns provider contracts, implementations, transport composition and tests. The extension supplies native authentication, then consumes ReviewSession state and actions. Both built-ins currently use HTTP; the shared contract also permits CLI adapters without changing editor code. CLI adapters are not implemented.
Check, 41 tests and packaging pass. Native supplied-service verification covers the preceding session cutover: progressive groups, paging, retained Refreshing/Stale results and repository replacement. Real provider requests and native sign-in remain unverified.
