# Persistent PR review sessions - Progress

## Status: Implemented; preparing pull request

The user authorized implementation after the design confirmations. The problem and shape files preserve that earlier discussion; their proposed/open wording is historical. The implemented contract is documented in the repository README under Saved PR reviews.

- Multiple saved PR sessions with one snapshot each and no revision history.
- Native Resume Review picker and explicit Forget confirmation; no new sidebar panel.
- Automatic restore of the last active PR and diff in the same single-folder workspace; explicit Exit stays inactive.
- Viewed marks transfer only when full file comparisons are unchanged.
- Atomic workspace-local `reviews.json`, a single-writer lease, and per-session Git retention refs.
- Journalled Update/Forget cleanup; no expiry, silent eviction, or Git GC commands.
- Missing/corrupt storage and Git objects preserve the saved record and report failure.

Verification: 77 application tests and policy-rule tests, formatting/typecheck/lint, build and self-contained VSIX packaging passed. Installed-artifact native Linux VSCodium testing uses a disposable real-Git fixture with synthetic Azure and GitHub PR labels, not live provider credentials. Full host restart, separate progress, native picker switching, Exit persistence and namespace-safe Forget were exercised. macOS is not qualified by these Linux checks.

## Log

- 2026-10-15 23:21 Africa/Harare - Created spec folder; design only.
- 2026-10-15 - User confirmed multiple saved PR sessions; updated problem frame and drafted shape.
- 2026-10-15 - User confirmed unchanged-diff mark preservation on update; drafted exact comparison rule and restore question.
- 2026-10-15 - User confirmed automatic restoration of the last active review and diff; updated problem frame and shape.
- 2026-10-15 - User confirmed one current snapshot per PR session, no revision history; updated replacement semantics.
- 2026-10-15 - Addressed and merged PR #4, then implemented saved sessions and verified the packaged extension in an isolated native host.
