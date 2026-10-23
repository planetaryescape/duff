# Releases

Duff has one product version: `packages/extension/package.json`. Core and the
vendored lint rules stay private; they are not independently released. The
release-please manifest starts from the installed `0.0.1` baseline and tracks
subsequent releases. No version is bumped merely by installing a development VSIX.

## Version policy

Use Conventional Commits in commits merged to `main`, or in squash-merge titles:

| Change | Before 1.0 | From 1.0 |
| --- | --- | --- |
| `fix:` or `perf:` | Patch | Patch |
| `feat:` | Minor | Minor |
| `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | Minor | Major |
| `docs:`, `ci:`, `chore:`, `test:`, `refactor:` without a breaking change | No release | No release |

Breaking changes must still explain what users need to do. Choose the move to
`1.0.0` deliberately rather than waiting for a breaking change during 0.x.

## Release flow

1. Every PR and `main` push runs locked installation, checks, tests, and VSIX
   packaging on Node 24.15.0 and the Bun version pinned in the root manifest.
   Release packaging uses the same Node version, matching the minimum supported
   editor runtime and satisfying the Git dependencies' Node 24.11+ requirement.
2. After a successful `main` push, release-please opens or updates a release PR
   with the next extension version and root `CHANGELOG.md`. Changes anywhere in
   the repo contribute to this single release. The initial history boundary is
   the [already installed file-opening fix](https://github.com/planetaryescape/duff/commit/b9784a95bbb7d9eb505afab8c534be716d74ee0e);
   earlier history is not re-released. This setup alone does not create a release;
   the next eligible commit starts the first release PR.
3. Review and merge that PR to approve a release. Release-please creates `vX.Y.Z`
   and a draft GitHub release. A dependent job checks out the exact release SHA,
   builds a self-contained `duff-X.Y.Z.vsix`, checks the tag/version match, uploads
   it, and publishes the draft. If packaging fails, rerun the failed jobs; the
   release stays a draft until the upload succeeds.
4. Run `bash scripts/install.sh` from a checkout, or follow the
   [standalone installer instructions](../README.md#install-the-latest-release).
   The installer uses GitHub CLI to download the latest published release (not a
   draft or prerelease) and installs its VSIX with `code`, `codium`, or
   `code-insiders`. Pass an editor CLI path to choose explicitly. Alternatively,
   install a downloaded VSIX with
   `code --install-extension /path/to/duff-X.Y.Z.vsix --force`, then reload the
   editor window. There is no Marketplace or Open VSX publishing.

The root `simple` strategy updates the extension manifest through a targeted JSON
extra-file update. It does not version the root workspace or other packages.
There is intentionally no `version.txt`: release-please skips that optional file
when absent. Do not add one as another product version source.

## GitHub setup

In **Settings → Actions → General → Workflow permissions**, allow GitHub Actions
to create and approve pull requests. The workflow grants write access only to
release jobs. No credential is needed to build, test, or package Duff locally.

The default `GITHUB_TOKEN` can manage release PRs, tags, and GitHub release assets.
Packaging runs in the same workflow because events created with that token do
not start other workflows. For the same reason, a bot-created release PR will
not automatically run PR checks with the default token. Before merging it,
manually run **CI and Release** using the release PR branch in the Actions tab
(or `gh workflow run ci-release.yml --ref <release-pr-branch>`).

For automatic checks on release PRs, optionally configure the repository secret
`RELEASE_PLEASE_TOKEN` with a fine-grained PAT that can write repository contents,
issues, and pull requests. The workflow prefers that token when present. Do not
put tokens in tracked files. Token provisioning and changes to repository settings
are separate setup actions, not performed by this PR.
