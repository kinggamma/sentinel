/**
 * incident-capture.js
 * -----------------------------------------------------------------------
 * Shared client-side module for the error monitoring / bug reporting
 * pipeline. Drop this into any JS app (React, plain HTML, Moodle theme,
 * etc.) as an ES module. Wires up:
 *   1. GlitchTip error + breadcrumb reporting (via @sentry/browser, which
 *      speaks GlitchTip's Sentry-compatible protocol).
 *   2. A rolling in-memory session replay (rrweb), uploaded to the
 *      feedback receiver only when an error actually fires or a staff
 *      member files a report.
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

/**
 * Rolling session-replay buffer defaults.
 *
 * The buffer is what makes a report useful: by the time someone notices a
 * problem and clicks "Report Issue", the thing that went wrong is already
 * seconds in the past. So the page is recorded continuously and the last
 * `bufferSeconds` are kept in memory — nothing leaves the browser until an
 * error fires or a staff member actually files a report.
 *
 * This records DOM mutations (rrweb), not images: a minute of replay is
 * typically tens of KB rather than megabytes of screenshots, scrubs to the
 * exact moment instead of landing between frames, and costs a fraction of
 * the CPU.
 *
 * Override per app via initIncidentCapture({ capture: { ... } }).
 */
const CAPTURE_DEFAULTS = {
  minSeconds: 5, // always keep at least this much, when it exists
  maxSeconds: 30, // never keep more than this
  carryAcrossPages: true, // stitch in the tail of the previous page
  maskAllInputs: true, // never record what anyone types
  maskAllText: false, // set true on text-sensitive apps: masks every string
  maskTextSelector: null, // or mask just these elements
};

/** Where the tail of the previous page waits during a navigation. */
const CARRY_KEY = "incident-capture-carry";

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

/**
 * Anything wrong between an app and the pipeline — unreachable host, wrong
 * address in .env, bad token, service down. Carries a message meant to be
 * shown to whoever is filing the report, not a stack trace.
 */
export class PipelineUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PipelineUnreachableError";
    this.userFacing = true;
  }
}

/** "localhost:4000" — enough to debug a misconfigured .env, no credentials. */
function describeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "an unconfigured address");
  }
}

function pathIsExcluded(excludedPaths) {
  const path = window.location.pathname + window.location.search;
  return excludedPaths.some((re) => re.test(path));
}

let config = null;
let stopRecorder = null;

/**
 * Rolling replay buffer.
 *
 * rrweb emits a full DOM snapshot on "checkout", then a stream of mutations
 * against it. A replay is only playable from a snapshot onward, so we keep
 * events in per-checkout chunks and hold the last two: at any moment that's
 * between one and two checkout intervals of history, always starting from a
 * valid snapshot. Nothing leaves the browser until a report is filed.
 */
let chunks = [[]];

/**
 * A full page load destroys the recorder, so on a multi-page app (Moodle)
 * a report filed just after navigating would only ever see a second or two.
 * The tail of the previous page is handed forward through sessionStorage and
 * replayed ahead of this page's own events — so you see the click that
 * navigated, not just the aftermath.
 */
let carriedChunks = [];

function captureSettings() {
  const merged = { ...CAPTURE_DEFAULTS, ...(config?.capture || {}) };

  // `bufferSeconds` was the old single knob; honour it as the maximum.
  if (merged.bufferSeconds && !config?.capture?.maxSeconds) {
    merged.maxSeconds = merged.bufferSeconds;
  }

  merged.maxSeconds = Math.max(1, Number(merged.maxSeconds) || CAPTURE_DEFAULTS.maxSeconds);
  merged.minSeconds = Math.max(1, Number(merged.minSeconds) || CAPTURE_DEFAULTS.minSeconds);
  if (merged.minSeconds > merged.maxSeconds) merged.minSeconds = merged.maxSeconds;

  // Retained history runs from one checkout interval to two, so an interval
  // of min…max/2 keeps the window inside the configured bounds.
  merged.checkoutMs = Math.max(
    merged.minSeconds * 1000,
    Math.min(merged.maxSeconds * 1000 / 2, merged.maxSeconds * 1000)
  );
  return merged;
}

/**
 * Everything currently replayable: the tail carried over from the page the
 * user came from, then this page's own buffer, trimmed to maxSeconds.
 *
 * Trimming happens on a chunk boundary because a replay can only start at a
 * full snapshot — cutting mid-chunk would produce an unplayable stream.
 */
function bufferedEvents() {
  const { maxSeconds } = captureSettings();
  const cutoff = Date.now() - maxSeconds * 1000;

  const groups = [...carriedChunks, ...chunks].filter((group) => group.length);
  // Drop whole leading chunks that are entirely older than the window, but
  // never drop the last one — that's the only one with recent history.
  while (groups.length > 1 && groups[0][groups[0].length - 1].timestamp < cutoff) {
    groups.shift();
  }
  return groups.flat();
}

/** Stash the tail so the next page can stitch it onto the front of its own. */
function persistCarry() {
  const settings = captureSettings();
  if (!settings.carryAcrossPages) return;
  try {
    const events = bufferedEvents();
    if (!events.length) return;
    sessionStorage.setItem(
      CARRY_KEY,
      JSON.stringify({ savedAt: Date.now(), chunks: [...carriedChunks, ...chunks].filter((c) => c.length) })
    );
  } catch {
    // Quota or disabled storage: the replay just starts at this page.
  }
}

