#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.98.1}"
prototype="$(dirname "$(realpath "$0")")"
command -v bun >/dev/null || { echo 'Duff needs Bun to build the existing Effect core.' >&2; exit 1; }
command -v cargo >/dev/null || { echo 'Duff needs a current Rust toolchain (rustup).' >&2; exit 1; }
command -v "${DUFF_NODE:-node}" >/dev/null || { echo 'Duff needs Node 22.18+ for node:sqlite.' >&2; exit 1; }
"${DUFF_NODE:-node}" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) { console.error("Duff needs Node 22.18+ for node:sqlite."); process.exit(1); }'
bash "$prototype/bridge/build.sh"
export DUFF_BRIDGE="$prototype/bridge/dist/bridge.mjs"
exec cargo run --locked --manifest-path "$prototype/Cargo.toml" -- "$@"
