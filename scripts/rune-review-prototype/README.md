# Duff standalone — working Rune prototype

A native review window backed by Duff's existing TypeScript/Effect core. There is no synthetic-data mode. The question is whether a dedicated review window earns its place alongside the editor.

## Run

Prerequisites: Bun, Node **22.18+**, Rust **1.98.1** through rustup (`rustup toolchain install 1.98.1 --profile minimal`), Git, and an existing provider CLI login (`gh auth login` for GitHub or `az login` for Azure). Run `bun install --frozen-lockfile` at the repository root first. The launcher selects this Rust toolchain without changing your global default; `RUSTUP_TOOLCHAIN` can override it. Rune does not compile on the owner's older default Rust 1.91.

```sh
bash scripts/rune-review-prototype/run.sh
```

The launcher bundles the core bridge for **Node**, then builds and opens the native Rune app. Bun is the build tool; it is not the sidecar runtime because durable storage uses `node:sqlite`. The first Rust build downloads the pinned dependencies and prepares the local Rune source patch described below. Linux needs a working Vulkan driver, `libxkbcommon-dev` and the normal X11/Wayland libraries. macOS uses Metal and requires Xcode Command Line Tools. This is source-run software, not a signed or distributed application.

1. Paste a GitHub or modern Azure repository URL and click **Load PRs**.
2. Type an author name to filter the loaded PR pages. Use **Load more PRs** when available; the filter is not a server-wide search.
3. Select a PR. Core resolves exact revisions and acquires them into a separate managed workspace; it does not check out your working repository.
4. Choose a changed file. Rune renders its actual base/head Git blobs, with **Split / Unified**, syntax highlighting, selection and hunk navigation (`j` / `k`).
5. **Mark viewed** explicitly, then **Next unviewed**. The checkmark changes only after durable core storage succeeds. Reading a file alone does not mark it viewed.
6. Close and reopen the app, choose **Saved reviews**, then a saved entry. Core restores the pinned comparison, last file and viewed progress, not the latest branch tip.

The bottom switcher compares **Workbench** (inbox + files + diff), **Focus** (hide the inbox for code width) and **Inbox** (wide inbox + nearby file tabs). All operate on the same real review.

`DUFF_REPOSITORY` optionally prefills the URL. `DUFF_STANDALONE_DATA` overrides storage for isolated testing. `DUFF_NODE` selects a Node executable. Do not put credentials in repository URLs or these settings.

## TypeScript code intelligence

Choose **Enable code intelligence**, read the trust prompt and enable it for this review. Duff starts its pinned TypeScript language server for separate immutable base/head source contexts. It runs with your account privileges, **not in an OS sandbox**. It does not install PR dependencies, run project scripts, load project plugins or download typings. Closing or replacing the review clears enablement.

Hover over a TypeScript/TSX symbol for its type/documentation. **Command-click** (Control-click off macOS), **F12** after clicking a symbol, or **Peek definition** opens a read-only excerpt from that same revision, including unchanged files. Choose between multiple targets when available. **Back / Escape** dismisses the peek without replacing the diff, changing its selection or marking files viewed. Ordinary text drag/copy remains available.

Results are explicitly **limited**: exact third-party dependencies, generated files and the project's TypeScript version are not supplied; configuration is restricted. Source-local answers are useful, but unresolved external symbols are not proof that no definition exists. An empty result and a failed language operation are shown separately. Language failure does not disable review reading or durable viewed progress. Source preparation and excerpts are bounded; oversized or unsupported contexts fail visibly.

Analysis selects TS/JS-family and JSON/JSONC inputs, including unchanged imports and configuration; it skips unrelated assets and vendored `.yarn` toolchains. Each tree may contain at most 4,096 entries, selected inputs at most 16 MiB in total and each selected blob at most 1 MiB. Unsafe paths, symlinks, submodules and case/normalization collisions fail closed rather than becoming a misleading successful context. Definition results contain at most eight bounded excerpts. Other-language files and missing dependencies remain outside this limited source context.

## Boundary and reuse

