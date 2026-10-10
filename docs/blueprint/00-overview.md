# Product overview

Status: local review, conservative Git-context inspection, and built-in GitHub/Azure DevOps discovery implemented. Authenticated provider smoke testing remains unverified.

## Goal

Make local code review easy inside VS Code, regardless of the remote provider.
Choose a branch, browse changed files, open a native diff, and navigate the real code.

## Principles

- Keep the editor and UI native to VS Code.
- Use Effect for Git workflows, typed failures, service dependencies, and resource ownership.
- Use rat-stack as a reference, not as a requirement to copy its entire template.
- Enforce important rules with types, lint, tests, and hooks.
- There is no Alchemy in this repository.
- Deliver atomic commits with usable slices.
- Keep Git configuration, Git authentication, and provider API authentication distinct.

## Implemented

- Dedicated Duff Review Activity Bar entry.
- Compare current committed HEAD with a chosen local or remote-tracking branch.
- List changes since the common ancestor, excluding uncommitted work.
- Open immutable text diffs, including added, deleted, and renamed files.
- Open the real workspace file separately for editing and language navigation.
- Open the current working-tree file from a Duff diff's toolbar or the Duff: Open Workspace File command, including uncommitted contents.
- Refresh comparison explicitly; choose a repository in multi-folder workspaces.
- Bun watch build and F5 development configuration, with manual extension reload.

## Identity and discovery

Local inspection shows safe identity and per-remote credential policy. Advanced credential patterns remain explicitly unresolved.
Built-in GitHub and Azure DevOps adapters live in core and use one job-shaped contract and native PR view. PullRequests groups equivalent remotes and publishes progressive results; ReviewSession owns one selected local repository, cancellation and retained refresh state. See the [current contract](04-capabilities-and-review-session.md). Native supplied-service UI verification passes; real provider requests and native sign-in remain unverified.

## Non-goals for these slices

No merge, push, checkout, credential mutation, approval submission, comment sync, or cloud infrastructure.
Commit-story navigation, review notes, binary rendering, and provider write operations remain outside the current scope.

## Settled discovery choices

- Built-in adapters are composed through Layers and one runtime, without a generic plugin lifecycle. Bitbucket is deferred.
- Editor authentication sessions remain separate from Git credential configuration; only explicit Connect prompts.
- Discovery lists all open PRs per supported remote. Current-branch filtering is not implemented.
- Context inspection starts cancellable discovery; `duff.automaticDiscovery` disables background reads, while Check Pull Requests performs an explicit manual read.

See [provider strategies](03-identity-and-provider-strategies.md) for proposed defaults and safety constraints.
