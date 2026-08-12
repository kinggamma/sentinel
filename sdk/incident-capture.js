/**
 * incident-capture.js
 * -----------------------------------------------------------------------
 * Shared client-side module for the error monitoring / bug reporting
 * pipeline. Drop this into any JS app (React, plain HTML, Moodle theme,
 * etc.) as an ES module. Wires up:
 *   1. GlitchTip error + breadcrumb reporting (via @sentry/browser, which
 *      speaks GlitchTip's Sentry-compatible protocol).
 *   2. A rolling in-memory screenshot buffer, uploaded to the feedback
 *      receiver only when an error actually fires.
 *   3. PII scrubbing on every event before it leaves the browser.
 *   4. Page exclusion — nothing is captured at all on configured paths
 *      (gradebook, profile, etc).
 *
 * This module does NOT gate itself to staff — call init() only from
 * server-rendered pages that already know the current user is
 * staff/admin. That's the real access-control boundary; this file
 * assumes it has already been decided that capture is allowed.
 *
 * Usage:
 *   import { initIncidentCapture } from "./incident-capture.js";
 *
 *   initIncidentCapture({
 *     dsn: "http://<key>@localhost:8000/<project-id>", // or http://<server-ip>:8000/<project-id>
 *     receiverUrl: "http://localhost:4000/api",         // or http://<server-ip>:4000/api
 *     staffToken: "<per-app shared token, injected server-side>",
 *     appName: "moodle-lms",
 *     userEmail: currentUser.email,           // used for "reported by", not sent to GlitchTip
 *     excludedPaths: [/\/grade\//i, /\/user\/profile/i, /\/user\/edit/i],
 *   });
 * -----------------------------------------------------------------------
 */

import * as Sentry from "@sentry/browser";

const RING_BUFFER_SIZE = 4; // keep last N frames, ~1 every 2s => ~8s of context
const CAPTURE_INTERVAL_MS = 2000;

const PII_PATTERNS = [
  { name: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { name: "phone", re: /(\+?\d[\d\s().-]{7,}\d)/g },
  { name: "ssn-like", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit-card-like", re: /\b(?:\d[ -]*?){13,16}\b/g },
];

function scrubString(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const { re } of PII_PATTERNS) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

function deepScrub(obj, seen = new WeakSet()) {
  if (obj == null) return obj;
  if (typeof obj === "string") return scrubString(obj);
  if (typeof obj !== "object") return obj;
  if (seen.has(obj)) return obj;
  seen.add(obj);

  if (Array.isArray(obj)) return obj.map((v) => deepScrub(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = deepScrub(v, seen);
  }
  return out;
}

function pathIsExcluded(excludedPaths) {
  const path = window.location.pathname + window.location.search;
  return excludedPaths.some((re) => re.test(path));
}

let config = null;
let ringBuffer = []; // [{ dataUrl, timestamp }]
let captureTimer = null;
let html2canvasPromise = null;

async function loadHtml2Canvas() {
  if (!html2canvasPromise) {
    html2canvasPromise = import("html2canvas").then((m) => m.default || m);
  }
  return html2canvasPromise;
}

async function captureFrame() {
  try {
    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(document.body, {
      logging: false,
      // Downscale aggressively — this is "a few seconds of visual context",
      // not a pixel-perfect record.
      scale: 0.5,
      ignoreElements: (el) => el.hasAttribute?.("data-incident-capture-ignore"),
    });
    const dataUrl = canvas.toDataURL("image/jpeg", 0.5);
    ringBuffer.push({ dataUrl, timestamp: Date.now() });
    if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();
  } catch {
    // Screenshot capture is best-effort; never let it break the app.
  }
}

function startScreenshotBuffer() {
  if (captureTimer) return;
  captureTimer = setInterval(captureFrame, CAPTURE_INTERVAL_MS);
}

function stopScreenshotBuffer() {
  clearInterval(captureTimer);
  captureTimer = null;
  ringBuffer = [];
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*);base64/)[1];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Upload the current screenshot buffer + a breadcrumb snapshot to the
 * feedback/incident receiver, linked to a GlitchTip event id.
 * Used both for automatic errors and manual "Report Issue" submissions.
 */
export async function uploadIncidentBundle({ note, glitchtipEventId, source }) {
  if (!config) throw new Error("incident-capture: init() not called");

  const form = new FormData();
  form.append("appName", config.appName);
  form.append("url", window.location.href);
  form.append("note", note || "");
  form.append("reporterEmail", config.userEmail || "");
  form.append("source", source);
  if (glitchtipEventId) form.append("glitchtipEventId", glitchtipEventId);

  const breadcrumbs = Sentry.getCurrentScope?.().getScopeData?.().breadcrumbs || [];
  form.append("breadcrumbs", JSON.stringify(deepScrub(breadcrumbs)));

  ringBuffer.forEach(({ dataUrl }, i) => {
    form.append("screenshots", dataUrlToBlob(dataUrl), `frame-${i}.jpg`);
  });

  const res = await fetch(`${config.receiverUrl}/reports`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.staffToken}` },
    body: form,
  });

  if (!res.ok) throw new Error(`receiver responded ${res.status}`);
  return res.json();
}

export function initIncidentCapture(userConfig) {
  config = userConfig;

  if (pathIsExcluded(config.excludedPaths || [])) {
    // Sensitive page (gradebook, profile, etc). Capture nothing at all.
    return { excluded: true };
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment || "production",
    release: config.release,
    // Cap breadcrumb volume so old ones roll off — matches the "few
    // seconds/actions of context" goal rather than a full session log.
    maxBreadcrumbs: 40,
    beforeBreadcrumb(breadcrumb) {
      return deepScrub(breadcrumb);
    },
    beforeSend(event) {
      const scrubbed = deepScrub(event);
      // Tag consistently so the GlitchTip dashboard can filter by app/user/course.
      scrubbed.tags = {
        ...scrubbed.tags,
        app: config.appName,
        ...(config.extraTags || {}),
      };
      return scrubbed;
    },
  });

  Sentry.setUser(config.userEmail ? { email: config.userEmail } : null);

  startScreenshotBuffer();

  // On every unhandled error/rejection Sentry reports, also ship the
  // current screenshot buffer to the feedback receiver, linked by event id.
  Sentry.getCurrentScope?.().addEventProcessor?.((event) => {
    if (event.event_id) {
      uploadIncidentBundle({
        source: "auto-error",
        glitchtipEventId: event.event_id,
      }).catch(() => {});
    }
    return event;
  });

  window.addEventListener("beforeunload", stopScreenshotBuffer);

  return { excluded: false };
}

export { pathIsExcluded, deepScrub };
