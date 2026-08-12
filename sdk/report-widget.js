/**
 * report-widget.js
 * -----------------------------------------------------------------------
 * The "Report Issue" button any staff member can click to submit a note
 * (optionally with the auto-captured screenshot buffer attached) without
 * an error having fired. Depends on incident-capture.js already having
 * been initialized on the page (for the screenshot buffer + config).
 *
 * Usage (after initIncidentCapture(...) has run):
 *   import { mountReportWidget } from "./report-widget.js";
 *
 *   // Floating, default corner:
 *   mountReportWidget();
 *
 *   // Out of the way of an existing floating action button:
 *   mountReportWidget({ position: "bottom-left", offset: { x: 24, y: 88 } });
 *
 *   // Or drop it into a toolbar instead of floating at all:
 *   mountReportWidget({ container: "#admin-toolbar" });
 * -----------------------------------------------------------------------
 */

import { uploadIncidentBundle } from "./incident-capture.js";

/**
 * Anchors the button can snap to: four corners plus the midpoint of each
 * edge. Each is expressed as a fraction of the viewport so the snap survives
 * a window resize.
 */
const ANCHORS = {
  "top-left": { x: 0, y: 0 },
  "top-center": { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  "bottom-left": { x: 0, y: 1 },
  "bottom-center": { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

const POSITION_KEY = "incident-report-widget-position";

const STYLE = `
  .incident-report-root {
    --incident-accent: #d64545;
    --incident-offset-x: 20px;
    --incident-offset-y: 20px;
    font: 14px/1.2 system-ui, sans-serif;
  }
  .incident-report-btn {
    z-index: 999999;
    background: var(--incident-accent); color: #fff; border: none;
    border-radius: 999px; padding: 10px 16px; font: inherit; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  .incident-report-root[data-floating="true"] .incident-report-btn {
    position: fixed; touch-action: none; user-select: none;
    transition: left .12s ease, top .12s ease;
  }
  .incident-report-root[data-dragging="true"] .incident-report-btn {
    transition: none; cursor: grabbing; opacity: .9;
  }
  .incident-report-panel {
    z-index: 1000000; width: 300px; background: #fff; color: #1b1f24;
    border-radius: 8px; padding: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    font: 14px system-ui, sans-serif;
  }
  .incident-report-root[data-floating="true"] .incident-report-panel {
    position: fixed;
  }
  .incident-report-panel textarea {
    width: 100%; min-height: 70px; box-sizing: border-box; margin: 8px 0;
    font: inherit; padding: 6px;
  }
  .incident-report-panel button { font: inherit; padding: 6px 10px; }
  .incident-report-status { font-size: 12px; color: #555; margin-top: 6px; }
  .incident-report-status-warn {
    color: #8a5a00; background: #fff4e0; border-radius: 6px; padding: 6px 8px;
    line-height: 1.4;
  }
`;

function anchorName(name) {
  return ANCHORS[name] ? name : "bottom-right";
}

/** Pixel position of the button for a given anchor, respecting the offsets. */
function anchorRect(name, size, offset) {
  const anchor = ANCHORS[anchorName(name)];
  const maxLeft = window.innerWidth - size.width - offset.x;
  const maxTop = window.innerHeight - size.height - offset.y;
  return {
    left: Math.max(offset.x, offset.x + anchor.x * (maxLeft - offset.x)),
    top: Math.max(offset.y, offset.y + anchor.y * (maxTop - offset.y)),
  };
}

/** Which anchor is nearest to where the button was dropped. */
function nearestAnchor(centre) {
  let best = "bottom-right";
  let bestDistance = Infinity;
  for (const [name, anchor] of Object.entries(ANCHORS)) {
    const dx = centre.x - anchor.x * window.innerWidth;
    const dy = centre.y - anchor.y * window.innerHeight;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

function loadSavedPosition() {
  try {
    const saved = localStorage.getItem(POSITION_KEY);
    return saved && ANCHORS[saved] ? saved : null;
  } catch {
    return null; // storage disabled — fall back to the configured default
  }
}

function savePosition(name) {
  try {
    localStorage.setItem(POSITION_KEY, name);
  } catch {
    // Not worth failing a bug report over.
  }
}

/**
 * @param {object}   [options]
 * @param {string}   [options.label]      Button text.
 * @param {string}   [options.position]   Starting anchor: top/bottom × left/center/right.
 * @param {object}   [options.offset]     { x, y } margin from the viewport edge, in px.
 * @param {string}   [options.accent]     Button colour; defaults to the app's red.
 * @param {boolean}  [options.draggable]  Let staff drag the button to another
 *        anchor; the choice is remembered in that browser. Default true.
 * @param {string|Element} [options.container]
 *        Render inline inside this element (a toolbar, a menu) instead of
 *        floating over the page. Positioning options are ignored.
 */
export function mountReportWidget({
  label = "Report Issue",
  position = "bottom-right",
  offset = {},
  accent,
  draggable = true,
  container,
} = {}) {
  if (document.getElementById("incident-report-btn")) return; // already mounted

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const host =
    typeof container === "string" ? document.querySelector(container) : container || null;
  const floating = !host;

  const root = document.createElement("div");
  root.className = "incident-report-root";
  root.dataset.floating = String(floating);
  root.setAttribute("data-incident-capture-ignore", "true");
  if (accent) root.style.setProperty("--incident-accent", accent);
  if (offset.x != null) root.style.setProperty("--incident-offset-x", `${offset.x}px`);
  if (offset.y != null) root.style.setProperty("--incident-offset-y", `${offset.y}px`);

  const btn = document.createElement("button");
  btn.id = "incident-report-btn";
  btn.className = "incident-report-btn";
  btn.type = "button";
  btn.textContent = label;
  root.appendChild(btn);

  (host || document.body).appendChild(root);

  const margin = { x: offset.x ?? 20, y: offset.y ?? 20 };
  let anchor = anchorName(loadSavedPosition() || position);
  let panel = null;

  function place() {
    if (!floating) return;
    const size = { width: btn.offsetWidth, height: btn.offsetHeight };
    const { left, top } = anchorRect(anchor, size, margin);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.right = "auto";
    btn.style.bottom = "auto";
    if (panel) placePanel(size, { left, top });
  }

  function placePanel(size, buttonAt) {
    const gap = 8;
    const below = ANCHORS[anchor].y === 0;
    const panelWidth = panel.offsetWidth || 300;
    let left = buttonAt.left;
    // Keep the panel on screen when the button is snapped to a right edge.
    if (left + panelWidth > window.innerWidth - margin.x) {
      left = Math.max(margin.x, window.innerWidth - margin.x - panelWidth);
    }
    panel.style.left = `${left}px`;
    panel.style.top = below
      ? `${buttonAt.top + size.height + gap}px`
      : `${Math.max(margin.y, buttonAt.top - panel.offsetHeight - gap)}px`;
  }

  if (floating) {
    place();
    window.addEventListener("resize", place);
    if (draggable) enableDragging();
  }

  /**
   * Long-press (or click-and-hold) to pick the button up, drop it anywhere,
   * and it snaps to whichever anchor is nearest — corners or edge midpoints.
   * The click that opens the panel is suppressed if a drag actually happened.
   */
  function enableDragging() {
    let dragging = false;
    let moved = false;
    let holdTimer = null;
    let grabOffset = { x: 0, y: 0 };

    const start = (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = btn.getBoundingClientRect();
      grabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // A short hold distinguishes "move me" from "open the panel".
      holdTimer = setTimeout(() => {
        dragging = true;
        moved = false;
        btn.setPointerCapture?.(event.pointerId);
        root.dataset.dragging = "true";
        if (panel) {
          panel.remove();
          panel = null;
        }
      }, 250);
    };

    const move = (event) => {
      if (!dragging) return;
      moved = true;
      event.preventDefault();
      btn.style.left = `${event.clientX - grabOffset.x}px`;
      btn.style.top = `${event.clientY - grabOffset.y}px`;
    };

    const end = () => {
      clearTimeout(holdTimer);
      if (!dragging) return;
      dragging = false;
      root.dataset.dragging = "false";

      const rect = btn.getBoundingClientRect();
      anchor = nearestAnchor({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      savePosition(anchor);
      place();

      if (moved) {
        // Swallow the click that ends the drag.
        btn.addEventListener("click", (e) => e.stopImmediatePropagation(), {
          capture: true,
          once: true,
        });
      }
    };

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointermove", move);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
    btn.title = "Hold and drag to move this button";
  }

  btn.addEventListener("click", () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = buildPanel();
    root.appendChild(panel);
    if (floating) {
      const rect = btn.getBoundingClientRect();
      placePanel({ width: rect.width, height: rect.height }, { left: rect.left, top: rect.top });
    }
    panel.querySelector("textarea")?.focus();
  });

  function buildPanel() {
    const el = document.createElement("div");
    el.className = "incident-report-panel";
    el.setAttribute("data-incident-capture-ignore", "true");
    el.innerHTML = `
      <strong>What went wrong?</strong>
      <textarea placeholder="Describe what you were doing and what happened..."></textarea>
      <div>
        <button type="button" data-action="send">Send report</button>
        <button type="button" data-action="cancel">Cancel</button>
      </div>
      <div class="incident-report-status"></div>
    `;

    const textarea = el.querySelector("textarea");
    const status = el.querySelector(".incident-report-status");

    el.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      el.remove();
      panel = null;
    });

    el.querySelector('[data-action="send"]').addEventListener("click", async (event) => {
      const send = event.currentTarget;
      send.disabled = true;
      status.className = "incident-report-status";
      status.textContent = "Sending...";
      try {
        await uploadIncidentBundle({ note: textarea.value, source: "staff-report" });
        status.textContent = "Sent. Thanks!";
        setTimeout(() => {
          el.remove();
          panel = null;
        }, 1200);
      } catch (err) {
        // A pipeline that's down or misconfigured is an operations problem,
        // not something to shout a stack trace about at whoever hit a bug.
        send.disabled = false;
        status.className = "incident-report-status incident-report-status-warn";
        status.textContent = err?.userFacing
          ? `${err.message} Your note wasn't lost — copy it somewhere before closing this.`
          : "Couldn't send this report just now. Try again in a moment.";
      }
    });

    return el;
  }
}