function restoreCarry() {
  const settings = captureSettings();
  if (!settings.carryAcrossPages) return;
  try {
    const raw = sessionStorage.getItem(CARRY_KEY);
    sessionStorage.removeItem(CARRY_KEY);
    if (!raw) return;

    const { savedAt, chunks: saved } = JSON.parse(raw);
    // A tab left open for an hour shouldn't replay an hour-old page.
    if (!Array.isArray(saved) || Date.now() - savedAt > settings.maxSeconds * 1000) return;
    carriedChunks = saved.filter((group) => Array.isArray(group) && group.length);
  } catch {
    carriedChunks = [];
  }
}

async function startReplayBuffer() {
  if (stopRecorder) return;

  const settings = captureSettings();
  restoreCarry();

  const { record } = await import("rrweb");

  stopRecorder = record({
    emit(event, isCheckout) {
      if (isCheckout) {
        chunks.push([]);
        // Two chunks is the smallest window that always contains a snapshot.
        while (chunks.length > 2) chunks.shift();
      }
      chunks[chunks.length - 1].push(event);
    },
    checkoutEveryNms: settings.checkoutMs,
    // Privacy defaults: never record what people type. Anything marked
    // data-incident-capture-ignore is dropped from the recording entirely,
    // which also covers our own report widget.
    maskAllInputs: settings.maskAllInputs,
    maskTextSelector: settings.maskAllText ? "*" : settings.maskTextSelector || undefined,
    blockSelector: "[data-incident-capture-ignore]",
    recordCanvas: false,
    collectFonts: false,
    sampling: {
      // Mouse moves are the bulk of the payload and add little for debugging.
      mousemove: 100,
      scroll: 150,
      input: "last",
    },
  });
}

function stopReplayBuffer() {
  if (stopRecorder) stopRecorder();
  stopRecorder = null;
  chunks = [[]];
  carriedChunks = [];
}

/**
 * Gather breadcrumbs from every scope layer.
 *
 * Sentry v8+ records automatic breadcrumbs (clicks, navigation, fetch,
 * console) on the *isolation* scope, not the current one — reading only
 * getCurrentScope() gives an empty list on almost every report.
 */
function collectBreadcrumbs() {
  const layers = [
    Sentry.getGlobalScope?.(),
    Sentry.getIsolationScope?.(),
    Sentry.getCurrentScope?.(),
  ];

  const all = layers.flatMap((scope) => scope?.getScopeData?.().breadcrumbs || []);

  // Same breadcrumb can appear on more than one layer; de-dupe, then put
  // them back in the order they actually happened.
  const seen = new Set();
  return all
    .filter((crumb) => {
      const key = `${crumb.timestamp}|${crumb.category}|${crumb.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Upload the buffered replay + a breadcrumb snapshot to the feedback/incident
 * receiver, linked to a GlitchTip event id. Used both for automatic errors
 * and manual "Report Issue" submissions.
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

  form.append("breadcrumbs", JSON.stringify(deepScrub(collectBreadcrumbs())));

  const events = bufferedEvents();
  if (events.length) {
    const blob = new Blob([JSON.stringify(events)], { type: "application/json" });
    form.append("replay", blob, "replay.json");
    form.append(
      "replayMeta",
      JSON.stringify({
        startedAt: events[0]?.timestamp ?? null,
        endedAt: events[events.length - 1]?.timestamp ?? null,
        eventCount: events.length,
      })
    );
  }

  let res;
  try {
    res = await fetch(`${config.receiverUrl}/reports`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.staffToken}` },
      body: form,
    });
  } catch {
    // DNS failure, wrong host in .env, service down, no network. None of
    // these are the reporter's fault and none should surface as a stack
    // trace — say plainly that the pipeline can't be reached.
    throw new PipelineUnreachableError(
      `Can't reach the reporting service at ${describeHost(config.receiverUrl)}. ` +
        `It may be offline, or this app may be pointed at the wrong address.`
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new PipelineUnreachableError(
      "The reporting service rejected this app's token. Check that the app and the pipeline share the same STAFF_API_TOKEN."
    );
  }
  if (res.status === 413) {
    throw new PipelineUnreachableError("That report was too large for the reporting service to accept.");
  }
  if (!res.ok) {
    throw new PipelineUnreachableError(
      `The reporting service couldn't save this report (error ${res.status}).`
    );
  }
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

  void startReplayBuffer();

  // On every unhandled error/rejection Sentry reports, also ship the
  // buffered replay to the feedback receiver, linked by event id.
  Sentry.getCurrentScope?.().addEventProcessor?.((event) => {
    if (event.event_id) {
      uploadIncidentBundle({
        source: "auto-error",
        glitchtipEventId: event.event_id,
      }).catch(() => {});
    }
    return event;
  });

  // pagehide fires on bfcache navigations where beforeunload doesn't, and is
  // the last reliable chance to hand the buffer to the next page.
  window.addEventListener("pagehide", persistCarry);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCarry();
  });

  return { excluded: false };
}

export { pathIsExcluded, deepScrub };
