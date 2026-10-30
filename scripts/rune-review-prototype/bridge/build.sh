#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# This prototype is outside the Bun workspace. Reuse installed workspace packages
# through their exports without another install, lockfile, or root dependency.
mkdir -p "$root/scripts/rune-review-prototype/bridge/node_modules/@duff"
ln -sfn "$root/packages/core" "$root/scripts/rune-review-prototype/bridge/node_modules/@duff/core"
ln -sfn "$root/packages/core/node_modules/effect" "$root/scripts/rune-review-prototype/bridge/node_modules/effect"
exec bun build "$root/scripts/rune-review-prototype/bridge/main.ts" --target=node --format=esm --outfile="$root/scripts/rune-review-prototype/bridge/dist/bridge.mjs"
