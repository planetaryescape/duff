# File map

| Area | Planned changes |
| --- | --- |
| `scripts/rune-review-prototype/src/main.rs` | Enable/trust state, readiness, source-position conversion, correlated query state, native hover/peek/target selection, keyboard dismissal and return position. |
| `scripts/rune-review-prototype/src/bridge.rs` | Typed language payloads, independently owned request writer/response reader and request IDs; preserve independent graceful shutdown. |
| `scripts/rune-review-prototype/bridge/Bridge.ts` | Decode language operations, resolve saved review/side identity and compose analysis without holding the saved-review mutation gate. |
| `scripts/rune-review-prototype/bridge/main.ts` | Own concurrent response writes/tasks and shutdown/cancellation; keep frame writes atomic and error IDs correlated. |
| New cohesive language adapter/module under `bridge/` | Trusted pinned toolchain, bounded LSP framing/decoding, context/server lifetime, readiness, hover/definition projection and URI containment. Exact filenames follow implementation responsibility, not a new package layer. |
| Core review capability and declared package export, only where needed | Immutable revision-source tree enumeration/export through established shell-free Git/environment policy; no VS Code or standalone protocol imports. |
| `scripts/rune-review-prototype/Cargo.toml`, `Cargo.lock` | Latest observed upstream Rune pin plus consistent local patched source resolution. |
| New `native.sh` and narrow Rune source patch | Idempotent project-local dependency bootstrap, exact pin/patch verification, explicit Cargo config from any cwd. No global cache mutation or vendored renderer. |
| `bridge/package.json`, `bun.lock`, build script | Pin language-server/toolchain dependencies and make bundled runtime entry resolution reproducible after frozen install. Preserve unrelated existing root changes. |
| Prototype README/launcher | Actual build/bootstrap workflow, trust and limited-context behaviour, supported shortcuts and qualified platform limits. |
| Existing bridge tests plus feature-specific real-seam tests | Real Git/revisions and real language server; cancellation, context isolation, malformed data, URI containment and preserved progress. |
| Rune patch tests and native artifacts | Source-coordinate mapping and interaction evidence across split/unified and non-default states. Private repository evidence must not be posted publicly. |

No files to delete and no saved-review migration. Final filenames and exported operation names must be recorded after implementation so this map does not pretend proposed names are already shipped.
