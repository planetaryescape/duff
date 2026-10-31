#!/usr/bin/env bash
# Exercise fail-closed bootstrap behavior in a disposable checkout, never the owner's source.
set -euo pipefail
prototype="$(dirname "$(realpath "$0")")"
"$prototype/native.sh" prepare
fixture="$(mktemp -d "${TMPDIR:-/tmp}/duff-rune-bootstrap.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
cp "$prototype/native.sh" "$prototype/rune-interactions.patch" "$fixture/"
git clone --quiet --shared "$prototype/.rune-source" "$fixture/.rune-source"
"$fixture/native.sh" prepare
before="$(git -C "$fixture/.rune-source" diff --binary | git hash-object --stdin)"
"$fixture/native.sh" prepare
[[ "$(git -C "$fixture/.rune-source" diff --binary | git hash-object --stdin)" == "$before" ]]
reject() {
    if "$fixture/native.sh" prepare > "$fixture/rejection.log" 2>&1; then
        echo 'Bootstrap accepted unexpected source state.' >&2
        exit 1
    fi
}
printf '\nUnexpected edit\n' >> "$fixture/.rune-source/LICENSE"
reject
grep -q 'Unexpected edit' "$fixture/.rune-source/LICENSE"
git -C "$fixture/.rune-source" restore LICENSE
printf 'unexpected\n' > "$fixture/.rune-source/unexpected-file"
reject
rm "$fixture/.rune-source/unexpected-file"
added_file="$fixture/.rune-source/crates/rune-kit/src/diff/view/code.rs"
cp "$added_file" "$fixture/code.rs.before"
printf '\n// Unexpected patch-added-file edit\n' >> "$added_file"
reject
cmp -s "$added_file" "$fixture/code.rs.before" && exit 1
cp "$fixture/code.rs.before" "$added_file"
printf '\nUnexpected staged edit\n' >> "$fixture/.rune-source/LICENSE"
git -C "$fixture/.rune-source" add LICENSE
reject
git -C "$fixture/.rune-source" restore --staged LICENSE
git -C "$fixture/.rune-source" restore LICENSE
"$fixture/native.sh" prepare
git -C "$fixture/.rune-source" apply --reverse "$fixture/rune-interactions.patch"
"$fixture/native.sh" prepare
[[ "$(git -C "$fixture/.rune-source" diff --binary | git hash-object --stdin)" == "$before" ]]
echo 'Rune bootstrap: idempotence, clean reapplication, and dirty/staged/untracked rejection passed.'
