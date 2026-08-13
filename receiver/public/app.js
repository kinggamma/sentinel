/**
 * Sentinel viewer.
 *
 * Two ways in, matching the receiver's two ways of authenticating:
 *
 *   standalone — you sign in on this page, which sets an httpOnly session
 *                cookie. The credential is a personal GlitchTip auth token,
 *                so access is granted by inviting someone to the GlitchTip
 *                organisation and revoked by removing them. A setup with no
 *                GlitchTip can use the shared staff token instead.
 *   embedded    — inside an app's own admin area via
 *                <iframe src="?app=<name>&embed=1">. The host page already
 *                holds the shared staff token and hands it over by
 *                postMessage, so we send it as a bearer header and the view
 *                is locked to that one app.
 *
 * No credential is ever written to localStorage: standalone has the cookie,
 * embedded gets a fresh token from its host on every load.
 */

import { initIssues, showIssues } from "./issues.js";
import { route, start as startRouter, go as goRoute, refresh as refreshRoute, href as routeHref } from "./lib/router.js";
import { requestsView } from "./views/requests.js";
import { settingsView } from "./views/settings.js";
import { projectsView } from "./views/projects.js";

/** Left over from when the viewer kept a bearer token here. Clear it out. */
try {
  localStorage.removeItem("incident-viewer-token");
} catch {
  // Storage disabled; nothing to clean up.
}

const params = new URLSearchParams(location.search);
const scopedApp = params.get("app") || "";
const embedded = params.get("embed") === "1" || window.parent !== window;

/**
 * Which of the two roots this page was served from.
 *
 * Read from the meta tag src/index.js's renderShell() wrote into this same
 * page, not recomputed from location.pathname — that was two copies of the
 * same rule (this file's and the server's), which is how they'd eventually
 * drift. The server already had to decide this to pick the right <base>;
 * the meta tag is that decision, made once and read here rather than
 * guessed at twice.
 *
 * Empty string, not "/", for standalone: router.js strips trailing slashes
 * from whatever it's given, so both collapse to the same mountPoint — but
 * "" is the one that reads correctly at the call site below, and it's what
 * the server's content="" already is when there's no mount.
 */
const MOUNT = document.querySelector('meta[name="sentinel-mount"]')?.content ?? "";

// Registered once, at module load — before the router starts in boot(), and
// before anything can navigate to it. Needs scopedApp and embedded above:
// Projects is never reachable in either case, and showReports() below isn't
// defined until further down the file, but the closures here don't run
// until a route actually matches, by which point it is.
/**
 * Requests and settings are dialogs over the landing screen, not screens of
 * their own: they open with modal(), which appends to the body and leaves
 * the outlet alone.
 *
 * Reached from "/" that's fine — Projects is already painted behind them.
 * Reached cold, from a bookmark or a typed address, nothing has painted it
 * and the dialog opens over a blank page. So the background is part of the
 * route rather than something the boot sequence has to remember.
 *
 * Composed here rather than painted directly from enter(), because going
 * through the router is what earns the abort signal and the staleness check:
 * navigate away mid-fetch and this render is cancelled and discarded, where
 * a hand-rolled paint would land on whatever screen replaced it.
 *
 * It does mean "/" → "/requests" re-fetches the projects behind the dialog.
 * One small GET for a background that is definitely current, rather than a
 * cache to invalidate.
 */
const overLanding = (view) => async (ctx) => {
  if (!scopedApp) await projectsView(ctx, { onOpenReports: showReports, hueFor: appHue });
  return view(ctx);
};

route("/requests", overLanding(requestsView));
route("/settings", overLanding((ctx) => settingsView(ctx)));
// A per-app save changes what a project card shows (its origin count, or —
// for "add an app" — whether the card exists at all), so it's the one
// caller that needs to know when settingsView has saved something.
route("/settings/apps/:app", overLanding((ctx) => settingsView(ctx, { onSaved: refresh })));
// Scoped and embedded sessions are locked to one app's reports and have no
// "all projects" to come home to — showProjects() already refused to show
// it for the same reason, this is that same refusal at the address level.
if (!scopedApp) {
  // hueFor is app.js's own appHue(), not a copy: it's keyed off appNames,
  // which spans both projects and reports, so an app with reports but no
  // project record still gets the same colour here as it does on a report
  // row's project chip. A card's own idea of "which apps exist" would only
  // ever see the project half of that list.
  route("/", (ctx) => projectsView(ctx, { onOpenReports: showReports, hueFor: appHue }));
}

