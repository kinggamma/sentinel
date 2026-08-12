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

# The link belongs in the sidebar, where people actually look — a corner
# pill goes unnoticed. GlitchTip's sidebar is an Angular Material
# <mat-nav-list> built at runtime, so we can't write the markup for it:
# the classes are Angular's and change between builds. Instead we clone an
# item that's already there and retarget the copy, which inherits whatever
# styling that build uses.
#
# Angular renders after this script runs and re-renders on navigation, so a
# MutationObserver puts the item back whenever it goes missing. If no nav
# ever appears — a logged-out page, or a build that restructured the
# sidebar — a corner pill is shown instead, so the link is never simply
# absent.
snippet = """
    <!-- sentinel-link-start sentinel-patched-from:%(hash)s -->
    <style nonce="{{ csp_nonce }}">
      .sentinel-pill {
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
      html.dark .sentinel-pill {
        background: #1f1f1f;
        color: rgba(255, 255, 255, 0.88);
        border-color: rgba(255, 255, 255, 0.18);
      }
      @media print {
        .sentinel-pill { display: none; }
      }
    </style>
    <script nonce="{{ csp_nonce }}">
      (function () {
        var URL_ = "%(url)s";
        var LABEL = "Sentinel";
        var ICON = "bug_report";

        /* Three ways to find the sidebar, cheapest first. The last one asks
           "where does GlitchTip's own Issues link live?" and uses whatever
           contains it, which survives the nav being renamed or restructured
           in a future build. */
        function navList() {
          var byTag = document.querySelector("mat-nav-list, .mat-mdc-nav-list");
          if (byTag) return byTag;

          var links = document.querySelectorAll('a[href*="/issues"]');
          for (var i = 0; i < links.length; i++) {
            var parent = links[i].parentElement;
            /* A nav, not a link in page content: it should hold siblings. */
            if (parent && parent.querySelectorAll("a").length > 1) return parent;
          }
          return null;
        }

        /* Clone a sibling so the copy carries this build's own classes.
           Nav items are <button mat-list-item> in current GlitchTip, not
           links — it navigates by router, not href — so match both and give
           a cloned button its own click handler, since cloneNode copies no
           listeners. */
        function addToNav(nav) {
          if (nav.querySelector("[data-sentinel-link]")) return true;

          /* The nav is divider, main items, divider, then the account
             section. Sit with the main items and copy one of those, rather
             than an account entry with its expand arrow. */
          var dividers = nav.querySelectorAll("mat-divider, .mat-divider");
          var before = dividers.length > 1 ? dividers[dividers.length - 1] : null;

          var candidates = nav.querySelectorAll("a, button");
          var source = null;
          for (var i = 0; i < candidates.length; i++) {
            if (!before) { source = candidates[i]; continue; }
            var isBefore =
              candidates[i].compareDocumentPosition(before) &
              Node.DOCUMENT_POSITION_FOLLOWING;
            if (isBefore) source = candidates[i];
          }
          if (!source) return false;

          var clone = source.cloneNode(true);
          clone.setAttribute("data-sentinel-link", "");
          /* Whatever marked the copied item as the current page. */
          clone.removeAttribute("aria-current");
          clone.classList.remove("mdc-list-item--activated", "active", "is-active");

          if (clone.tagName === "A") {
            clone.setAttribute("href", URL_);
            clone.removeAttribute("target");
          } else {
            clone.setAttribute("type", "button");
            clone.addEventListener("click", function (event) {
              event.preventDefault();
              event.stopPropagation();
              window.location.assign(URL_);
            });
          }

          var icon = clone.querySelector("mat-icon, .mat-icon, .material-symbols-outlined");
          if (icon) icon.textContent = ICON;

          /* .nav-text is GlitchTip's own label span — it hides it when the
             sidebar is collapsed, so using it keeps that behaviour. */
          var text =
            clone.querySelector(".nav-text") ||
            clone.querySelector(".mdc-list-item__primary-text");
          if (text) {
            text.textContent = LABEL;
          } else {
            var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
            var node, last = null;
            while ((node = walker.nextNode())) {
              if (node.nodeValue.trim() && (!icon || !icon.contains(node))) last = node;
            }
            if (last) last.nodeValue = LABEL;
            else clone.appendChild(document.createTextNode(LABEL));
          }

          if (before) nav.insertBefore(clone, before);
          else nav.appendChild(clone);
          return true;
        }

        function pill() {
          if (document.querySelector(".sentinel-pill")) return;
          var a = document.createElement("a");
          a.className = "sentinel-pill";
          a.href = URL_;
          a.textContent = "Bug reports in Sentinel \\u2197";
          document.body.appendChild(a);
        }

        var placed = false;
        function attempt() {
          var nav = navList();
          if (nav && addToNav(nav)) {
            placed = true;
            var stale = document.querySelector(".sentinel-pill");
            if (stale) stale.remove();
          }
        }

        function start() {
          attempt();
          new MutationObserver(attempt).observe(document.body, {
            childList: true,
            subtree: true,
          });
          /* Nothing nav-shaped turned up; fall back so the link still exists. */
          setTimeout(function () { if (!placed) pill(); }, 8000);
        }

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", start);
        } else {
          start();
        }
      })();
    </script>
    <!-- sentinel-link-end -->
""" % {"hash": source_hash, "url": html.escape(url, quote=True)}

patched = source.replace("</body>", snippet + "  </body>", 1)
with open(out_path, "w") as f:
    f.write(patched)
print("wrote %s -> %s" % (out_path, url))
PY

# Django parses the shell once and keeps it, so editing the file changes
# nothing until the process restarts — and `compose up -d` won't restart a
# service whose configuration hasn't changed. Do it here rather than leave a
# re-patch looking like it silently failed.
if docker compose ps --status running --services 2>/dev/null | grep -qx glitchtip-web; then
  echo "restarting glitchtip-web so it re-reads the shell..."
  docker compose restart glitchtip-web >/dev/null
  echo "done."
else
  echo "glitchtip-web isn't running; it'll pick this up on the next start."
fi

echo "Re-run after every GlitchTip upgrade (./scripts/patch-glitchtip-index.sh --check tells you)."
