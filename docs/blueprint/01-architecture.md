# Architecture

Status: review and local identity inspection implemented; provider architecture accepted but not implemented.

## Current ownership

| Owner | File | Contract |
| --- | --- | --- |
| Review values and service | [review.ts](../../src/review.ts) | Schema-backed snapshots, file changes, typed errors, BranchReview service |
| Git adapter | [git-review.ts](../../src/git-review.ts) | Read-only CLI operations, immutable revisions, NUL-delimited path parsing |
| Native view | [review-view.ts](../../src/review-view.ts) | File rows and historical document URIs |
| VS Code integration | [extension.ts](../../src/extension.ts) | Commands, quick picks, content provider, one managed runtime and disposal |
| Verification | [git-review.test.ts](../../src/git-review.test.ts) | Real temporary repositories, divergence, dirty files, renames, detached HEAD, failures |
| Git context | [git-context.ts](../../src/git-context.ts), [adapter](../../src/git-context-adapter.ts), [view](../../src/git-context-view.ts) | Safe local identity, config provenance, sanitized remotes, helper declarations |

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

`GitContext` exists; the plugin registry remains proposed.
The extension composition root will select plugins and supply their Effect Layers.
Core contracts must not import provider SDKs or choose credentials implicitly.

## Operation observability

Meaningful service and Git-adapter operations use named `Effect.fn` spans by default.
The integration adds workflow spans for context inspection, branch listing, comparison, refresh, and snapshot reads, with correlated success/failure/interruption logs.
[observability.ts](../../src/observability.ts) owns authenticated export and privacy projection; the managed runtime owns exporter shutdown.

Extension Development Host mode exports to `https://otel.planetaryescape.co.za/v1/traces` and `/v1/logs`, then Hetzner Tempo and Loki.
Follow the owner's planetaryescape-observability skill. `bun run dev` scopes the SOPS-decrypted ingestion token to the development process, without a plaintext file or token argument.
The exporter requires `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer TOKEN`. Without it, export is disabled; malformed headers produce a safe warning and disable export.
View both signals in [Grafana](https://grafana.planetaryescape.co.za): Tempo query `{ resource.service.name = "duff" }`, Loki query `{service_name="duff"}`.
Production and extension-test modes install no exporter. Backend outages must not gate local Git operations. No infrastructure changes are required.
The current collector attaches tunnel pod metadata to external logs; those Kubernetes labels do not describe Duff's host. Use the service name and development environment to find Duff.

Exported spans keep stable names, IDs, timing, parent links, and status codes. Attributes, events, links, and exception messages/stacks are stripped at serialization.
Exported logs keep only fixed operation-summary messages, operation/outcome annotations, and trace correlation. Do not log raw results or causes.
Git identity, email, origin paths, remotes, branch/file names, argv, and file contents stay local to their existing UI/read boundaries, not telemetry.
OtlpTracer/OtlpLogger are marked unstable inside pinned Effect 4.0.2. Their lightweight layers fit this new runtime without the separate OpenTelemetry SDK bridges.
The exporter uses OTLP HTTP JSON to project private data out before sending; the collector accepts it. This differs from the skill's preferred protobuf encoding.
Build and watch define `import.meta` for CommonJS and preserve its URL use as `__filename`; Node still supplies environment configuration through `process.env`.

## Reference codebases and deferred Effect tools

Use [rat-stack](https://ratstack.sh/llms.txt) for typed service boundaries, explicit Layers, privacy, meaningful spans, and the fence. There is no Alchemy here.
Also use [OpenCode v2](https://github.com/anomalyco/opencode/tree/v2) as an architectural reference, studied at [this revision](https://github.com/anomalyco/opencode/commit/216c311744b3fe8c8dce39282528ccc9027510f7).
Relevant source areas: `packages/core/src/git.ts`, `packages/util/src/process.ts`, `packages/core/src/filesystem/watcher.ts`, and `packages/core/src/plugin/vcs/git.ts`.
Borrow worktree/git-directory/common-directory distinctions, scoped subprocess ownership, and shared watcher lifetimes. Do not copy destructive Git operations, config writes, or the entire plugin graph.
That reference used Effect 4.0.0-rc.112; check every borrowed API against Duff's stable pin.

RcRef fits one shared scoped resource; RcMap fits per-worktree watcher/session resources with reference-counted lifetime. Neither is needed for current one-shot Git reads or immutable blob value caching.
PersistedCache and KeyValueStore are unstable in the installed package. Defer persistent Git-context caching because identity/configuration must remain fresh.
Use Cache if repeated immutable blob reads justify it. Use scoped fibers, cancellation, Stream, and Schedule when watcher or provider-discovery work actually requires them.

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
Identity inspection is partial; see the [strategy contract](03-identity-and-provider-strategies.md) for remaining gaps. PR discovery is not implemented.
