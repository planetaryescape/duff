# Delivery slices: built-in provider discovery

Status: owner authorized implementation. Slice 1 is in progress; provider adapters remain unimplemented. Deliver local atomic commits; pushing, publishing, and authenticated account checks require their own authorization. Full-folder Plannotator feedback remains pending.

Each slice leaves local review usable. Tests are developed vertically according to [06-test-plan.md](06-test-plan.md), not as a separate all-types or all-tests delivery. The [file map](05-file-map.md) names ownership; these slices name observable outcomes.

## Slice 1: truthful credential strategy for each remote

**Delivers:** the Git Context view shows each remote's applicable safe credential strategy, configured username, and useHttpPath behavior, alongside existing identity/provenance. It distinguishes configured metadata from verified API authentication.

- Complete the remaining S03 behavior through GitContext, its real Git tests, and native context presentation.
- Keep custom helper execution, credential retrieval, provider calls, and login out of this slice.
- Verify URL-specific matching, helper resets, multiple remotes, identity overrides, and canary privacy through real isolated fixtures, then inspect the native result.
- Relevant scope: the prerequisite in the [test plan](06-test-plan.md#prerequisite-finish-safe-per-remote-git-context) and existing Git-context owners in the [file map](05-file-map.md).

**Acceptance:** two remotes with different credential settings produce different truthful rows; no helper is invoked, secrets are not exposed, and local branch review works unchanged. Commit the feature, tests, and delivery records together.

**Deferred:** plugin implementation and API authentication. No contract-only commit is necessary to deliver this local capability.

Current increment: conventional HTTP(S) URLs now have per-remote policy rows, and SSH is separate. Userinfo-bearing remotes, encoded/nonstandard paths, and partial/user-qualified credential patterns remain explicitly unresolved. This increment is useful but does not claim complete Git credential matching; see the [implementation log](../../implementation-log.md#2026-10-10-per-remote-credential-policy-increment).

## Slice 2: usable GitHub discovery through the shared plugin contract

**Delivers:** supported GitHub remotes show open PRs through the native provider view, with draft/fork context, explicit failures, and Load More. Automatic discovery can be disabled and never prompts for login or blocks branch comparison.

- Implement the shared [contract](03-contracts.md), ProviderDiscovery service, GitHub plugin, explicit built-in Layer composition, and native registration/view together.
- Complete the [flows](04-flows.md) for empty/unsupported/ambiguous results, independent per-remote failures, pagination, interruption, stale-result rejection, and safe summaries. Do not merge a registry-only skeleton as the usable slice.
- Select the GitHub authentication transport before implementing its adapter. Supplying an available session is separate from prompting to connect; do not ship an inert connection button. Record the chosen strategy and any explicit connection behavior before enabling it.
- Cover test cycles 1 through 5 as behavior increments. Validate import restrictions with negative probes and preserve the existing telemetry privacy projection.
- Verify deterministic native states through supplied fixtures and the normal packaged VSIX. Any authenticated GitHub smoke check is a separate authorized read, not a prerequisite silently performed with discovered credentials.

**Acceptance:** a supported repository shows a correctly normalized PR list or a truthful actionable failure, pagination does not lie about completeness, refresh invalidates old account/page context, and provider outages leave review usable.

**Deferred:** Azure implementation, future provider capabilities, polling, persistent caching, and opening a PR as a local review. The shared contract is already complete for both providers; Azure is not represented by optional methods or a fake success stub.

## Slice 3: Azure DevOps parity using the same service and UI

**Delivers:** Azure remotes have the same discovery, pagination, failure, and cancellation capabilities as GitHub. A repository with remotes on both providers can show independent outcomes through the same native view.

- Add the Azure adapter and its explicit built-in composition entry. Keep ProviderDiscovery and native presentation provider-neutral.
- Select Azure authentication transport before implementing its adapter and verify the selected API version/remote forms against authoritative sources.
- Cover cycle 6 and apply the existing failure/pagination/privacy requirements to Azure-specific protocol fixtures. Do not infer Azure account identity from Git helper configuration.
- Use an approved real ADO checkout for local recognition and native review checks, without changing its branch, files, or configuration. Test expected unavailable-authentication behavior without opening a login prompt.

**Acceptance:** Azure organization/project/repository identity survives normalization, active/draft PRs satisfy the same domain contract, and all existing GitHub/local-review checks still pass without provider conditions added to core.

**Deferred:** authenticated ADO API smoke testing until explicitly authorized, Git acquisition, PR mutations, and undefined future service capabilities.

## Approved real-repository testing context

The owner permits local ADO testing with repositories under `~/source/work/frontend`. Read-only inspection on 2026-10-10 confirmed Azure SSH remotes in `srx-app`, `srx-ui-lib`, and `srx-engine`. Use `srx-app` as the initial native candidate; the others are alternatives. `checkers-web-platform` was inspected and uses Bitbucket, so it is not an ADO fixture.

Keep full remote URLs, project paths, and account details out of committed fixtures, screenshots intended for sharing, and exported telemetry. Use synthetic `.invalid` identities and sanitized representative forms for permanent tests. A real checkout supplies local runtime evidence, not permission to execute credential helpers, log in, fetch, or query its provider API.

Continue using `~/source/oss/gbfm` for GitHub/local-review native checks. For ADO, switch the existing isolated VSCodium test host to the selected frontend checkout rather than accumulating windows. Record and preserve preexisting worktree state in both repositories.

## Delivery order and gates

1. Complete and verify Slice 1 before provider network functionality, preserving D003.
2. Complete Slice 2 with the shared boundary proved by supplied services and one actual provider adapter.
3. Add Slice 3 through that established boundary, proving parity without redesigning the service.

These align with S03, S04, and S05 in the [implementation plan](../../implementation-plan.md). S06, opening a discovered PR locally, remains a separate follow-up with its own missing-ref/acquisition design.

Use the repository gate for each atomic commit. Package and inspect native outcomes for each usable UI slice. The larger slice may contain several coherent commits as behavior becomes usable; do not call unimplemented contracts a shipped feature. Update the implementation log with actual validation and delivery state, not the intended acceptance criteria.

The remaining design choices are authentication mechanisms and finite request deadlines tied to those mechanisms. No new packages, infrastructure, migrations, loaders, or marketplace API are required. Review the complete design folder before implementation begins.
