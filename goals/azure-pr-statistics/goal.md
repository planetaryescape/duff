# Lazy Azure PR statistics and focus refresh

Show accurate Azure DevOps PR change totals using the existing authentication path, loading expensive statistics only for the selected PR. Cache completed comparisons and refresh stale metadata when the dashboard becomes active, its editor window regains focus, or a repository is selected or reselected. Keep cached results visible and handle unavailable data and late responses truthfully.

- Shared understanding: [facts.md](facts.md), all eight facts accepted through Plannotator.
- Execution plan: [plan.md](plan.md), approved through Plannotator.
- Proposed technical contracts and lifecycle: [tech-spec.md](tech-spec.md).
- Review provenance: [facts-review.json](facts-review.json), [facts-result.json](facts-result.json), and [facts.meta.json](facts.meta.json).

## Done condition

Implement and verify every accepted fact, including a qualified Azure comparison contract, bounded cache and owned requests, dashboard/repository focus refresh, retained stale-state rendering, and regression coverage. Pass `bun run check`, `bun run test`, and `bun run build`; exercise the clean native host; record delivery evidence and any live-provider limitations in the repository documentation. A plan or fixture-only endpoint test does not establish runtime delivery.

## Current state

Implemented locally and verified. `bun run check`, `bun run test` (270 application tests plus policy-rule tests), and `bun run build` passed. See [endpoint evidence](endpoint-evidence.md), [native verification](native-verification.md), and the [delivery log](../../docs/implementation-log.md#2026-10-25-lazy-pr-statistics-and-focus-refresh) for observed behavior and remaining qualification limits. Changes are not committed, installed into the owner's main profile, or released.
