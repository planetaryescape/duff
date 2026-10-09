# Duff

Duff is a local VS Code review extension. Use Bun for installs and scripts.
Use https://ratstack.sh/llms.txt as the reference for Effect and enforceable boundaries.
Search its rules and skills before non-trivial work. Read the installed Effect AGENTS.md and source before using APIs.
Report code that violates these patterns. Local product choices take precedence over template-specific rules.
There is no Alchemy in this repository.

Read [docs/README.md](docs/README.md) for current behavior, accepted decisions, future slices, and delivery evidence.
Use the owner's `maintaining-blueprints` skill in `~/dotfiles` when maintaining these records.

## Boundaries

- Git is the source of truth. Review snapshots contain immutable commit IDs and changed paths, not copied file contents.
- `src/review.ts` owns review values and the job-shaped service contract.
- `src/git-review.ts` implements read-only Git operations. Invoke Git without a shell. Decode external values with Schema.
- `src/extension.ts` owns VS Code callbacks, command registration, and one managed runtime. Dispose it on deactivation.
- `src/review-view.ts` renders native VS Code file lists. Clicking opens immutable diffs; opening a workspace file is a separate action.
- Keep expected failures typed. Do not turn failed comparisons into empty successful reviews.
- Name meaningful service and adapter operations with `Effect.fn("Domain.operation")`. Use `fnUntraced` only deliberately for small helpers. Observe workflow outcomes at the integration boundary.
- Follow the planetaryescape-observability skill for authenticated Hetzner export. Never export identities, config origins, URLs, file contents, argv, or raw exception text. Production extension mode has no exporter.
- Keep UI native. Do not add cloud infrastructure, provider integrations, notes, or commit navigation without a request.
- Do not use assertions, explicit any, non-null assertions, or unowned Promises. Do not bypass checks or hooks.

## Verification

Run `bun run check`, `bun run test`, and `bun run build`.
Use Effect-aware tests with real temporary Git repositories for Git behavior.
Exercise native UI in an Extension Development Host and inspect screenshots when available.

## Development

Press F5 with the Run Extension configuration. Its background task watches and rebuilds with Bun.
Run Developer: Reload Window in the development window after edits. Rebuild is automatic; extension-host hot reload is not.
For authenticated Hetzner telemetry on the owner's machine, run `bun run watch` in one terminal and `bun run dev /absolute/path/to/repository` in another.
The launcher requires Fish, SOPS, the owner's age key and encrypted ingestion secret, and the VS Code CLI. It uses a separate development profile.
Close every window using that profile before relaunching so the new process inherits authentication. F5 without the scoped header still works but does not export.
