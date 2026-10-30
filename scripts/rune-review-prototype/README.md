# Duff standalone — working Rune prototype

A native review window backed by Duff's existing TypeScript/Effect core. There is no synthetic-data mode. The question is whether a dedicated review window earns its place alongside the editor.

## Run

Prerequisites: Bun, Node **22.18+**, Rust **1.98.1** through rustup (`rustup toolchain install 1.98.1 --profile minimal`), Git, and an existing provider CLI login (`gh auth login` for GitHub or `az login` for Azure). Run `bun install --frozen-lockfile` at the repository root first. The launcher selects this Rust toolchain without changing your global default; `RUSTUP_TOOLCHAIN` can override it. Rune does not compile on the owner's older default Rust 1.91.

```sh
bash scripts/rune-review-prototype/run.sh
```

The launcher bundles the core bridge for **Node**, then builds and opens the native Rune app. Bun is the build tool; it is not the sidecar runtime because durable storage uses `node:sqlite`. The first Rust build downloads the pinned dependencies. Linux needs a working Vulkan driver, `libxkbcommon-dev` and the normal X11/Wayland libraries. macOS uses Metal and requires Xcode Command Line Tools. This is source-run software, not a signed or distributed application.

1. Paste a GitHub or modern Azure repository URL and click **Load PRs**.
2. Type an author name to filter the loaded PR pages. Use **Load more PRs** when available; the filter is not a server-wide search.
3. Select a PR. Core resolves exact revisions and acquires them into a separate managed workspace; it does not check out your working repository.
4. Choose a changed file. Rune renders its actual base/head Git blobs, with **Split / Unified**, syntax highlighting, selection and hunk navigation (`j` / `k`).
5. **Mark viewed** explicitly, then **Next unviewed**. The checkmark changes only after durable core storage succeeds. Reading a file alone does not mark it viewed.
6. Close and reopen the app, choose **Saved reviews**, then a saved entry. Core restores the pinned comparison, last file and viewed progress, not the latest branch tip.

The bottom switcher compares **Workbench** (inbox + files + diff), **Focus** (hide the inbox for code width) and **Inbox** (wide inbox + nearby file tabs). All operate on the same real review.

`DUFF_REPOSITORY` optionally prefills the URL. `DUFF_STANDALONE_DATA` overrides storage for isolated testing. `DUFF_NODE` selects a Node executable. Do not put credentials in repository URLs or these settings.

## Boundary and reuse

Rust owns the window, navigation and native diff presentation. It owns one Node child process and communicates through serialized JSON lines on private stdin/stdout pipes. Network, Git and persistence work runs off the rendering thread. External requests are decoded with Effect Schema; failures become finite diagnostics rather than raw provider errors. The bridge is a private Bun workspace with declared core/Effect dependencies under the root lockfile; root checks typecheck it and root tests build and exercise it without manual dependency links.

The Node composition root reuses `RepositoryDirectory`, provider adapters, CLI authentication, `ReviewWorkspaces`, `BranchReview`, `ReviewSessions` and the shared filesystem saved-review adapter through core's declared exports. Closing the window sends an out-of-band shutdown message, aborts active work and waits for Effect to dispose its owned processes and storage. There is deliberately no Node-only force-kill deadline: it could orphan detached Git/SSH groups. If underlying cleanup hangs, the window process waits for it. No FFI runtime embedding or Git/provider rewrite is needed.

Storage is separate from VS Code and the owner's repository catalog:

- macOS: `~/Library/Application Support/Duff-Standalone`
- Linux: `$XDG_DATA_HOME/Duff-Standalone` or `~/.local/share/Duff-Standalone`
- Windows: `%LOCALAPPDATA%/Duff-Standalone` (not yet platform-qualified)

Provider acquisition retains core's identity checks and pinned commits, including the managed Azure HTTPS-to-SSH fallback. Resume does not refresh metadata. File reads must belong to the saved comparison; added, deleted and renamed files use core's immutable snapshot logic. Binary, submodule, invalid-text and over-1-MiB file views fail visibly instead of becoming empty diffs.

## Scope and limits

This prototype performs provider reads and local review writes only. It does **not** post comments, approve or merge PRs, edit repository files, send telemetry, connect VS Code storage, or embed the owner's terminal/debugger/editor. Unsupported provider operations remain unavailable. CLI login must already work; no login browser flow is implemented. Requests are serial; while core is busy, review-changing controls do not enqueue more operations. There is no cancellation button or production installer yet.

Rune is pinned to [`aff5f631dffd2d65e3a3f031df4659756b567257`](https://github.com/anomalyco/rune/tree/aff5f631dffd2d65e3a3f031df4659756b567257) with a Cargo lockfile. Its [`rune_kit::diff`](https://github.com/anomalyco/rune/tree/aff5f631dffd2d65e3a3f031df4659756b567257/crates/rune-kit/src/diff) is the actual renderer. [`@pierre/diffs`](https://diffs.com/docs) uses HTML, CSS Grid and Shadow DOM; it is not a drop-in Rune widget. No supported embedded-webview component was found in this Rune revision, so Pierre is not included. A browser shell would be a different choice, not an invisible addition to this native prototype.

## Checks

```sh
bun run check
bun run test
bun run build
bash scripts/rune-review-prototype/bridge/build.sh
bunx tsc --noEmit -p scripts/rune-review-prototype/bridge/tsconfig.json
bunx vitest run scripts/rune-review-prototype/bridge/Bridge.test.ts --maxWorkers=1
cargo fmt --check --manifest-path scripts/rune-review-prototype/Cargo.toml
cargo build --locked --manifest-path scripts/rune-review-prototype/Cargo.toml
```

The bridge test uses real temporary Git repositories and storage, not provider fixtures. Live-provider and native rendering evidence must be reported separately from those tests. Private repository content must not be uploaded as public PR evidence.

Work lives on `prototype/rune-review-workspace`; opening a PR does not merge, release or replace the existing VS Code extension.