/**
 * Host apps pass their own brand colour and current light/dark mode so the
 * embedded viewer matches the surrounding admin instead of announcing
 * itself. Both are cosmetic and validated before use.
 */
const THEME_KEY = "incident-viewer-theme";

function setTheme(theme) {
  document.body.classList.remove("theme-light", "theme-dark");
  if (theme === "light" || theme === "dark") {
    document.body.classList.add(`theme-${theme}`);
  }
}

function applyHostTheme({ accent, theme } = {}) {
  const nextAccent = accent || params.get("accent");
  if (nextAccent && /^#[0-9a-f]{3,8}$/i.test(nextAccent)) {
    document.documentElement.style.setProperty("--accent", nextAccent);
  }

  // Standalone, whoever is reading gets to choose and we remember it.
  // Embedded, the host app's own theme wins — the viewer shouldn't be light
  // inside a dark admin.
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage disabled; fall through to the system preference.
  }

  setTheme(theme || params.get("theme") || (embedded ? null : stored));
}

applyHostTheme();

/** light → dark → system → light. "system" follows prefers-color-scheme. */
function cycleTheme() {
  const order = ["light", "dark", "system"];
  let current = "system";
  if (document.body.classList.contains("theme-light")) current = "light";
  if (document.body.classList.contains("theme-dark")) current = "dark";

  const next = order[(order.indexOf(current) + 1) % order.length];
  setTheme(next === "system" ? null : next);
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // Not worth failing over; the choice just won't persist.
  }
  return next;
}

const el = (id) => document.getElementById(id);
const gate = el("gate");
const app = el("app");
const list = el("list");
const detail = el("detail");
// The router's outlet — Projects renders here now, the first full-page
// (non-modal) view to. Its own visibility is still paintChrome()'s job,
// toggled alongside #reports-view, for as long as Reports stays legacy.
const viewOutlet = el("view");

/** Only set when embedded: the shared staff token, from the host page. */
let bearerToken = "";

let projects = [];
let reports = [];
let appNames = [];
let glitchtipRoot = null;
let view = "projects";
let selectedApp = "";
let selectedId = null;
let lightboxFrames = [];
let lightboxIndex = 0;

/** Object URLs we minted for screenshots — revoked when the view changes. */
let objectUrls = [];

/**
 * Standalone the session cookie carries us; embedded there is no cookie to
 * carry (third-party cookies in an iframe), so the host's staff token goes
 * on the header instead.
 */
