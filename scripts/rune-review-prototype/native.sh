#!/usr/bin/env bash
# Rune is MIT licensed; the pinned checkout retains upstream LICENSE and attribution.
# Usage: native.sh prepare | native.sh build --locked | native.sh test --locked ...
set -euo pipefail
prototype="$(dirname "$(realpath "$0")")"
source_dir="$prototype/.rune-source"
patch_file="$prototype/rune-interactions.patch"
revision=3062e9b86b5a02b97c8ed4e8f49fcfc4d6902fc1
lock="$prototype/.rune-source.lock"
mkdir "$lock" 2>/dev/null || { echo 'Rune bootstrap is already running (or a stale .rune-source.lock needs inspection).' >&2; exit 1; }
temporary=
cleanup() {
    if [[ -n "$temporary" ]]; then rm -rf -- "$temporary"; fi
    rmdir "$lock"
}
trap cleanup EXIT
fail() { printf '%s\n' "$*" >&2; exit 1; }
if [[ ! -e "$source_dir" ]]; then
    temporary="$(mktemp -d "$prototype/.rune-source.bootstrap.XXXXXX")"
    git init --quiet "$temporary"
    git -C "$temporary" remote add origin https://github.com/anomalyco/rune
    git -C "$temporary" fetch --quiet --depth=1 origin "$revision"
    git -C "$temporary" checkout --quiet --detach "$revision"
    mv "$temporary" "$source_dir"
    temporary=
fi
[[ -d "$source_dir/.git" ]] || fail 'Rune source is not an owned Git checkout.'
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]] || fail 'Unexpected Rune HEAD; refusing to reset or overwrite it.'
git -C "$source_dir" diff --cached --quiet || fail 'Unexpected Rune staged modifications.'
if git -C "$source_dir" diff --quiet; then
    [[ -z "$(git -C "$source_dir" ls-files --others --exclude-standard)" ]] || fail 'Unexpected Rune untracked files.'
    git -C "$source_dir" apply --check "$patch_file"
    git -C "$source_dir" apply "$patch_file"
fi
# Construct the exact expected tree in a private index. This also verifies patch-added files
# without staging them in the source checkout or relying on machine-specific diff settings.
verify_index="$source_dir/.git/duff-verify-index"
GIT_INDEX_FILE="$verify_index" git -C "$source_dir" read-tree HEAD
GIT_INDEX_FILE="$verify_index" git -C "$source_dir" apply --cached "$patch_file"
GIT_INDEX_FILE="$verify_index" git -C "$source_dir" diff --quiet || fail 'Unexpected Rune modifications or patch version. Inspect the checkout; bootstrap never resets it.'
[[ -z "$(GIT_INDEX_FILE="$verify_index" git -C "$source_dir" ls-files --others --exclude-standard)" ]] || fail 'Unexpected Rune untracked files.'
config="$source_dir/.git/duff-cargo.toml"
# TOML literal strings preserve spaces and backslashes; reject the one delimiter we use.
[[ "$source_dir" != *"'"* && "$source_dir" != *$'\n'* ]] || fail 'Rune checkout path contains an unsupported quote or newline.'
{
    printf "[patch.'https://github.com/anomalyco/rune']\n"
    for crate in rune rune-kit rune-motion rune-staging; do
        printf "%s = { path = '%s/crates/%s' }\n" "$crate" "$source_dir" "$crate"
    done
} > "$config"
if [[ "${1:-}" == prepare ]]; then
    [[ $# == 1 ]] || fail 'prepare accepts no arguments.'
    printf 'Rune %s + verified interaction patch ready.\n' "$revision"
    exit 0
fi
[[ $# -gt 0 ]] || set -- build --locked
cleanup
trap - EXIT
# Cargo discovers config relative to cwd, so always enter the prototype before invoking it.
cd "$prototype"
exec cargo --config "$config" "$@"
