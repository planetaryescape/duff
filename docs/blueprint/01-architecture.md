# Architecture

Status: review, conservative local identity inspection, and shared GitHub/Azure DevOps discovery implemented.

## Current ownership

| Owner | File | Contract |
| --- | --- | --- |
| Review capability | [BranchReview.ts](../../packages/core/src/review/BranchReview.ts) | Schemas, typed errors, service and Git Layer; read-only CLI operations, immutable revisions, NUL-delimited path parsing |
| Native view | [ReviewView.ts](../../packages/extension/src/review/ReviewView.ts) | File rows and historical document URIs |
| Review integration | [ReviewCommands.ts](../../packages/extension/src/review/ReviewCommands.ts) | Branch picker, comparison state, list/tree persistence, immutable content provider, diff and current-file commands |
| Git-context integration | [GitContextCommands.ts](../../packages/extension/src/git-context/GitContextCommands.ts) | Select repository through ReviewSession and render its inspection state |
| Session | [ReviewSession.ts](../../packages/core/src/review-session/ReviewSession.ts) | One selected local repository, FiberMap jobs and SubscriptionRef changes |
| Pull requests | [PullRequests.ts](../../packages/core/src/pull-requests/PullRequests.ts) | Group equivalent remotes, private continuation state and progressive results |
| Shared editor boundaries | [Operations.ts](../../packages/extension/src/Operations.ts), [Repository.ts](../../packages/extension/src/Repository.ts) | Operation tracing and error notifications; workspace-folder selection |
| Composition root | [extension.ts](../../packages/extension/src/extension.ts) | Layers, feature registration and coordination, one managed runtime and disposal |
| Verification | [BranchReview.test.ts](../../packages/core/src/review/BranchReview.test.ts) | Real temporary repositories, divergence, dirty files, renames, detached HEAD, failures |
| Git context | [GitContext.ts](../../packages/core/src/git-context/GitContext.ts), [test](../../packages/core/src/git-context/GitContext.test.ts), [view](../../packages/extension/src/git-context/GitContextView.ts) | Safe local identity, config provenance, sanitized remotes, helper declarations |

## Bun workspace boundaries