function api(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

function releaseObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtCrumbTime(ts) {
  if (!ts) return "—";
  // Sentry breadcrumb timestamps are seconds since epoch (float).
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------- sign-in

function showGate(message) {
  app.hidden = true;
  gate.hidden = false;
  const err = el("gate-error");
  err.hidden = !message;
  err.textContent = message || "";
  // Password is the way in most people will use; the token form is a click
  // away for anyone who needs it.
  if (!el("token-signin").hidden) el("token-input").focus();
  else el("email-input").focus();
}

/**
 * Which credential the sign-in screen should ask for. With GlitchTip wired
 * up it's a personal auth token; without it, the shared staff token is all
 * there is.
 */
async function describeSignIn() {
  let config = {};
  try {
    const res = await fetch("/sentinel/api/auth/config", { credentials: "same-origin" });
    if (res.ok) config = await res.json();
  } catch {
    // Receiver unreachable — the sign-in attempt itself will say so.
  }
  paintSignIn(config);
  return config;
}

function paintSignIn(config) {

  const hint = el("gate-hint");
  const link = el("gate-glitchtip-link");

  if (config.glitchtipEnabled) {
    el("token-input").placeholder = "GlitchTip auth token";
    // We only reach the sign-in screen when silent sign-in didn't work, so
    // say what to do about that before offering the manual route.
    el("gate-help").textContent =
      "Sign in to GlitchTip in this browser and reload, or paste a GlitchTip auth token.";
    hint.hidden = false;
    // Only claim a specific organisation when one is actually required —
    // normally any organisation you belong to will do.
    const orgNote = el("gate-org-note");
    if (config.glitchtipOrg) {
      el("gate-org").textContent = config.glitchtipOrg;
      orgNote.hidden = false;
    } else {
      orgNote.hidden = true;
    }
    if (config.glitchtipUrl) {
      link.href = `${config.glitchtipUrl.replace(/\/+$/, "")}/profile/auth-tokens`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  } else {
    el("token-input").placeholder = "Staff token";
    el("gate-help").textContent = "Enter the staff token to read bug reports and session replays.";
    hint.hidden = true;
  }
}


/**
 * Email and password, against GlitchTip's own accounts.
 *
 * Sentinel shows the form; GlitchTip decides. Its login endpoint is on this
 * same origin, so the session it sets is the one everything else here
 * already understands — the viewer, the issue stream, and GlitchTip's own
 * screens all follow from it. Nothing about the password touches this
 * receiver.
 */
function readCsrf() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function passwordSignIn() {
  const error = el("password-error");
  error.hidden = true;

  const email = el("email-input").value.trim();
  const password = el("password-input").value;
  if (!email || !password) {
    error.hidden = false;
    error.textContent = "Enter your email and password.";
    return;
  }

  const button = el("password-submit");
  button.disabled = true;
  try {
    // Django won't accept the login without a CSRF token, and a fresh
    // browser has no reason to have one yet — this GET is what mints it.
    if (!readCsrf()) {
      await fetch("/_allauth/browser/v1/auth/session", { credentials: "same-origin" });
    }

    const res = await fetch("/_allauth/browser/v1/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrftoken": readCsrf() },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok || res.status === 200) {
      el("password-input").value = "";
      // GlitchTip has set its session; ours follows from it.
      const sso = await fetch("/sentinel/api/auth/sso", {
        method: "POST",
        credentials: "same-origin",
      });
      const body = await sso.json().catch(() => ({}));
      if (sso.ok) return body.pending ? showWaiting(body) : enter();
      error.hidden = false;
      error.textContent = body.error || "Signed in to GlitchTip, but this viewer refused.";
      return;
    }

    const body = await res.json().catch(() => ({}));
    error.hidden = false;
    error.textContent =
      body.errors?.[0]?.message || `That didn't work (${res.status}).`;
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

el("password-submit").addEventListener("click", () => void passwordSignIn());
for (const id of ["email-input", "password-input"]) {
  el(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void passwordSignIn();
    }
  });
}

el("show-token").addEventListener("click", () => {
  el("password-signin").hidden = true;
  el("token-signin").hidden = false;
  el("token-input").focus();
});

el("show-password").addEventListener("click", () => {
  el("token-signin").hidden = true;
  el("password-signin").hidden = false;
  el("email-input").focus();
});

el("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = el("token-input").value.trim();
  if (!token) return;

  const button = el("gate-form").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const res = await fetch("/sentinel/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    });

    if (res.ok) {
      // The session is the cookie now; don't keep a copy of the token.
      el("token-input").value = "";
      const body = await res.json().catch(() => ({}));
      if (body.pending) return showWaiting(body);
      await enter();
      return;
    }

    const body = await res.json().catch(() => ({}));
    showGate(body.error || `Sign-in failed (${res.status}).`);
  } catch (err) {
    showGate(err.message);
  } finally {
    button.disabled = false;
  }
});

/**
 * Signing out ends the GlitchTip session too, so there's nothing left for
 * silent sign-in to pick up and no need to suppress it: reloading lands on
 * the sign-in screen. Signing back in to GlitchTip deliberately is then a
 * way back in, which is what you'd want it to be.
 */
el("forget").addEventListener("click", async () => {
  await fetch("/sentinel/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  projects = [];
  reports = [];
  selectedId = null;
  detail.innerHTML = "<p class='empty'>Select a report.</p>";
  showGate();
});

/**
 * Ask the embedding admin page for the staff token. The outbound ping
 * carries no data; only the reply matters, and only from our own parent.
 */
function requestTokenFromHost() {
  return new Promise((resolve) => {
    if (!embedded || window.parent === window) return resolve(null);

    const timer = setTimeout(() => resolve(null), 2500);
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      if (event.data?.type !== "incident-viewer-token") return;
      clearTimeout(timer);
      // The host can also correct our theme/accent here — useful when it
      // only knows them at runtime (a Moodle theme, a user toggle).
      applyHostTheme({ accent: event.data.accent, theme: event.data.theme });
      resolve(String(event.data.token || ""));
    });

    window.parent.postMessage({ type: "incident-viewer-ready" }, "*");
  });
}

// ------------------------------------------------------------------ data

async function loadData() {
  const [projectsRes, reportsRes] = await Promise.all([api("/sentinel/api/projects"), api("/sentinel/api/reports")]);

  if (projectsRes.status === 401 || reportsRes.status === 401) {
    showGate(
      embedded ? "The token this page was given was rejected." : "Your session has expired."
    );
    return false;
  }
  if (!reportsRes.ok) throw new Error(`receiver responded ${reportsRes.status}`);

  const payload = projectsRes.ok ? await projectsRes.json() : { projects: [] };
  projects = payload.projects || [];
  glitchtipRoot = payload.glitchtip || null;
  reports = await reportsRes.json();

  // One sorted list of app names, so the per-app colour is the same on a
  // card and on every row inside it.
  appNames = [...new Set([...projects.map((p) => p.appName), ...reports.map((r) => r.appName)])]
    .filter(Boolean)
    .sort();
  return true;
}

