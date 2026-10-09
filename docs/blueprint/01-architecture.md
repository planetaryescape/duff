# Architecture

Status: current review architecture implemented; identity and provider architecture accepted but not implemented.

## Current ownership

| Owner | File | Contract |
| --- | --- | --- |
| Review values and service | [review.ts](../../src/review.ts) | Schema-backed snapshots, file changes, typed errors, BranchReview service |
| Git adapter | [git-review.ts](../../src/git-review.ts) | Read-only CLI operations, immutable revisions, NUL-delimited path parsing |
| Native view | [review-view.ts](../../src/review-view.ts) | File rows and historical document URIs |
| VS Code integration | [extension.ts](../../src/extension.ts) | Commands, quick picks, content provider, one managed runtime and disposal |
| Verification | [git-review.test.ts](../../src/git-review.test.ts) | Real temporary repositories, divergence, dirty files, renames, detached HEAD, failures |

Git owns branches, commits, and contents. Duff keeps a calculated review snapshot in memory.
Only the extension boundary publishes a snapshot into the view.
Comparison errors do not create successful empty reviews; the previous successful review remains visible.
Snapshots pin both sides of the diff to commit IDs. Workspace files are separate, mutable documents.

```text
Branch quick pick → BranchReview.compare → Git adapter → immutable Review
                                                       ↓
Native file list → snapshot URI → content provider → Git blob → native diff
        ↓
Open Workspace File → real file URI → editable workspace document
```

## Proposed additions

Keep configuration inspection and provider discovery outside BranchReview.
They own different facts, authentication requirements, and failure behavior.
Do not require network access to compare local branches.

```text
Repository selection
    ├── local BranchReview → native file list and diff
    └── GitContext inspection → safe identity and remote metadata
                                 ↓
                        Provider plugin registry
                         ├── GitHub strategy
                         └── Azure DevOps strategy
                                 ↓
                       normalized open-PR results
                                 ↓
                         user selects a review
```

`GitContext` and the plugin registry are proposed names, not existing APIs or files.
The extension composition root will select plugins and supply their Effect Layers.
Core contracts must not import provider SDKs or choose credentials implicitly.

## Fence and limits

[TypeScript](../../tsconfig.json) enforces strict checking and indexed-access checks.
[ESLint](../../eslint.config.mjs) checks Promise ownership and unsafe types, prohibits assertions, and restricts core imports and runtime construction.
The [pre-commit gate](../../.githooks/pre-commit) runs check, test, and build. Enable it explicitly in each clone.

This is a partial rat-stack fence, not its full toolchain.
Effect compiler diagnostics, comment bans, comprehensive provider-import rules, and hook-bypass interception are not enforced yet.
The syntax-based boundary rules also do not prove alias or re-export behavior.
Report gaps honestly; do not claim these checks prove runtime correctness.

## Verification limits

The native UI was exercised in an isolated Extension Development Host.
Historical-document language intelligence is limited; full LSP behavior across languages was not verified.
Binary rendering, large-repository behavior, and automatic branch-change refresh were not verified.
Identity inspection and PR discovery have no implementation or runtime evidence yet.
