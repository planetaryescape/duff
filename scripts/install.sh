#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: bash install.sh [code|codium|code-insiders|/path/to/editor-cli]'
  echo 'Requires GitHub CLI (gh auth login) and an editor CLI on PATH.'
  if [[ $# -gt 1 ]]; then exit 1; fi
  exit 0
fi

editor="${1:-}"
if [[ -z "$editor" ]]; then
  for candidate in code codium code-insiders; do
    if command -v "$candidate" >/dev/null 2>&1; then
      editor="$candidate"
      break
    fi
  done
fi

if [[ -z "$editor" ]] || ! command -v "$editor" >/dev/null 2>&1; then
  echo 'No editor CLI found. Add code or codium to PATH, or pass its full CLI path.' >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo 'Install GitHub CLI (https://cli.github.com), then run gh auth login.' >&2
  exit 1
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/duff-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT

echo 'Downloading the latest published Duff release…'
if ! gh release download --repo planetaryescape/duff --pattern 'duff-*.vsix' --dir "$temporary"; then
  echo 'Could not download Duff. Check gh auth status and that a release with a VSIX has been published.' >&2
  exit 1
fi

shopt -s nullglob
packages=("$temporary"/duff-*.vsix)
if [[ ${#packages[@]} -ne 1 ]]; then
  echo 'Expected exactly one Duff VSIX in the latest release; nothing was installed.' >&2
  exit 1
fi

echo "Installing ${packages[0]##*/} with ${editor}..."
"$editor" --install-extension "${packages[0]}" --force
echo 'Duff installed. In existing editor windows, run Developer: Reload Window.'