function projectFor(appName) {
  return projects.find((p) => p.appName === appName) || null;
}

// ---------------------------------------------------------------- render

/** Twelve hues chosen to stay tellable apart at chip size, in both themes. */
const PROJECT_HUES = [210, 340, 150, 35, 275, 190, 15, 120, 300, 60, 240, 95];

/**
 * A colour per app, handed out by position in the sorted list of apps that
 * actually have reports. Hashing the name instead would be stable across
 * datasets, but two of a handful of apps regularly hash to neighbouring
 * hues — and telling apps apart at a glance is the entire point.
 */
function appHue(appName) {
  const index = appNames.indexOf(appName);
  return PROJECT_HUES[(index < 0 ? 0 : index) % PROJECT_HUES.length];
}

/** What visual evidence a report carries — replay now, screenshots on older ones. */
function evidenceLabel(report) {
  if (report.hasReplay) {
    const meta = report.replayMeta || {};
    if (meta.startedAt && meta.endedAt) {
      return `${Math.round((meta.endedAt - meta.startedAt) / 1000)}s replay`;
    }
    return "replay";
  }
  const shots = (report.screenshots || []).length;
  if (shots) return `${shots} shot${shots > 1 ? "s" : ""}`;
  return "no replay";
}

function projectChip(appName) {
  const chip = document.createElement("span");
  chip.className = "tag project";
  chip.style.setProperty("--project-hue", String(appHue(appName)));
  chip.textContent = appName;
  return chip;
}

// ------------------------------------------------------- projects landing
//
// The screen itself is views/projects.js, mounted by the router at "/".
// appHue() and projectChip() above stay here — Reports still uses them for
// its own project chips, and projects.js is handed appHue() directly as
// hueFor() (see the route registration) rather than keeping its own copy.

// ----------------------------------------------------------- reports list

function currentFilters() {
  return {
    q: el("search").value.trim().toLowerCase(),
    source: el("source-filter").value,
  };
}

function visibleReports() {
  const { q, source } = currentFilters();
  return reports.filter((r) => {
    // The list only ever shows one app: either the drilled-into project or,
    // embedded, the app whose admin we're sitting inside.
    if (selectedApp && r.appName !== selectedApp) return false;
    if (source && r.source !== source) return false;
    if (!q) return true;
    return [r.note, r.url, r.reporterEmail, r.appName, r.id]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q));
  });
}

function renderList() {
  const rows = visibleReports();
  list.innerHTML = "";

  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = reports.length ? "Nothing matches those filters." : "No reports yet.";
    list.appendChild(li);
    return;
  }

  for (const report of rows) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    if (report.id === selectedId) button.setAttribute("aria-current", "true");

    const top = document.createElement("div");
    top.className = "row-top";
    const note = document.createElement("span");
    note.className = "row-note";
    note.textContent = report.note || "(no note)";
    const tag = document.createElement("span");
    tag.className = report.source === "auto-error" ? "tag auto" : "tag";
    tag.textContent = report.source === "auto-error" ? "auto" : "staff";
    top.append(note, tag);

    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.append(
      Object.assign(document.createElement("span"), { textContent: fmtTime(report.createdAt) }),
      Object.assign(document.createElement("span"), { textContent: evidenceLabel(report) })
    );

    button.append(top, meta);
    button.addEventListener("click", () => selectReport(report.id));
    li.appendChild(button);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------- navigation

/** Topbar and view visibility for whichever of the two views is current. */
function paintChrome() {
  const inReports = view === "reports";

  // Projects itself is router-rendered now (views/projects.js, into #view);
  // this is only ever a visibility toggle, never a repaint. Reports still
  // owns #reports-view directly, so it's still this function's job to hide
  // one and show the other.
  viewOutlet.hidden = inReports;
  el("reports-view").hidden = !inReports;
  el("search").hidden = !inReports;
  el("source-filter").hidden = !inReports;

  const crumb = el("crumb");
  crumb.hidden = !inReports || !selectedApp;
  crumb.textContent = selectedApp ? `/ ${selectedApp}` : "";

  // Scoped to one app by its host: there is no "all projects" to go back to.
  el("home-link").disabled = Boolean(scopedApp) || !inReports;

  const url = inReports ? projectFor(selectedApp)?.glitchtipUrl || glitchtipRoot : glitchtipRoot;
  const link = el("glitchtip-link");
  link.hidden = !url;
  if (url) link.href = url;
}

