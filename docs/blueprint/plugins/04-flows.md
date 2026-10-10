# Flows: shared provider discovery

Status: superseded historical staged design. Use [capabilities and review session](../04-capabilities-and-review-session.md) and D007 for progressive grouped discovery and retained session state. Earlier fixture evidence does not verify the current native cutover.

## Current versus proposed

Today, [GitContextCommands](../../../packages/extension/src/git-context/GitContextCommands.ts) clears old rows and rejects stale inspection results through a request generation. Successful inspection starts provider discovery when enabled. Plugin commands own discovery generations and cancellation.

Runtime construction supplies the plugins, then repository selection starts local context inspection. With automatic discovery enabled, a successful inspection starts the shared discovery service. Refresh repeats the sequence. Local branch review remains a separate operation and does not await provider work.

```text
Activation -> supplied Layers -> one runtime
                                  |
Repository selected / refresh ----+
    |
    +-- local BranchReview --------------------------> review UI
    |
    +-- GitContext.inspect -> sanitized snapshot ----> context UI
                                  |
                       ProviderDiscovery.discover
                                  |
                    recognize each remote locally
                       /          |          \
                unsupported    ambiguous    unique match
                                               |
                                   inspect API authentication
                                               |
                                   list first open-PR page
                                               |
                                  normalized per-remote result
                                               |
                                   current-generation check
                                               |
                                          provider UI
```

## Happy path: first discovery

1. The composition root supplies built-in definitions, HTTP/authentication dependencies, and plugin construction Layers. It validates unique IDs and contribution kinds. Construction performs no provider requests or login prompts.
2. The host selects the repository. A new request generation clears previous provider rows and continuations, interrupts old discovery, and shows local inspection in progress.
3. GitContext.inspect receives the repository directory. Allowlisted Git reads produce a decoded GitContextSnapshot. Identity and credential-strategy metadata remain local; no helper is executed to obtain a secret.
4. If the generation still matches, publish the local snapshot. If automatic discovery is disabled, background inspection stops here with a Check Pull Requests button, not a claim of no PRs. That explicit action repeats inspection and performs a manual provider read without changing the setting.
5. ProviderDiscovery.discover receives the snapshot and uses its captured registry. Each sanitized Remote goes through the same ProviderContribution.recognizeRemote contract. Recognition performs no network I/O.
6. Zero matches yield Unsupported; multiple matches yield Ambiguous. Neither performs authentication or listing. A unique match yields a plugin identity and bound ProviderRepository.
7. Call the bound inspectAuthentication operation. Its adapter checks the selected API authentication mechanism without prompting. Decode external responses and return Authenticated, Unauthenticated, Unknown, or a typed inspection failure.
8. On successful inspection, call listOpenPullRequests with repository scope and no cursor. Do not make the service branch on GitHub versus Azure or infer authorization from Git email. Successful Unauthenticated or Unknown inspection still permits the attempt; the adapter may read publicly or return AuthenticationRequired. This is the proposed initial policy, not automatic anonymous fallback after a rejected session.
9. The adapter checks protocol status, decodes accepted API data, normalizes refs, source/target repositories, draft state, and PR identity, and returns a PullRequestPage. It keeps transport-specific DTOs and credentials private.
10. The service produces a Discovered or Failed row for that remote. Collect rows in input remote order; expected failures do not erase successful sibling rows. The host publishes only if the owning generation is still current.

The initial API returns a batch, not a stream. A remote's success is retained while other reads finish, then published with the completed batch. If progressive publication becomes a requirement, change the service contract deliberately rather than add callbacks to plugins.

## Authentication and authorization

- Git transport credentials and provider API sessions are distinct. A configured helper, SSH agent, or commit identity cannot create an Authenticated result.
- Authentication inspection failure stops that remote's listing attempt and becomes Failed. It is not Unknown or an empty page.
- A verified account can still lack repository access. Listing reports RepositoryUnavailable or AuthenticationRequired according to the adapter's safe classification.
- Session expiration between inspection and listing is a normal typed failure. Do not automatically switch accounts or retry anonymously.
- Background work never opens a login prompt. AuthenticationRequired offers a connection action only once that action's provider-specific mechanism has been designed. Until then, show an actionable missing-authentication state without a nonfunctional button.
- Connecting will be a separate user-triggered action, not part of these background operations. Successful connection must invalidate existing continuations and refresh context/discovery.

## Pagination: load more

