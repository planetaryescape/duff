#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
exec bun build "$root/scripts/rune-review-prototype/bridge/main.ts" --target=node --format=esm --outfile="$root/scripts/rune-review-prototype/bridge/dist/bridge.mjs"