/**
 * Chrome only — the cards themselves are already sitting in #view, painted
 * once by the router when "/" first mounted. Showing them again is just
 * this toggle; refresh() is what asks the router to repaint with fresh
 * data, and only when the data might actually be stale.
 */
function showProjects() {
  if (scopedApp) return;
  view = "projects";
  selectedApp = "";
  selectedId = null;
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Select a report.</p>";
  document.title = "Sentinel";
  paintChrome();
}

function showReports(appName) {
  view = "reports";
  selectedApp = appName || "";
  selectedId = null;
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Select a report.</p>";
  document.title = selectedApp ? `${selectedApp} — Sentinel` : "Sentinel";
  el("search").placeholder = selectedApp
    ? `Search ${selectedApp} reports…`
    : "Search note, URL, reporter…";
  paintChrome();
  renderList();
}

function render() {
  if (view === "reports") renderList();
  // Embedded never starts the router (see enter()) — nothing to refresh.
  else if (!embedded) void refreshRoute();
}

// ----------------------------------------------------------- report detail

async function selectReport(id) {
  selectedId = id;
  renderList();
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Loading…</p>";

  const res = await api(`/sentinel/api/reports/${encodeURIComponent(id)}`);
  if (res.status === 401) return showGate("Your session has expired.");
  if (!res.ok) {
    detail.innerHTML = `<p class="error">Could not load report (${res.status}).</p>`;
    return;
  }
  const report = await res.json();
  renderDetail(report);
}

function renderDetail(report) {
  detail.innerHTML = "";

  const heading = document.createElement("h2");
  heading.textContent = report.note || "(no note)";
  detail.appendChild(heading);

  const sub = document.createElement("p");
  sub.className = "detail-sub";
  const id = document.createElement("span");
  id.className = "muted mono";
  id.textContent = report.id;
  sub.append(projectChip(report.appName), id);
  detail.appendChild(sub);

  const kv = document.createElement("dl");
  kv.className = "kv";
  const rows = [
    ["App", report.appName],
    ["Source", report.source === "auto-error" ? "Auto-captured error" : "Staff report"],
    ["Reported by", report.reporterEmail || "—"],
    ["Page", report.url || "—"],
    ["When", fmtTime(report.createdAt)],
    ["GlitchTip", report.glitchtipEventId || "— (staff reports aren't sent to GlitchTip)"],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    if (key === "Page" && report.url) {
      const a = document.createElement("a");
      a.href = report.url;
      a.textContent = report.url;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      dd.appendChild(a);
    } else if (key === "GlitchTip" && report.glitchtipUrl) {
      // With an event id this lands on the error itself; without one, on the
      // project's issue stream, which is still the right next place to look.
      const a = document.createElement("a");
      a.href = report.glitchtipUrl;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = report.glitchtipEventId
        ? `${report.glitchtipEventId} ↗`
        : "Open this app's errors ↗";
      dd.appendChild(a);
    } else {
      dd.textContent = value;
    }
    kv.append(dt, dd);
  }
  detail.appendChild(kv);

  renderReplay(report);
  renderScreenshots(report);
  renderBreadcrumbs(report);
  renderDangerZone(report);
}

/**
 * Session replay. Reports made before the rrweb switch have screenshots
 * instead, so this quietly does nothing for them.
 */
async function renderReplay(report) {
  if (!report.hasReplay) return;

  const h3 = document.createElement("h3");
  h3.textContent = "Session replay";
  detail.appendChild(h3);

  const meta = report.replayMeta || {};
  if (meta.startedAt && meta.endedAt) {
    const seconds = Math.round((meta.endedAt - meta.startedAt) / 1000);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0 0 10px";
    note.textContent = `${seconds}s leading up to the report · ${meta.eventCount ?? "?"} events`;
    detail.appendChild(note);
  }

  const mount = document.createElement("div");
  mount.className = "replay";
  detail.appendChild(mount);

  try {
    const res = await api(`/sentinel/api/reports/${encodeURIComponent(report.id)}/replay`);
    if (!res.ok) throw new Error(`replay unavailable (${res.status})`);
    const events = await res.json();
    if (events.length < 2) throw new Error("replay too short to play");

    const { default: Player } = await import("./vendor/rrweb-player.js");
    // eslint-disable-next-line no-new
    new Player({
      target: mount,
      props: {
        events,
        width: mount.clientWidth || 720,
        height: Math.round((mount.clientWidth || 720) * 0.56),
        autoPlay: false,
        showController: true,
        // The recording is masked, but don't let a replayed page make
        // network requests of its own.
        UNSAFE_replayCanvas: false,
      },
    });
  } catch (err) {
    mount.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `Could not load replay: ${err.message}`;
    mount.appendChild(p);
  }
}