1. A Discovered row with a next cursor is incomplete. Store the cursor privately in memory with the row's repository and request generation; expose a native Load More action, not the token.
2. The host allows one pending load-more request per row. It submits current GitContextSnapshot, remoteName, and the retained cursor to ProviderDiscovery.loadMore.
3. The service locates and recognizes the current remote again. Missing names yield RemoteNotFound. Unsupported or ambiguous recognition produces those truthful outcomes, not a provider read. Unique recognition passes the cursor to the bound repository operation.
4. The adapter validates continuation ownership against plugin, repository, query, and session before transport. Changed ownership yields InvalidContinuation. Cursor formats and token storage remain adapter-private; Redacted alone does not establish validity.
5. Successful results replace the continuation and append items to that row. Deduplicate by plugin, target repository identity, and PR ID; when a PR repeats, the later page's normalized record replaces its earlier record without creating another row.
6. An empty page with another cursor remains incomplete and permits another explicit load. No automatic unbounded pagination is started. A repeated nonterminal cursor is InvalidContinuation, not an endless Load More cycle.
7. On expected failure, keep already displayed PRs as partial results and show the failure alongside them. AuthenticationRequired, InvalidContinuation, changed routing, and RemoteNotFound invalidate the old cursor; offer refresh instead. A transient provider outage retains the cursor for an explicit retry. A rate-limit result retains it but waits for a supplied retry delay before permitting retry.
8. Before publishing, check generation and the owning row. A refresh or repository change discards late results even if the underlying adapter could not stop immediately.

Pages are not a provider-wide immutable snapshot. PRs can change or close between reads. Deduplication prevents duplicates but does not prove completeness against concurrent provider changes; refresh starts a new read.

## Failure presentation

| Outcome | Native presentation and next action |
| --- | --- |
| Local Git inspection fails | Safe local error, no provider work, retry inspection; branch review remains available |
| No remotes | No remotes configured, not zero PRs |
| Unsupported | Unsupported remote, no authentication/network work |
| Ambiguous | Show candidate plugin names; no registration-order selection. Explicit override UI is not in this slice |
| Authenticated | Safe account metadata may be shown locally; not proof of repository permission |
| Unauthenticated / Unknown | Show the truthful status alongside the listing outcome, never pretend login succeeded |
| Empty page, no cursor | No open PRs found by this completed read |
| Page with cursor | Show loaded PRs and Load More; do not label the full repository empty |
| AuthenticationRequired | Missing/rejected API authentication, no automatic login |
| RepositoryUnavailable | Missing or inaccessible repository, no invented diagnosis |
| RateLimited | Safe rate-limit state and provider-supplied delay when available; no automatic retry loop |
| ProviderUnavailable | Safe connection/service failure; explicit retry |
| InvalidProviderResponse | Invalid provider data, not an empty success; safe diagnostic and explicit refresh |
| InvalidContinuation / RemoteNotFound | Keep existing rows marked partial or stale; discard continuation and refresh |
| Defect | Report at the existing integration boundary; do not publish an empty successful batch |
| Interruption | Stop pending state for the owner; cancellation is not a provider error |

## Lifetime, concurrency, retries, and writes

The host owns each discovery/load-more fiber, observes completion, and interrupts it on replacement or deactivation. Child requests belong to that operation, not detached global work. Start with sequential per-remote reads; this is a bound of one and avoids inventing a concurrency setting before a measured need. Each adapter request must have a finite deadline, selected with the actual HTTP/authentication transport during implementation. A timed-out request maps to ProviderUnavailable and allows the remaining remotes to complete.

The host increments its generation before interrupting or clearing old work. It checks that generation on both success and failure publication. Existing Git-context generation handling is a reference for stale rejection, not proof that current code already interrupts subprocesses on clear.

Refresh discards old pages and cursors and starts from local GitContext inspection. Failure after refresh must not present the previous provider/account context as current. A failed load-more operation retains same-generation partial rows, which is different from refresh.

There is no polling schedule or automatic retry in this first workflow. Explicit retries still respect a supplied rate-limit delay. Reads can be repeated but are not immutable snapshots. No path fetches Git objects, changes configuration, checks out a branch, stores credentials, or mutates a PR.

## Observability

Use named spans for the host discovery/refresh/load-more workflows, service operations, authentication inspection, and provider listing. Pure recognition does not need a per-remote span containing remote data. Keep stable span names independent of repository, account, or PR identity.

The integration records safe success, expected failure, defect, and interruption summaries, retaining existing trace correlation. A batch with Failed rows is a partial outcome, not an unqualified successful discovery summary. Do not log response bodies, raw exceptions, URLs, repo keys, PR titles, accounts, helper configuration, tokens, or cursors. Continue using the existing development-only Hetzner privacy projection; this design adds no exporter or infrastructure.

## Next checkpoint

Review the proposed [file map](05-file-map.md) before the test plan. Provider authentication transport, deadlines, and a user-triggered connection action remain unresolved implementation choices, not implied permissions to access an account.