Rust owns the window, navigation and native diff presentation. It owns one Node child process and communicates through serialized JSON lines on private stdin/stdout pipes. Network, Git and persistence work runs off the rendering thread. External requests are decoded with Effect Schema; failures become finite diagnostics rather than raw provider errors. The bridge is a private Bun workspace with declared core/Effect dependencies under the root lockfile; root checks typecheck it and root tests build and exercise it without manual dependency links.

The Node composition root reuses `RepositoryDirectory`, provider adapters, CLI authentication, `ReviewWorkspaces`, `BranchReview`, `ReviewSessions` and the shared filesystem saved-review adapter through core's declared exports. Closing the window sends an out-of-band shutdown message, aborts active work and waits for Effect to dispose its owned processes and storage. There is deliberately no Node-only force-kill deadline: it could orphan detached Git/SSH groups. If underlying cleanup hangs, the window process waits for it. No FFI runtime embedding or Git/provider rewrite is needed.

Storage is separate from VS Code and the owner's repository catalog:

- macOS: `~/Library/Application Support/Duff-Standalone`
- Linux: `$XDG_DATA_HOME/Duff-Standalone` or `~/.local/share/Duff-Standalone`
- Windows: `%LOCALAPPDATA%/Duff-Standalone` (not yet platform-qualified)

Provider acquisition retains core's identity checks and pinned commits, including the managed Azure HTTPS-to-SSH fallback. Resume does not refresh metadata. File reads must belong to the saved comparison; added, deleted and renamed files use core's immutable snapshot logic. Binary, submodule, invalid-text and over-1-MiB file views fail visibly instead of becoming empty diffs.

## Scope and limits

This prototype performs provider reads and local review writes only. It does **not** post comments, approve or merge PRs, edit repository files, send telemetry, connect VS Code storage, or embed the owner's terminal/debugger/editor. Unsupported provider operations remain unavailable. CLI login must already work; no login browser flow is implemented. Durable review operations remain ordered; read-only language requests are independently correlated and cancelled when superseded. There is no acquisition cancellation button or production installer yet.

Rune is pinned to [`3062e9b86b5a02b97c8ed4e8f49fcfc4d6902fc1`](https://github.com/anomalyco/rune/tree/3062e9b86b5a02b97c8ed4e8f49fcfc4d6902fc1) with a Cargo lockfile. Its `rune_kit::diff` is the actual renderer. Upstream does not yet expose diff symbol-position callbacks, so `rune-interactions.patch` adds narrow hooks using Rune's actual shaped-text hit testing, reversing tab padding and wrapping insertions before source-position conversion. `native.sh` fetches the exact revision into ignored `.rune-source`, verifies/applies only the known patch, and supplies explicit local Cargo overrides. It refuses unexpected source changes rather than resetting them. It never changes global Cargo sources. Use this wrapper instead of raw Cargo build/test commands. Rune remains MIT-licensed; its checkout retains the upstream license.

[`@pierre/diffs`](https://diffs.com/docs) uses HTML, CSS Grid and Shadow DOM; it is not a drop-in Rune widget. A browser shell would be a different choice, not an invisible addition to this native prototype.

## Checks

```sh
bun run check
bun run test
bun run build
bash scripts/rune-review-prototype/bridge/build.sh
bunx tsc --noEmit -p scripts/rune-review-prototype/bridge/tsconfig.json
bunx vitest run scripts/rune-review-prototype/bridge/Bridge.test.ts --maxWorkers=1
cargo fmt --check --manifest-path scripts/rune-review-prototype/Cargo.toml
bash scripts/rune-review-prototype/native-bootstrap.test.sh
bash scripts/rune-review-prototype/native.sh build --locked
bash scripts/rune-review-prototype/native.sh test --locked
```

The bridge test uses real temporary Git repositories and storage, not provider fixtures. Live-provider and native rendering evidence must be reported separately from those tests. Private repository content must not be uploaded as public PR evidence.

Work lives on `prototype/rune-review-workspace`; opening a PR does not merge, release or replace the existing VS Code extension.
