#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
app="dist/mac-arm64/Pulse Mac.app"
test -d "$app"
exe="$app/Contents/MacOS/Pulse Mac"
file "$exe"
test "$(lipo -archs "$exe")" = arm64
find "$app" -name '*.node' -print0 | while IFS= read -r -d '' module; do
  lipo -verify_arch arm64 "$module"
done
version=$(node -p 'require("./package.json").version')
test -s "dist/Pulse-Mac-$version-arm64.dmg"
test -s "dist/Pulse-Mac-$version-arm64.zip"
hdiutil verify "dist/Pulse-Mac-$version-arm64.dmg"
