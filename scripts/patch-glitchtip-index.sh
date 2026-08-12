#!/usr/bin/env bash
#
# Add a "Sentinel" link to GlitchTip's UI.
#
# GlitchTip ships as a prebuilt image, so the link is added by mounting a
# patched copy of its SPA shell (/code/dist/index.html) over the original.
# That shell references hash-named JS bundles, which means a patched copy
# goes stale the moment GlitchTip is upgraded: the mount would serve an old
# shell pointing at bundles the new image doesn't have, and GlitchTip would
# fail to load. So:
#
#   ./scripts/patch-glitchtip-index.sh          regenerate from the current image
#   ./scripts/patch-glitchtip-index.sh --check  is the copy still in step?
#
# Re-run it after every `docker compose pull`. `--check` is the cheap way to
# find out you need to, and exits non-zero when you do.
#
# The shell is a Django template, so the injected markup uses {{ csp_nonce }}
# to satisfy GlitchTip's CSP (style-src has no 'unsafe-inline').
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="glitchtip/index.html"
SRC_PATH="/code/dist/index.html"
MODE="${1:-patch}"

# Where staff reach Sentinel. Baked in at patch time, since GlitchTip renders
# this template and knows nothing about our environment.
SENTINEL_URL="$(grep -E '^SENTINEL_URL=' .env 2>/dev/null | cut -d= -f2- || true)"
: "${SENTINEL_URL:=http://localhost:4000}"

# `docker compose config --images <service>` ignores the service filter on
# some versions and lists the whole stack, so pick ours out by name rather
# than by position.
IMAGE="$(docker compose config --images 2>/dev/null | grep -i glitchtip | head -1)"
: "${IMAGE:=glitchtip/glitchtip:latest}"

# Read the shell out of the image, never out of the mount — otherwise each
# run would patch its own output.
TMP_SRC="$(mktemp)"
trap 'rm -f "$TMP_SRC"' EXIT
docker run --rm --entrypoint cat "$IMAGE" "$SRC_PATH" >"$TMP_SRC"
if [ ! -s "$TMP_SRC" ]; then
  echo "Could not read $SRC_PATH out of $IMAGE." >&2
  exit 1
fi

SOURCE_HASH="$(shasum -a 256 <"$TMP_SRC" | cut -d' ' -f1)"

if [ "$MODE" = "--check" ]; then
  if [ ! -f "$OUT" ]; then
    echo "No $OUT yet — run $0 to create it." >&2
    exit 1
  fi
  RECORDED="$(grep -o 'sentinel-patched-from:[0-9a-f]\{64\}' "$OUT" | head -1 | cut -d: -f2 || true)"
  if [ "$RECORDED" = "$SOURCE_HASH" ]; then
    echo "$OUT matches the current GlitchTip image."
    exit 0
  fi
  echo "STALE: $OUT was patched from a different GlitchTip build." >&2
  echo "GlitchTip will fail to load until you re-run: $0" >&2
  exit 1
fi

mkdir -p glitchtip
SENTINEL_URL="$SENTINEL_URL" SOURCE_HASH="$SOURCE_HASH" python3 - "$OUT" "$TMP_SRC" <<'PY'
import html, os, sys

out_path, src_path = sys.argv[1], sys.argv[2]
url = os.environ["SENTINEL_URL"].rstrip("/")
source_hash = os.environ["SOURCE_HASH"]

with open(src_path) as f:
    source = f.read()

if "</body>" not in source:
    sys.exit("GlitchTip's index.html has no </body> — its layout changed; update this script.")

# A single small pill, bottom-right, out of the way of GlitchTip's own UI.
# Themed off the .dark/.light class GlitchTip already puts on <html>.
snippet = """
    <!-- sentinel-link-start sentinel-patched-from:%(hash)s -->
    <style nonce="{{ csp_nonce }}">
      .sentinel-link {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483000;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid rgba(0, 0, 0, 0.12);
        background: #ffffff;
        color: #1f2933;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        text-decoration: none;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
      }
      .sentinel-link:hover {
        border-color: rgba(0, 0, 0, 0.28);
      }
      html.dark .sentinel-link {
        background: #1f1f1f;
        color: rgba(255, 255, 255, 0.88);
        border-color: rgba(255, 255, 255, 0.18);
      }
      html.dark .sentinel-link:hover {
        border-color: rgba(255, 255, 255, 0.38);
      }
      @media print {
        .sentinel-link { display: none; }
      }
    </style>
    <a class="sentinel-link" href="%(url)s" rel="noreferrer noopener">
      Bug reports in Sentinel &#8599;
    </a>
    <!-- sentinel-link-end -->
""" % {"hash": source_hash, "url": html.escape(url, quote=True)}

patched = source.replace("</body>", snippet + "  </body>", 1)
with open(out_path, "w") as f:
    f.write(patched)
print("wrote %s -> %s" % (out_path, url))
PY

echo "docker-compose.yml mounts it over GlitchTip's shell; restart glitchtip-web to pick it up."
echo "Re-run after every GlitchTip upgrade (./scripts/patch-glitchtip-index.sh --check tells you)."