`packages/core` owns headless capabilities by feature. Each service keeps its schemas, errors, implementation Layer, and tests nearby. `packages/extension` owns the editor integration and telemetry.
Dependencies point extension → core. Cross-package imports use explicit exports and `workspace:*` dependencies. Core can use Node for local Git adapters, but cannot depend on VS Code or the extension.
The extension supplies the environment to the GitContext Layer during activation. Importing core does not inspect Git configuration or select the process environment.
The private root owns the pinned Bun version, shared tooling, aggregate scripts, and one lockfile. Each package has its own typecheck; only the extension enables VS Code ambient types.
Bun bundles all runtime workspace dependencies into `packages/extension/dist/extension.js`; only VS Code and Node runtime modules remain external. The extension manifest stays inside `packages/extension`.
The VSIX excludes source, maps, workspace links, and node_modules. Packaging uses pinned vsce without dependency traversal. Missing repository and license metadata are tolerated for local smoke packaging, not a claim of publishing readiness.
See [D006](02-decision-log.md#d006-feature-owned-core-and-editor-packages) for the accepted structure.

Git owns branches, commits, and contents. Duff keeps a calculated review snapshot in memory.
Only the extension boundary publishes a snapshot into the view.
Comparison errors do not create successful empty reviews; the previous successful review remains visible.
Snapshots pin both sides of the diff to commit IDs. Workspace files are separate, mutable documents.
Review registration exposes only the current repository root to Git-context registration. Publishing a comparison starts session inspection through the composition root. The session cancels old jobs and clears the context snapshot; same-repository discovery retains PR content as Refreshing. Feature modules do not create runtimes or import each other's internals.

```text
Branch quick pick → BranchReview.compare → Git adapter → immutable Review
                                                       ↓
Native file list → snapshot URI → content provider → Git blob → native diff
        ↓
Open Workspace File → real file URI → editable workspace document
```

## Provider discovery

Keep configuration inspection and provider discovery outside BranchReview.
They own different facts, authentication requirements, and failure behavior.
Do not require network access to compare local branches.

```text
Repository selection
    ├── local BranchReview → native file list and diff
    └── GitContext inspection → safe identity and remote metadata
                                 ↓
                        PullRequests groups remotes
                         ├── GitHub adapter
                         └── Azure DevOps adapter
                                 ↓
                       Started / Updated Stream
                                 ↓
                       ReviewSession retained state
                                 ↓
                         native PR list / browser link
```

`GitContext`, the job-shaped GitHostingProvider contract, PullRequests and ReviewSession are implemented.
Core owns GitHub and Azure DevOps implementations and tests beside their shared contract. Its Providers.ts constructs the built-ins. The extension composition root supplies native authentication and HTTP transport through public Layer exports, not individual adapters. ReviewSession owns FiberMap jobs and exposes SubscriptionRef changes to both native views. Discovery reads at most four groups concurrently and emits results unordered. Connect and loadMore take group IDs, never UI-owned cursors.
See the [focused contract](04-capabilities-and-review-session.md) for refresh, Stale results, pagination and failure transitions. The [staged plugin design](plugins/00-problem.md) is historical, superseded by D007. No generic lifecycle or Bitbucket implementation is included.
Core contracts must not import provider SDKs or choose credentials implicitly.
Opening a discovered PR locally remains a proposed follow-up; selecting a PR currently opens its provider page.

## Operation observability

Meaningful service and Git-adapter operations use named `Effect.fn` spans by default.
The integration adds workflow spans for context inspection, branch listing, comparison, refresh, and snapshot reads, with correlated success/failure/interruption logs.
[Telemetry.ts](../../packages/extension/src/telemetry/Telemetry.ts) owns authenticated export and privacy projection; the managed runtime owns exporter shutdown.

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
The file-layout study inspected [v2 at this later revision](https://github.com/anomalyco/opencode/commit/5cfe3b42712a2384fc5136fca6df8e65903c85ee).
Borrow its feature entrypoints with nearby internals (`worktree.ts` and `worktree/`), colocated services/errors/Layers (`git.ts`), and host-owned runtime composition. Do not copy its entire package graph or split each schema and error into separate files.
This adopts OpenCode's headless runtime core rather than rat-stack's stricter contracts-only core. Node adapters stay inside their owning features; provider SDK and network boundaries remain subject to the provider contract.

RcRef fits one shared scoped resource; RcMap fits per-worktree watcher/session resources with reference-counted lifetime. Neither is needed for current one-shot Git reads or immutable blob value caching.
PersistedCache and KeyValueStore are unstable in the installed package. Defer persistent Git-context caching because identity/configuration must remain fresh.
Use Cache if repeated immutable blob reads justify it. Use scoped fibers, cancellation, Stream, and Schedule when watcher or provider-discovery work actually requires them.

## Fence and limits

[TypeScript](../../tsconfig.json) enforces strict checking and indexed-access checks.
[ESLint](../../eslint.config.mjs) checks Promise ownership and unsafe types, prohibits assertions, restricts core imports and runtime construction, and blocks extension imports of relative core source paths.
Editor commands and views cannot import provider implementations, authentication, HTTP or built-in construction. Core cannot import VS Code or extension code.
The [pre-commit gate](../../.githooks/pre-commit) runs check, test, and build. Enable it explicitly in each clone.

This is a partial rat-stack fence, not its full toolchain.
Effect compiler diagnostics, comment bans, comprehensive provider-import rules, and hook-bypass interception are not enforced yet.
The syntax-based boundary rules also do not prove alias or re-export behavior.
Report gaps honestly; do not claim these checks prove runtime correctness.

## Verification limits

The native UI was exercised in an isolated Extension Development Host.
Historical-document language intelligence is limited; full LSP behavior across languages was not verified.
Binary rendering, large-repository behavior, and automatic branch-change refresh were not verified.
Identity inspection is partial; see the [strategy contract](03-identity-and-provider-strategies.md) for remaining gaps. The current capability/session cutover passes check, 40 tests, packaging and native supplied-service UI verification. Real provider requests and native sign-in remain unverified. See the [delivery log](../implementation-log.md#2026-10-10-core-owned-pull-requests-and-review-session).
