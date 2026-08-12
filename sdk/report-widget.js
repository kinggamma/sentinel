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
 *   mountReportWidget();
 * -----------------------------------------------------------------------
 */

import { uploadIncidentBundle } from "./incident-capture.js";

const STYLE = `
  .incident-report-btn {
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    background: #d64545; color: #fff; border: none; border-radius: 999px;
    padding: 10px 16px; font: 14px/1.2 system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  .incident-report-panel {
    position: fixed; bottom: 68px; right: 20px; z-index: 999999;
    width: 300px; background: #fff; border-radius: 8px; padding: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,.3); font: 14px system-ui, sans-serif;
  }
  .incident-report-panel textarea {
    width: 100%; min-height: 70px; box-sizing: border-box; margin: 8px 0;
    font: inherit; padding: 6px;
  }
  .incident-report-panel button { font: inherit; padding: 6px 10px; }
  .incident-report-status { font-size: 12px; color: #555; margin-top: 6px; }
`;

export function mountReportWidget({ label = "Report Issue" } = {}) {
  if (document.getElementById("incident-report-btn")) return; // already mounted

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "incident-report-btn";
  btn.className = "incident-report-btn";
  btn.setAttribute("data-incident-capture-ignore", "true");
  btn.textContent = label;
  document.body.appendChild(btn);

  let panel = null;

  btn.addEventListener("click", () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = buildPanel();
    document.body.appendChild(panel);
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

    el.querySelector('[data-action="send"]').addEventListener("click", async () => {
      status.textContent = "Sending...";
      try {
        await uploadIncidentBundle({ note: textarea.value, source: "staff-report" });
        status.textContent = "Sent. Thanks!";
        setTimeout(() => {
          el.remove();
          panel = null;
        }, 1200);
      } catch (err) {
        status.textContent = `Failed to send: ${err.message}`;
      }
    });

    return el;
  }
}
