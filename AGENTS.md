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
- `packages/core` owns headless application capabilities, grouped by feature. Keep schemas, service contracts, errors, Git implementations, and tests together. It cannot import VS Code or extension code.
- Core's Git implementations are local adapters behind Effect services. Invoke Git without a shell. Decode external values with Schema. Supply the environment at activation rather than reading it during module import.
- `packages/extension` owns native views, VS Code callbacks, telemetry, and one managed runtime. Dispose it on deactivation.
- Import core through its declared exports, not relative source paths. Dependencies point extension → core. Create packages only for independently useful responsibilities, not technical layers.
- Review views live under `packages/extension/src/review`. Clicking opens immutable diffs; opening a workspace file is a separate action.
- Keep expected failures typed. Do not turn failed comparisons into empty successful reviews.
- Name meaningful service and adapter operations with `Effect.fn("Domain.operation")`. Use `fnUntraced` only deliberately for small helpers. Observe workflow outcomes at the integration boundary.
- Follow the planetaryescape-observability skill for authenticated Hetzner export. Never export identities, config origins, URLs, file contents, argv, or raw exception text. Production extension mode has no exporter.
- Keep UI native. Do not add cloud infrastructure, provider integrations, notes, or commit navigation without a request.
- Do not use assertions, explicit any, non-null assertions, or unowned Promises. Do not bypass checks or hooks.

## Verification

Run `bun run check`, `bun run test`, and `bun run build`.
Run `bun run package` for a self-contained VSIX under `packages/extension`; smoke-test the installed artifact after packaging changes.
Use Effect-aware tests with real temporary Git repositories for Git behavior.
Exercise native UI in a clean VSCodium Extension Development Host and inspect screenshots when available.
Use separate user-data and extension directories, with third-party extensions disabled. Agent-browser through Electron CDP is for native UI checks, not a substitute for real-Git tests.
Use `~/source/oss/gbfm` for native testing. Keep its branch, files, and Git configuration unchanged.
Reuse one test host; close obsolete hosts before replacing them. Preserve the owner's working windows. Leave the current test window only when it is useful for the owner to inspect.

## Development

Press F5 with the Run Extension configuration. Its background task watches and rebuilds with Bun.
The extension manifest and development path are `packages/extension`, not the workspace root. Root scripts coordinate the workspaces; keep one Bun lockfile.
Run Developer: Reload Window in the development window after edits. Rebuild is automatic; extension-host hot reload is not.
For authenticated Hetzner telemetry on the owner's machine, run `bun run watch` in one terminal and `bun run dev /absolute/path/to/repository` in another.
The launcher requires Fish, SOPS, the owner's age key and encrypted ingestion secret, and the VSCodium CLI (`codium`). It uses a separate development profile and extension directory.
Install VSCodium on macOS with `brew install --cask vscodium`. F5 uses the editor where it is invoked; open this repository in VSCodium for VSCodium-hosted F5 sessions.
Close every window using that profile before relaunching so the new process inherits authentication. F5 without the scoped header still works but does not export.
