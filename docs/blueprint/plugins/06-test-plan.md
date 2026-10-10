# Test plan: shared provider behavior

Status: test plan confirmed. These are future red/green cycles, not tests already written or executed. Public contracts: [03-contracts.md](03-contracts.md). Owners: [05-file-map.md](05-file-map.md).

## Approach

Use the existing Bun scripts and pinned @effect/vitest. Follow one failing behavior test with the smallest implementation that passes, then refactor while green. Do not write every test first or ship a types-only horizontal slice.

Core tests supply complete provider contributions through the service's construction seam. Adapter tests exercise real GitHub/Azure implementations with supplied HTTP and authentication services. No module patching, method spies, private-helper exports, or assertions about incidental call order.

The cycles below are test increments, not the eventual commit/PR boundaries. The delivery layer will group them into usable features. Introduce each behavior only as its cycle is reached.

## Prerequisite: finish safe per-remote Git context

- **Red:** Extend existing real-Git fixtures with two HTTPS remotes whose URL-specific username, useHttpPath, and helper resets differ. Assert each remote's effective strategy and preserve distinct commit author/committer facts. Use the existing secret canary and helper-execution marker to prove inspection does not expose credentials or execute helpers.
- **Green:** Complete S03's per-remote inspection through allowlisted Git CLI reads and decoded outputs. No provider API work in this cycle.
- **Refactor:** Keep parsing and safe projections in GitContext. Retain existing precedence/provenance tests unchanged.
- **Mistake caught:** Reporting global helper declarations as the effective strategy for every remote, or treating commit email as provider identity.

## Cycle 1: routing and one successful first page

- **Red:** Supply two complete contributions and a snapshot with an unsupported remote plus one recognized repository. Give that repository one draft PR from a fork with a different source repository and immutable source/target revisions. Through ProviderDiscovery.discover, assert remote order, Unsupported versus Discovered, account metadata, and the exact normalized PR fields.
- **Green:** Implement the shared schemas, construction seam, pure routing, and one-page service path. Keep registry empty as a valid configuration. Expected values are fixture constants, not output from the production normalizer.
- **Refactor:** Keep generic lifecycle in Plugin.ts, the provider contract in GitHostingProvider.ts, and sequencing in ProviderDiscovery. Do not add provider-ID conditions to the service.
- **Mistake caught:** Treating origin as the only remote, dropping drafts, substituting the target repository for a fork source, or overwriting one implementation with another under a shared tag.

Follow with a focused ambiguity cycle: two contributions recognize the same remote, producing Ambiguous with both identities and no provider transport activity. Use a supplied boundary that records actual external requests if proving no I/O is necessary, not a spy on recognition methods. Zero remotes and an empty registry produce truthful empty/unsupported outcomes, respectively.

## Cycle 2: GitHub through the actual adapter

- **Red:** Construct the GitHub definition through supplied dependencies. Recognize supported HTTPS and SSH forms for the same fixture repository and exercise bound authentication/listing against controlled protocol responses. Assert equal repository identities and independently specified PR normalization, including fork identity and draft state.
- **Green:** Implement only the supported GitHub forms and response/authentication translation needed for this public behavior. Select and verify the actual API/authentication transport before writing its fixtures. Construction and recognition must not request login or send network traffic.
- **Refactor:** Keep provider-specific parsing, response schemas, and dependency capture in its adapter. No native editor types leak into shared models.
- **Mistake caught:** Copying raw GitHub DTOs into core, recognizing userinfo as an account, or getting different identities for SSH versus HTTPS.

Add malformed/unsupported form cases where the right answer differs from an overly broad URL regex: unconfigured custom host, SSH alias, missing repository segment, and an unrelated host containing a provider name. Do not invent API fixtures from memory; pin them to the selected provider API documentation.

## Cycle 3: failure is not an empty repository

- **Red:** Two recognized remotes: the first yields a typed authentication/request failure; the second returns a valid empty terminal page. Assert Failed for the first and Discovered with empty items and no continuation for the second, preserving both rows.
- **Green:** Classify expected provider failures at adapters, then retain them as independent service outcomes. Continue siblings after expected failure; do not catch defects or interruption as empty success.
- **Refactor:** Keep safe messages fixed and errors beside their contract/adapter. Reuse the existing integration error boundary rather than add a parallel notification system.
- **Mistake caught:** Broad catch-and-return-empty behavior or failing the entire batch when one remote cannot be read.

Use targeted follow-up cycles for rejected credentials, repository unavailable, rate limiting with/without a supplied delay, malformed successful response, and request deadline. Compare successful Unauthenticated/Unknown inspection with failed inspection: the former may proceed to listing, the latter becomes Failed. A session rejected during listing cannot be silently retried anonymously. Control time through Effect test services; do not sleep to prove deadlines or retry delays.

## Cycle 4: continuation and partial-page semantics

- **Red:** First page is empty but has a continuation; next page contains a PR and terminates. Assert first-page incompleteness and successful loadMore, rather than concluding that the repository has no PRs.
- **Green:** Preserve opaque continuations with repository/query/session ownership and implement service load-more dispatch. Keep tokens out of labels, logs, and browser links.
- **Refactor:** Keep provider continuation formats private. Do not add persistence or a generic cursor service.
- **Mistake caught:** Dropping continuation because a page is empty, assuming a first page is complete, or following an arbitrary continuation URL.

