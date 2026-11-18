#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Linux
version=0.32.3
test "$(node -p 'require("./node_modules/node-datachannel/package.json").version')" = "$version"
target=node_modules/node-datachannel/build/Release/node_datachannel.node
work=$(mktemp -d)
cp -p "$target" "$work/host.node"
restore() {
  cp -p "$work/host.node" "$target"
  rm -rf "$work"
}
trap restore EXIT
archive="$work/native.tar.gz"
curl --fail --silent --show-error --location --max-time 120 \
  "https://github.com/murat-dogan/node-datachannel/releases/download/v$version/node-datachannel-v$version-napi-v8-darwin-arm64.tar.gz" \
  --output "$archive"
printf '%s  %s\n' 69fbffdacb9abda2a76809693443328b6aad71af25947e0733913340365f4da8 "$archive" | sha256sum -c
tar -xOf "$archive" build/Release/node_datachannel.node > "$target"
file "$target" | grep -E 'Mach-O.*arm64'
npm run build:mac
CSC_IDENTITY_AUTO_DISCOVERY=false npm exec -- electron-builder --mac --arm64 --dir --publish never
app="dist/mac-arm64/Pulse Mac.app"
file "$app/Contents/MacOS/Pulse Mac" | grep -E 'Mach-O.*arm64'
find "$app" \( -name '*.node' -o -name '*.bare' \) -print0 |
  while IFS= read -r -d '' native; do file "$native" | grep -E 'Mach-O.*arm64'; done
