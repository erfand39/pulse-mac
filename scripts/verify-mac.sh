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
# Electron Builder intentionally skips signing untrusted pull-request builds.
# Enforce strict signature verification for all other builds (push, release, local).
if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
  echo "Pull request build: code signing intentionally skipped; checking architecture and artifacts."
else
  codesign --verify --deep --strict "$app"
fi
test -s "dist/Pulse-Mac-$version-arm64.dmg"
test -s "dist/Pulse-Mac-$version-arm64.zip"
hdiutil verify "dist/Pulse-Mac-$version-arm64.dmg"
