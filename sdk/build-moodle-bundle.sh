#!/usr/bin/env bash
# Build the single-file browser bundle the Moodle plugin loads.
#
# The SDK imports "@sentry/browser" and "html2canvas" as bare specifiers,
# which a browser can't resolve on its own — and Moodle has no bundler in
# the request path. So we pre-bundle everything into one ES module and
# drop it into the plugin's js/ directory.
#
# Usage:
#   ./sdk/build-moodle-bundle.sh <destination-dir>
#
# The bundle is written to <destination-dir>/js/incident-capture-init.js —
# point it at your Moodle plugin directory, or at any server-rendered app's
# static assets directory.
#
# Re-run this whenever sdk/*.js or moodle/incident-capture-init.js changes.
set -euo pipefail

DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  echo "usage: $0 <destination-dir>" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/src"
cp "$REPO/sdk/incident-capture.js" "$REPO/sdk/report-widget.js" "$WORK/src/"
cp "$REPO/moodle/incident-capture-init.js" "$WORK/src/"

cd "$WORK"
npm init -y >/dev/null
npm install --silent @sentry/browser rrweb esbuild >/dev/null

npx esbuild src/incident-capture-init.js \
  --bundle --format=esm --minify --target=es2020 \
  --outfile=out.js

mkdir -p "$DEST/js"
cp out.js "$DEST/js/incident-capture-init.js"
echo "built -> $DEST/js/incident-capture-init.js"
