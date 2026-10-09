# Product overview

Status: mixed. Inspected on 2026-10-09 against the local branch-review and development-workflow commits.

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
- Refresh comparison explicitly; choose a repository in multi-folder workspaces.
- Bun watch build and F5 development configuration, with manual extension reload.

## Accepted, not implemented

1. Inspect effective Git configuration for the selected repository: name, email, and credential strategy.
2. Make that identity/configuration slice work before adding remote PR discovery.
3. Detect open pull requests associated with repository remotes through provider plugins.
4. Start with GitHub and Azure DevOps.

## Non-goals for these slices

No merge, push, checkout, credential mutation, approval submission, comment sync, or cloud infrastructure.
Commit-story navigation, review notes, binary rendering, and provider write operations remain outside the current scope.

## Open implementation choices

- Whether provider plugins ship in-process or as separately installed extensions.
- Provider API authentication mechanism and any interaction required to establish a session.
- Default discovery scope: all open PRs on the selected remote, with optional current-branch filtering proposed.
- When background discovery runs and how users disable or refresh it.

See [provider strategies](03-identity-and-provider-strategies.md) for proposed defaults and safety constraints.