function renderDangerZone(report) {
  const wrap = document.createElement("div");
  wrap.className = "danger-zone";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost danger";
  button.textContent = "Delete this report";
  button.addEventListener("click", async () => {
    if (button.dataset.confirming !== "true") {
      button.dataset.confirming = "true";
      button.textContent = "Really delete? Click again";
      setTimeout(() => {
        button.dataset.confirming = "false";
        button.textContent = "Delete this report";
      }, 4000);
      return;
    }

    button.disabled = true;
    const res = await api(`/sentinel/api/reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      button.disabled = false;
      button.textContent = `Delete failed (${res.status})`;
      return;
    }
    reports = reports.filter((r) => r.id !== report.id);
    // The card's counts are now wrong, so re-derive them from the receiver
    // rather than guessing at them here.
    const project = projectFor(report.appName);
    if (project) project.total = Math.max(0, project.total - 1);
    selectedId = null;
    detail.innerHTML = "<p class='empty'>Report deleted.</p>";
    renderList();
  });

  wrap.appendChild(button);
  detail.appendChild(wrap);
}

function frameLabel(index, total, timestamp, filedAt) {
  const position = index === total - 1 ? "latest" : `frame ${index + 1}`;
  if (!timestamp || !filedAt) return position;
  const secondsBack = Math.round((filedAt - timestamp) / 1000);
  if (secondsBack <= 0) return `${position} · at report`;
  return `${position} · −${secondsBack}s`;
}

function renderScreenshots(report) {
  const files = report.screenshots || [];
  // Replay supersedes screenshots; only older reports have both/neither.
  if (!files.length && report.hasReplay) return;

  const h3 = document.createElement("h3");
  h3.textContent = `Screenshots (${files.length})`;
  detail.appendChild(h3);

  if (!files.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No screenshots or replay in this report.";
    detail.appendChild(p);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "shots";
  detail.appendChild(wrap);

  lightboxFrames = [];

  const stamps = report.screenshotTimestamps || [];
  const filedAt = new Date(report.createdAt).getTime();

  files.forEach((filename, index) => {
    const button = document.createElement("button");
    button.type = "button";
    const img = document.createElement("img");
    img.alt = `Frame ${index + 1}`;
    const label = document.createElement("div");
    label.className = "shot-label";
    // Frames are oldest-first and the last one is the moment the report was
    // filed, so label them by how far back they look.
    label.textContent = frameLabel(index, files.length, stamps[index], filedAt);
    button.append(img, label);
    button.addEventListener("click", () => openLightbox(index));
    wrap.appendChild(button);

    api(`/sentinel/api/reports/${encodeURIComponent(report.id)}/screenshots/${encodeURIComponent(filename)}`)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        lightboxFrames[index] = { url, label: label.textContent };
        img.src = url;
      })
      .catch(() => {
        label.textContent = `frame ${index + 1} — failed to load`;
      });
  });
}

function renderBreadcrumbs(report) {
  const crumbs = report.breadcrumbs || [];
  const h3 = document.createElement("h3");
  h3.textContent = `Breadcrumbs (${crumbs.length})`;
  detail.appendChild(h3);

  if (!crumbs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No breadcrumbs recorded.";
    detail.appendChild(p);
    return;
  }

  const box = document.createElement("div");
  box.className = "crumbs";
  for (const crumb of crumbs) {
    const row = document.createElement("div");
    row.className = "crumb";
    const time = document.createElement("span");
    time.className = "t mono";
    time.textContent = fmtCrumbTime(crumb.timestamp);
    const category = document.createElement("span");
    category.className = "c";
    category.textContent = crumb.category || crumb.type || "—";
    const message = document.createElement("span");
    message.className = "m";
    message.textContent =
      crumb.message || (crumb.data ? JSON.stringify(crumb.data) : "") || "—";
    row.append(time, category, message);
    box.appendChild(row);
  }
  detail.appendChild(box);
}

// ------------------------------------------------------- awaiting access

const waiting = el("waiting");

/**
 * Someone with a GlitchTip account and no organisation. They can't be shown
 * reports, but a dead end is the wrong answer — GlitchTip has no way to ask
 * for access, so this is it.
 */
async function showWaiting(identity) {
  gate.hidden = true;
  app.hidden = true;
  waiting.hidden = false;
  el("waiting-email").textContent = identity?.email || "your account";
  await paintWaiting();
}

async function paintWaiting() {
  const res = await fetch("/sentinel/api/access/me", { credentials: "same-origin" });
  if (!res.ok) return;
  const body = await res.json();

  const request = body.request;
  const status = el("waiting-status");
  const ask = el("waiting-ask");
  const accept = el("waiting-accept");

  if (!request) {
    ask.hidden = false;
    status.hidden = true;
    accept.hidden = true;
    return;
  }

  ask.hidden = true;
  status.hidden = false;
  accept.hidden = true;

  if (request.status === "pending") {
    status.textContent =
      "Your request has been sent. Someone in the organisation has to approve it — this page will " +
      "show the invitation once they do.";
  } else if (request.status === "approved") {
    status.textContent = request.organization
      ? `Approved for ${request.organization}.`
      : "Approved.";
    if (request.inviteLink) {
      // With email disabled this link is the only way the invitation reaches
      // them, so put it in front of them rather than in a log.
      accept.href = request.inviteLink;
      accept.hidden = false;
    } else {
      status.textContent += " Check GlitchTip — you should be a member now.";
    }
  } else {
    status.textContent = "Your request wasn't approved. Ask whoever runs this if you think that's wrong.";
  }
}

el("waiting-request").addEventListener("click", async () => {
  const err = el("waiting-error");
  err.hidden = true;
  const res = await fetch("/sentinel/api/access/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ note: el("waiting-note").value.trim() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    err.hidden = false;
    err.textContent = body.error || `Could not send that (${res.status}).`;
    return;
  }
  await paintWaiting();
});

el("waiting-signout").addEventListener("click", async () => {
  await fetch("/sentinel/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  waiting.hidden = true;
  showGate();
});

// ------------------------------------------------------- access requests
//
// The screen itself is views/requests.js, mounted by the router. Registered
// down in boot(), where the router starts — this comment marks where it
// used to live so the history of what moved is easy to find later.

/** Only worth offering when there's something to decide. */
async function refreshRequestCount() {
  if (embedded) return;
  const res = await api("/sentinel/api/access/requests");
  if (!res.ok) return;
  const body = await res.json().catch(() => ({}));
  const pending = (body.requests || []).filter((r) => r.status === "pending").length;
  const button = el("requests-open");
  button.hidden = pending === 0;
  button.textContent = pending === 1 ? "1 request" : `${pending} requests`;
}


// ------------------------------------------------------------- sections

/**
 * Issues and Reports are two views of the same incident, so they're tabs
 * rather than two applications. Issues reads GlitchTip's API directly;
 * Reports is this receiver's own data.
 */
let section = "reports";

function showSection(next) {
  section = next;
  const onIssues = next === "issues";

  el("tab-issues").classList.toggle("selected", onIssues);
  el("tab-reports").classList.toggle("selected", !onIssues);
  el("issues-view").hidden = !onIssues;

  // The reports side owns three of its own elements; hide the lot together.
  if (onIssues) {
    viewOutlet.hidden = true;
    el("reports-view").hidden = true;
    el("search").hidden = true;
    el("source-filter").hidden = true;
    el("crumb").hidden = true;
    void showIssues();
  } else {
    // Not render(): whichever of #view or #reports-view was showing before
    // Issues is still sitting there untouched, just hidden. Re-showing it
    // is all this needs — render() would also ask the router to refetch
    // Projects, on every tab switch, for data that hasn't changed.
    paintChrome();
  }
}

el("tab-issues").addEventListener("click", () => showSection("issues"));
el("tab-reports").addEventListener("click", () => showSection("reports"));

// ---------------------------------------------------------- settings
//
// The screen itself is views/settings.js, mounted by the router — both
// "/settings" (global) and "/settings/apps/:app" (one app, opened from
// its project card). Registered down in boot(), alongside requests.
// ---------------------------------------------------------- lightbox

const lightbox = el("lightbox");

function openLightbox(index) {
  if (!lightboxFrames[index]) return;
  lightboxIndex = index;
  paintLightbox();
  lightbox.hidden = false;
}

function paintLightbox() {
  const frame = lightboxFrames[lightboxIndex];
  if (!frame) return;
  el("lightbox-img").src = frame.url;
  el("lightbox-caption").textContent = `${frame.label} — ${lightboxIndex + 1} of ${lightboxFrames.length}`;
}

function step(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxFrames.length) return;
  lightboxIndex = next;
  paintLightbox();
}

el("lightbox-close").addEventListener("click", () => (lightbox.hidden = true));
el("lightbox-prev").addEventListener("click", () => step(-1));
el("lightbox-next").addEventListener("click", () => step(1));
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) lightbox.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (lightbox.hidden) return;
  if (event.key === "Escape") lightbox.hidden = true;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});

// ------------------------------------------------------------- wiring

const themeToggle = el("theme-toggle");

function labelThemeToggle(theme) {
  const icons = { light: "☀︎ Light", dark: "☾ Dark", system: "◐ System" };
  themeToggle.textContent = icons[theme] || icons.system;
}

themeToggle.addEventListener("click", () => labelThemeToggle(cycleTheme()));

el("search").addEventListener("input", render);
el("source-filter").addEventListener("change", render);
el("home-link").addEventListener("click", () => showProjects());
el("refresh").addEventListener("click", () => void refresh());

async function refresh() {
  try {
    if (!(await loadData())) return;
  } catch (err) {
    detail.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }
  // The app we were looking at may have had its last report deleted.
  if (view === "reports" && selectedApp && !projectFor(selectedApp) && !scopedApp) {
    showProjects();
    // Landing on Projects with whatever it last fetched would still show
    // the app that's meant to have just disappeared from it.
    if (!embedded) void refreshRoute();
    return;
  }
  paintChrome();
  render();
}

/** Past the gate: load everything, then land on the right view. */
async function enter() {
  gate.hidden = true;
  waiting.hidden = true;
  app.hidden = false;
  if (!(await loadData())) return;
  void refreshRequestCount();

  // Issues live under an organisation, so they can't be set up until we know
  // which one this person belongs to.
  const me = await fetch("/sentinel/api/auth/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const organisation = (me?.orgs || [])[0];
  if (organisation) {
    initIssues({ organisation });
    el("tab-issues").hidden = false;
  } else {
    // Nothing to browse errors under — the staff token, typically.
    el("tab-issues").hidden = true;
  }
  // Embedded is a single app inside another page's iframe — no address bar
  // of its own to route within, and nothing routed lives there yet anyway.
  //
  // Started before the base view below, not after: showProjects() further
  // down does nothing but toggle visibility now, but the router still needs
  // its mount configured before requests-open/settings-open (below, static
  // markup that can't read MOUNT itself) or the Projects view it renders at
  // "/" — both build links with routeHref(), which would otherwise still be
  // pointing at the default "/sentinel" in standalone mode.
  if (!embedded) {
    await startRouter({ outlet: viewOutlet, mount: MOUNT });
    // Static markup in index.html, so it can't read MOUNT itself.
    el("requests-open").href = routeHref("/requests");
    el("settings-open").href = routeHref("/settings");
    // Arrived from GlitchTip's "Requests" nav item (glitchtip/index.html),
    // which still links to the old query-param address. Land on the real
    // one instead of teaching the router about a second spelling of it.
    if (params.get("view") === "requests") {
      await goRoute("/requests", { replace: true });
    }
  }

  if (scopedApp) showReports(scopedApp);
  else showProjects();
}

async function boot() {
  if (embedded) {
    document.body.classList.add("embedded");
    el("forget").hidden = true;
    // The host app owns the theme when we're inside it.
    themeToggle.hidden = true;
  } else {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // Storage disabled.
    }
    labelThemeToggle(stored || "system");
  }

  // Embedded: the host hands us the shared staff token, no sign-in screen.
  const hostToken = await requestTokenFromHost();
  if (hostToken) {
    bearerToken = hostToken;
    try {
      await enter();
    } catch (err) {
      showGate(err.message);
    }
    return;
  }

  // Standalone: our own session cookie may already be good.
  const config = await describeSignIn();
  try {
    const res = await fetch("/sentinel/api/auth/me", { credentials: "same-origin" });
    if (res.ok) {
      const me = await res.json().catch(() => ({}));
      if (me.pending) return showWaiting(me);
      return await enter();
    }
  } catch {
    // Fall through.
  }

  // Failing that, whoever is reading may already be signed in to GlitchTip
  // in this browser — in which case there's nothing for them to type.
  if (config.glitchtipEnabled) {
    try {
      const res = await fetch("/sentinel/api/auth/sso", { method: "POST", credentials: "same-origin" });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.pending) return showWaiting(body);
        return await enter();
      }
      // 403 means signed in to GlitchTip but not a member of the org, which
      // is worth saying out loud rather than showing a blank sign-in screen.
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        return showGate(body.error || "That GlitchTip account isn't a member of the organisation.");
      }
    } catch {
      // Fall through to the sign-in screen.
    }
  }

  showGate(embedded ? "This page was not given a token." : "");
}

void boot();
