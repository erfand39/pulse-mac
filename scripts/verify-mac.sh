#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
app="dist/mac-arm64/Pulse Mac.app"
test -d "$app"
exe="$app/Contents/MacOS/Pulse Mac"
file "$exe"
test "$(lipo -archs "$exe")" = arm64
find "$app" \( -name '*.node' -o -name '*.bare' \) -print0 | while IFS= read -r -d '' module; do
  lipo "$module" -verify_arch arm64
done
version=$(node -p 'require("./package.json").version')
codesign --verify --deep --strict "$app"
test -s "dist/Pulse-Mac-$version-arm64.dmg"
test -s "dist/Pulse-Mac-$version-arm64.zip"
hdiutil verify "dist/Pulse-Mac-$version-arm64.dmg"
