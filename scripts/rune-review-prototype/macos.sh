#!/usr/bin/env bash
# Build a local source-backed app, with native LaunchServices identity and no shell launcher.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'Duff.app requires macOS.' >&2; exit 1; }
prototype="$(dirname "$(realpath "$0")")"
app="${DUFF_APP_PATH:-$prototype/dist/Duff.app}"
[[ "$app" == /* && "$app" == *.app ]] || { echo 'DUFF_APP_PATH must be an absolute .app path.' >&2; exit 1; }
if [[ -e "$app" ]]; then
    [[ -f "$app/Contents/Resources/duff-source-root" && "$(cat "$app/Contents/Resources/duff-source-root")" == "$prototype" ]] || {
        echo 'Refusing to replace an app not built from this Duff checkout.' >&2; exit 1;
    }
fi
export DUFF_NODE="$(command -v "${DUFF_NODE:-node}")"
export DUFF_BRIDGE="${DUFF_BRIDGE:-$prototype/bridge/dist/bridge.mjs}"
[[ -f "$DUFF_BRIDGE" ]] || { echo 'Build the bridge with run.sh before packaging Duff.app.' >&2; exit 1; }
bash "$prototype/native.sh" build --locked --target-dir "$prototype/target"
mkdir -p "$(dirname "$app")"
temporary="$(mktemp -d "$(dirname "$app")/.duff-app.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
bundle="$temporary/Duff.app"
resources="$bundle/Contents/Resources"
mkdir -p "$bundle/Contents/MacOS" "$resources" "$temporary/Duff.iconset"
cp "$prototype/target/debug/duff-rune-prototype" "$bundle/Contents/MacOS/Duff"
cp "$prototype/assets/Info.plist" "$bundle/Contents/Info.plist"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$prototype/assets/duff.png" --out "$temporary/Duff.iconset/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "$retina" "$retina" "$prototype/assets/duff.png" --out "$temporary/Duff.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$temporary/Duff.iconset" -o "$resources/Duff.icns"
"$DUFF_NODE" --input-type=module - "$resources/launch.json" <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
    node: process.env.DUFF_NODE,
    bridge: process.env.DUFF_BRIDGE,
    path: process.env.PATH,
    data: process.env.DUFF_STANDALONE_DATA || undefined,
    repository: process.env.DUFF_REPOSITORY || undefined,
}), { mode: 0o600 });
JS
printf '%s\n' "$prototype" > "$resources/duff-source-root"
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
if [[ -e "$app" ]]; then mv "$app" "$temporary/previous.app"; fi
if ! mv "$bundle" "$app"; then
    if [[ -d "$temporary/previous.app" ]]; then mv "$temporary/previous.app" "$app"; fi
    exit 1
fi
printf 'Duff.app ready: %s\n' "$app"
