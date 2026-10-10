# File map: built-in provider plugins

Status: file map confirmed; paths are not created implementation files. Follows the confirmed [contract](03-contracts.md) and [flows](04-flows.md). Keep the existing two Bun packages; add a plugins feature, not technical-layer packages.

## Proposed shape

```text
packages/core/src/
  plugins/
    Plugin.ts
    ProviderDiscovery.ts
    ProviderDiscovery.test.ts
  git-context/
    GitContext.ts
    GitContext.test.ts
  review/
    BranchReview.ts
    BranchReview.test.ts

packages/extension/src/
  plugins/
    PluginLayers.ts
    PluginCommands.ts
    PluginView.ts
    github/
      GitHubPlugin.ts
      GitHubPlugin.test.ts
    azure-devops/
      AzureDevOpsPlugin.ts
      AzureDevOpsPlugin.test.ts
  extension.ts
```

This lists affected feature fronts, not every existing extension file. Existing review, Git-context, and telemetry folders remain where they are. No provider implementation moves into core.

## Files to add

| File | Responsibility |
| --- | --- |
| `packages/core/src/plugins/Plugin.ts` | General plugin definition/instance types and the initial closed provider contribution contract. Own shared identity, authentication, PR/page schemas, safe provider errors, and repository-bound operation interfaces together. No SDKs, I/O, registry singleton, or runtime. |
| `packages/core/src/plugins/ProviderDiscovery.ts` | Effect service, construction and dependency-preserving Layer for discovery/load-more. Receives immutable built-in instances as construction input; owns recognition routing, ambiguity, ordered independent outcomes, and continuation dispatch. Imports the public contracts from nearby Plugin.ts. |
| `packages/extension/src/plugins/PluginLayers.ts` | Explicit built-in composition. Select plugin definitions, construct immutable instances, check duplicate IDs/contribution kinds, and supply them to ProviderDiscovery. Preserve dependency requirements until extension.ts supplies HTTP/authentication implementations. No runtime construction, network reads, or command registration. |
| `packages/extension/src/plugins/github/GitHubPlugin.ts` | GitHub definition and construction Effect, remote parser, repository-bound operations, response decoding/normalization, authentication and HTTP translation. Own provider-specific configuration and errors that do not belong in the shared contract. |
| `packages/extension/src/plugins/azure-devops/AzureDevOpsPlugin.ts` | Same contract for Azure DevOps, including organization/project/repository parsing and provider-specific normalization. No changes to core discovery policy to support Azure. |
| `packages/extension/src/plugins/PluginCommands.ts` | Native discovery, refresh, and load-more command registration; generation ownership, interruption, current context/row handling, page accumulation, and safe result publication. Calls core service methods, never provider APIs. |
| `packages/extension/src/plugins/PluginView.ts` | Native tree rows for remote/plugin context, PRs, failures, partial pages, and actions. Presentation only; no plugin selection, API calls, or secret-bearing cursor in labels/command arguments. |

The two core files are neighboring parts of one feature: Plugin.ts owns the shared contract; ProviderDiscovery.ts owns its execution policy. Do not add separate identity, error, registry, cursor, or schema files by default.

PluginLayers is composition, not a new authority service. It earns a file by keeping the built-in assembly out of the short entrypoint; it must not become a second application bootstrap.

Provider recognition belongs to its adapter even though it is pure. Keep provider-specific URL spellings and response decoding near the operations that need them. Split private internals only if the provider module actually becomes unwieldy, not to match a template.

## Files to change