Follow with asymmetric ownership cases: a cursor issued for repository A is presented for B, the same remote name now targets another repository, the session changes, and the remote disappears. Assert InvalidContinuation or RemoteNotFound as specified, not a successful read of the wrong repository. A repeated nonterminal cursor is rejected. Confirm a rate-limit/outage remains a typed failure, not a terminal page.

Native page accumulation is a separate observable check: page two repeats one PR with changed title and adds another; the view shows one updated record plus the new PR. A failed load-more preserves partial rows, while refresh clears them and invalidates the cursor.

## Cycle 5: cancellation and privacy at the owning boundary

- **Red:** Supply a hanging provider boundary with observable resource cleanup. Start discovery, interrupt its owning fiber, and assert interruption plus released request resources. Separately inject a defect and assert it is not converted into Discovered with empty items.
- **Green:** Own child work inside the request scope and propagate interruption through the selected HTTP/authentication adapter. At the editor boundary, invalidate generation before interruption and distinguish cancellation from unexpected failure notification.
- **Refactor:** Keep lifetime ownership in the existing managed runtime and feature workflow. Do not add a runtime per plugin.
- **Mistake caught:** Detached request work, leaked resources, cancellation swallowed as failure, or stale publication after switching repositories.

Extend Telemetry.test.ts with canaries in provider account metadata, PR title/URL, repository identity, cursor, and raw adapter failure. Exercise the existing export boundary and assert none appears in serialized logs/spans, while safe operation/outcome summaries and correlation remain. Do not merely assert Redacted.toString or inspect an intermediate object. A mixed batch must emit a partial summary rather than an unqualified success.

## Cycle 6: Azure parity without changing the service

- **Red:** Exercise the Azure implementation through the same provider contribution contract with controlled authentication/HTTP responses. Use repositories with the same leaf name in different projects and encoded path segments, supported HTTPS/SSH forms, an active draft PR, a distinct fork source where supported, and provider pagination. Assert the same normalized semantics already required of GitHub.
- **Green:** Implement the Azure adapter; leave ProviderDiscovery's public contract and routing policy unchanged. Record an actual contract gap if the provider cannot represent a required fact truthfully, rather than inventing it or making methods optional.
- **Refactor:** Share a small test contract helper only if the two adapter suites contain real duplicated behavioral assertions. Keep their external protocol fixtures provider-specific.
- **Mistake caught:** Azure project/organization identity collapsing into a repository name, misclassifying draft/active PRs, or adding provider conditions to core to compensate for adapter omissions.

## Native and packaged verification

Use clean VSCodium with gbfm unchanged for GitHub/local review. The owner also permits ADO testing with any repository under `~/source/work/frontend`; `srx-app` is the initial verified Azure SSH candidate. Preserve its branch, files, and configuration. See [approved testing context](07-pr-slices.md#approved-real-repository-testing-context). Reuse one test host, close obsolete hosts, and retain the owner's working windows.

For deterministic discovery states, use a temporary test-only extension entry under .amp/in that supplies complete fixture contributions through the same construction seam and invokes the production feature registration. It owns only its test runtime and uses real GitContext for the selected checkout. Do not patch imported modules, add a production fake-plugin setting, or expose credentials in fixture labels. This is proposed validation tooling, not a shipped extension entry or an existing harness.

Exercise these observable transitions:

1. Local review remains usable with no plugins and when provider reads fail.
2. Disabled discovery performs no provider reads and remains visibly disabled.
3. Mixed supported/unsupported/failed remotes show distinct native rows.
4. Empty terminal results differ from incomplete empty pages; Load More appends/deduplicates correctly.
5. A failed page preserves partial rows; refresh clears them. Delayed old success and failure cannot repopulate the refreshed view or trigger stale notifications.
6. Repository replacement/deactivation stops pending requests without an unexpected-error toast.

Inspect final captures for representative default, partial, failure, and refreshed states. Use DOM/accessibility assertions for interaction and screenshots for appearance. Keep captures under .amp/in/artifacts and remove temporary harness files after verification.

Run check, tests, build, and package through Bun. Smoke-test the normal self-contained VSIX, not only the temporary test bundle. Fixture-native checks prove host behavior; they do not prove real API authentication. A real authenticated account/repository smoke check requires explicit authorization and must be reported separately.

## Fence validation and coverage limits

- Probe prohibited adapter/SDK imports from core and native views; ensure they fail. Confirm the composition module remains allowed. Delete probe files afterward.
- Add focused recognition properties only where they express a real invariant, such as supported SSH/HTTPS forms preserving authority/key across generated valid repository names. Use Effect-compatible property APIs and valid generators; a property that only generates rejection cases proves little. Independently specify expected canonical identities and seed an intentionally wrong parser before trusting the property.
- Keep public behavior tests. Use temporary checks for import side effects, packaging contents, and negative lint probes where permanent tests would only freeze incidental structure.
- No real provider credentials, network calls, account actions, or production writes in routine tests. No tests for hypothetical future capabilities, marketplace loading, polling, or persistent caches.
- Native fixtures do not prove provider API versions, real account access, or installed CLI/session behavior. Those remain adapter-specific smoke evidence after transport selection and authorization.

## Next checkpoint

Review the proposed [delivery slices](07-pr-slices.md) and complete design folder. This plan does not authorize implementation or external authentication.
