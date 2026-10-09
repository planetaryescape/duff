# Duff

Review committed changes on your current Git branch inside VS Code.

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

## Design and next slices

See the [documentation map](docs/README.md) for the blueprint, provider-plugin strategy, ordered plan, and delivery evidence.
Effective Git configuration comes first. GitHub and Azure DevOps PR discovery are planned provider plugins, not shipped features.