| Existing file | Change required by the design |
| --- | --- |
| `packages/core/package.json` | Add explicit `@duff/core/plugins` and `@duff/core/provider-discovery` exports for the contract and service. No provider SDK dependency. |
| `packages/extension/src/extension.ts` | Supply built-in composition and selected authentication/HTTP Layers to the existing managed runtime. Register the native plugin feature and coordinate invalidation with repository/review changes through narrow callbacks. |
| `packages/extension/src/git-context/GitContextCommands.ts` | Publish a successful local context to plugin integration through a narrow callback, and notify invalidation. Keep local inspection useful without discovery and preserve generation checks. Do not put provider workflow here. |
| `packages/extension/src/review/ReviewCommands.ts` | Reuse its existing composition-root invalidation callback when a review/repository is published. Change only if the integration needs a repository-selection signal that is not already exposed. No provider imports. |
| `packages/extension/src/Operations.ts` | Extend runtime/error translation for the new core service. Own and observe cancellable command work without turning interruption into the existing generic unexpected-error toast. Expected provider failures already arrive as per-remote data. |
| `packages/extension/src/telemetry/Telemetry.ts` | Declare stable new operation names and truthful batch summaries, including partial outcomes. Preserve exporter privacy projection and development-only behavior. |
| `packages/extension/package.json` | Declare the native provider view, discovery/refresh/load-more commands, view activation as needed, and the automatic-discovery disable setting. Add only dependencies required by the chosen adapters. |
| `eslint.config.mjs` | Extend import restrictions so native commands/views cannot import provider adapters or transport SDKs; core cannot import provider adapters/SDKs. Keep composition exceptions explicit. No rules claimed until negative probes pass. |
| Blueprint, implementation plan, and implementation log | Record actual delivery and verification as slices land. Do not mark these proposed paths implemented before then. |

The current Operations.runOperation catches unexpected rejected work as a generic error. The new fiber boundary must distinguish interruption before that translation. GitContext's current clear rejects stale results but does not interrupt pending inspection: generation checks and cooperative interruption are separate responsibilities.

## Test files

| File | Public behavior covered |
| --- | --- |
| `packages/core/src/plugins/ProviderDiscovery.test.ts` | Supplied complete plugin contributions: routing, overlapping recognition, per-remote success/failure, pagination ownership, and cancellation. No SDK/module mocks or assertions about private helper call order. |
| `packages/extension/src/plugins/github/GitHubPlugin.test.ts` | Shared provider contract exercised through the real GitHub adapter with supplied authentication/HTTP seams, including HTTPS/SSH recognition, decoded PRs, and expected failures. |
| `packages/extension/src/plugins/azure-devops/AzureDevOpsPlugin.test.ts` | Equivalent observable contract with asymmetric Azure repository fixtures, active/draft PR normalization, and pagination. |
| Existing `GitContext.test.ts` | Extend real Git/config fixtures for remaining per-remote credential-strategy work before provider delivery. This stays in S03, not the plugin adapter. |
| Existing `Telemetry.test.ts` | New summaries and secret-canary privacy checks at the export boundary. |

Native command/view behavior will be validated in clean VSCodium against gbfm, with supplied safe discovery fixtures for deterministic failure and partial-page states. Do not add a runtime toggle or production fake-plugin selector solely for testing. The test-plan layer will define the harness and red/green slices; no harness has been selected or added here.

## Configuration, runtime, and unresolved placement

- No database, persistence file, plugin manifest format, dynamic loader, independent package, or migration is required.
- Automatic-discovery preferences belong to the extension's declared settings and are read at its boundary, not from ambient globals in plugins.
- Plugin definitions receive typed dependencies through construction. Only the composition root selects environment/configuration inputs.
- Authentication transport remains open. A substantial VS Code/CLI-specific authentication adapter should be a private neighbor in its provider folder; no generic authentication package or token store is prescribed. If both providers need a genuinely shared host mechanism, name and place it after that mechanism is chosen.
- Timeout policy belongs to provider request execution. Select finite deadlines with the actual transport; no arbitrary global timeout setting is added by this map.
- Existing Bun build/watch and VSIX packaging continue to bundle the extension and core. Recheck packaging if a chosen SDK introduces assets or runtime dependency traversal.

## Files to delete

None. This is an additive feature plan, not another organization pass.

## Next checkpoint

Review the proposed [test plan](06-test-plan.md) before delivery slices. The plugin API and native integration have concrete owners; authentication internals remain open, and the test plan proposes a temporary native-validation harness rather than a production fixture mode.
