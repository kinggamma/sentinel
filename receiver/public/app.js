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
const projectsView = el("projects-view");

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

/** "3 minutes ago" is the useful form for a last-seen timestamp on a card. */
function fmtAgo(iso) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "never";
  const steps = [
    [60, "second", 1],
    [3600, "minute", 60],
    [86400, "hour", 3600],
    [2592000, "day", 86400],
  ];
  for (const [limit, unit, divisor] of steps) {
    if (seconds < limit) {
      const value = Math.max(1, Math.floor(seconds / divisor));
      return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    }
  }
  return fmtTime(iso);
}

// ---------------------------------------------------------------- sign-in

function showGate(message) {
  app.hidden = true;
  gate.hidden = false;
  const err = el("gate-error");
  err.hidden = !message;
  err.textContent = message || "";
  el("token-input").focus();
}

/**
 * Which credential the sign-in screen should ask for. With GlitchTip wired
 * up it's a personal auth token; without it, the shared staff token is all
 * there is.
 */
async function describeSignIn() {
  let config = {};
  try {
    const res = await fetch("/api/auth/config", { credentials: "same-origin" });
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

el("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = el("token-input").value.trim();
  if (!token) return;

  const button = el("gate-form").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
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
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
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
  const [projectsRes, reportsRes] = await Promise.all([api("/api/projects"), api("/api/reports")]);

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

function glitchtipAnchor(url, label) {
  const a = document.createElement("a");
  a.className = "button-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.textContent = label;
  return a;
}

// ------------------------------------------------------- projects landing

function renderProjects() {
  projectsView.innerHTML = "";

  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No app has reported yet.";
    projectsView.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const card = document.createElement("article");
    card.className = "project-card";
    card.style.setProperty("--project-hue", String(appHue(project.appName)));

    const heading = document.createElement("h2");
    heading.textContent = project.appName;

    const stats = document.createElement("dl");
    stats.className = "card-stats";
    const figures = [
      ["Reports", project.total],
      ["Staff", project.staffReports],
      ["Auto", project.autoErrors],
      ["Replays", project.withReplay],
    ];
    for (const [label, value] of figures) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = String(value ?? 0);
      stats.append(dt, dd);
    }

    const foot = document.createElement("p");
    foot.className = "card-foot muted";
    foot.textContent = `Last report ${fmtAgo(project.lastReportAt)}`;

    // Shown only for projects Sentinel created, which is exactly when the
    // app still needs its DSN pasting into a config somewhere.
    let dsnButton = null;
    if (project.dsn) {
      const dsn = document.createElement("button");
      dsn.type = "button";
      dsn.className = "ghost dsn";
      dsn.title = project.dsn;
      dsn.textContent = "Copy DSN";
      dsn.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(project.dsn);
          dsn.textContent = "Copied";
        } catch {
          // Clipboard blocked (insecure origin, denied permission) — show it
          // instead so it can be selected by hand.
          dsn.textContent = project.dsn;
        }
        setTimeout(() => (dsn.textContent = "Copy DSN"), 2500);
      });
      dsnButton = dsn;
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open reports";
    open.addEventListener("click", () => showReports(project.appName));
    actions.appendChild(open);

    if (project.glitchtipUrl) {
      const link = glitchtipAnchor(project.glitchtipUrl, "GlitchTip ↗");
      // The whole card is clickable; the link is the one thing that isn't.
      link.addEventListener("click", (event) => event.stopPropagation());
      actions.appendChild(link);
    }
    if (dsnButton) actions.appendChild(dsnButton);

    // Where this app runs. Kept on the card because that's where you are
    // when you notice an app has moved, or that a new one can't report yet.
    const where = document.createElement("button");
    where.type = "button";
    where.className = "ghost";
    where.textContent = project.origins?.length
      ? `Runs at ${project.origins.length === 1 ? project.origins[0] : `${project.origins.length} addresses`}`
      : "Set where it runs";
    where.addEventListener("click", (event) => {
      event.stopPropagation();
      openAppOrigins(project.appName, project.origins || []);
    });
    actions.appendChild(where);

    card.append(heading, stats, foot, actions);
    card.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      showReports(project.appName);
    });
    projectsView.appendChild(card);
  }
}

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

  projectsView.hidden = inReports;
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

function showProjects() {
  if (scopedApp) return;
  view = "projects";
  selectedApp = "";
  selectedId = null;
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Select a report.</p>";
  document.title = "Sentinel";
  paintChrome();
  renderProjects();
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
  else renderProjects();
}

// ----------------------------------------------------------- report detail

async function selectReport(id) {
  selectedId = id;
  renderList();
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Loading…</p>";

  const res = await api(`/api/reports/${encodeURIComponent(id)}`);
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
    const res = await api(`/api/reports/${encodeURIComponent(report.id)}/replay`);
    if (!res.ok) throw new Error(`replay unavailable (${res.status})`);
    const events = await res.json();
    if (events.length < 2) throw new Error("replay too short to play");

    const { default: Player } = await import("/vendor/rrweb-player.js");
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
    const res = await api(`/api/reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
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

    api(`/api/reports/${encodeURIComponent(report.id)}/screenshots/${encodeURIComponent(filename)}`)
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
  const res = await fetch("/api/access/me", { credentials: "same-origin" });
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
  const res = await fetch("/api/access/request", {
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
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  waiting.hidden = true;
  showGate();
});

// ------------------------------------------------------- access requests

const requestsPanel = el("requests");

function renderRequests(requests, organisations) {
  const list = el("request-list");
  list.innerHTML = "";

  const pending = requests.filter((r) => r.status === "pending");
  if (!pending.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nobody is waiting.";
    list.appendChild(li);
    return;
  }

  for (const request of pending) {
    const li = document.createElement("li");

    const who = document.createElement("div");
    who.innerHTML = "";
    const email = document.createElement("div");
    email.className = "mono";
    email.textContent = request.email;
    who.appendChild(email);
    if (request.note) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = request.note;
      who.appendChild(note);
    }
    li.appendChild(who);

    const actions = document.createElement("div");
    actions.className = "card-actions";

    // Which organisation to put them in. Only the approver's own.
    const picker = document.createElement("select");
    for (const org of organisations) {
      const option = document.createElement("option");
      option.value = org;
      option.textContent = org;
      picker.appendChild(option);
    }
    if (!organisations.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "no organisation to add them to";
      picker.appendChild(option);
      picker.disabled = true;
    }

    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve";
    approve.disabled = !organisations.length;
    approve.addEventListener("click", () => void decideRequest(request.id, "approve", picker.value));

    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "ghost danger";
    decline.textContent = "Decline";
    decline.addEventListener("click", () => void decideRequest(request.id, "decline"));

    actions.append(picker, approve, decline);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

async function loadRequests() {
  const err = el("requests-error");
  err.hidden = true;
  const res = await api("/api/access/requests");
  if (!res.ok) {
    err.hidden = false;
    err.textContent = `Could not load requests (${res.status}).`;
    return;
  }
  const body = await res.json();
  renderRequests(body.requests || [], body.organisations || []);
}

async function decideRequest(id, action, organisation) {
  const err = el("requests-error");
  err.hidden = true;
  const res = await api(`/api/access/requests/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organisation }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    err.hidden = false;
    // 501 means no service token: the decision stands, we just can't carry
    // it out from here.
    err.textContent = body.error || `Could not do that (${res.status}).`;
    return;
  }
  await loadRequests();
}

el("requests-open").addEventListener("click", async () => {
  requestsPanel.hidden = false;
  await loadRequests();
});
el("requests-close").addEventListener("click", () => (requestsPanel.hidden = true));
requestsPanel.addEventListener("click", (event) => {
  if (event.target === requestsPanel) requestsPanel.hidden = true;
});

/** Only worth offering when there's something to decide. */
async function refreshRequestCount() {
  if (embedded) return;
  const res = await api("/api/access/requests");
  if (!res.ok) return;
  const body = await res.json().catch(() => ({}));
  const pending = (body.requests || []).filter((r) => r.status === "pending").length;
  const button = el("requests-open");
  button.hidden = pending === 0;
  button.textContent = pending === 1 ? "1 request" : `${pending} requests`;
}

// ---------------------------------------------------------- settings

const settings = el("settings");
/** Origins fixed in the environment: shown, but not removable from here. */
let fixedOrigins = [];

function renderOrigins(origins) {
  const list = el("origin-list");
  list.innerHTML = "";

  if (!origins.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No app may report yet.";
    list.appendChild(li);
    return;
  }

  for (const origin of origins) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = origin;
    li.appendChild(label);

    if (fixedOrigins.includes(origin)) {
      // Set in the deployment's own configuration, so removing it here would
      // last until the next restart and no longer — say so instead.
      const note = document.createElement("span");
      note.className = "muted";
      note.textContent = "from .env";
      li.appendChild(note);
    } else {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        const next = origins.filter((o) => o !== origin && !fixedOrigins.includes(o));
        void (editingApp ? saveAppOrigins(next) : saveOrigins(next));
      });
      li.appendChild(remove);
    }
    list.appendChild(li);
  }
}

function settingsError(message) {
  const box = el("settings-error");
  box.hidden = !message;
  box.textContent = message || "";
}

async function loadOrigins() {
  settingsError("");
  const res = await api("/api/settings/origins");
  if (!res.ok) return settingsError(`Could not load settings (${res.status}).`);
  const body = await res.json();
  fixedOrigins = body.fixed || [];
  renderOrigins(body.origins || []);
}

async function saveOrigins(origins) {
  settingsError("");
  const res = await api("/api/settings/origins", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origins }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return settingsError(body.error || `Could not save (${res.status}).`);
  fixedOrigins = body.fixed || [];
  renderOrigins(body.origins || []);
}

/**
 * One app's addresses, opened from its card. Deliberately separate from the
 * global list: this answers "where does this app run", which is the question
 * you have when an app moves or a new one won't report.
 */
let editingApp = null;

function openAppOrigins(appName, origins) {
  editingApp = appName;
  settings.hidden = false;
  el("integration").hidden = true;
  el("settings-title").textContent = `Where ${appName} runs`;
  el("settings-note").textContent =
    "Its browser code may only post reports from these addresses. An app that reports " +
    "from its own server doesn't need one.";
  el("origin-form").hidden = false;
  settingsError("");
  fixedOrigins = [];
  renderOrigins(origins);
}

async function saveAppOrigins(origins) {
  settingsError("");
  const res = await api(`/api/settings/apps/${encodeURIComponent(editingApp)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origins }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return settingsError(body.error || `Could not save (${res.status}).`);

  const app = (body.apps || []).find((a) => a.appName === editingApp);
  renderOrigins(app?.origins || []);
  // The card's label is now stale.
  void refresh();
}


/**
 * The GlitchTip service credential. Shown as set-or-not, never read back —
 * the receiver won't return it, so there's nothing here to leak.
 */
async function loadIntegration() {
  const res = await api("/api/settings/integration");
  if (!res.ok) return;
  const status = await res.json();

  const line = el("integration-status");
  const token = el("integration-token");
  const team = el("integration-team");

  const parts = [];
  parts.push(status.hasToken ? "A token is set." : "No token set — approving access and creating projects are unavailable.");
  if (status.team) parts.push(`New projects go to the "${status.team}" team.`);
  if (status.tokenFromEnv) parts.push("Set in this deployment's environment, so it can't be changed here.");
  line.textContent = parts.join(" ");

  token.disabled = status.tokenFromEnv;
  team.disabled = status.teamFromEnv;
  team.value = status.team || "";
  token.placeholder = status.hasToken ? "Paste a new token to replace it" : "Paste a token to set it";
}

el("integration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = el("integration-error");
  err.hidden = true;

  const token = el("integration-token").value.trim();
  const team = el("integration-team").value.trim();
  const payload = { team };
  // Only send the token when one was typed, so saving the team alone
  // doesn't wipe a token that's already set.
  if (token) payload.serviceToken = token;

  const res = await api("/api/settings/integration", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    err.hidden = false;
    err.textContent = body.error || `Could not save (${res.status}).`;
    return;
  }
  el("integration-token").value = "";
  await loadIntegration();
});

el("settings-open").addEventListener("click", async () => {
  editingApp = null;
  el("settings-title").textContent = "Apps allowed to report";
  el("settings-note").textContent =
    "An app's browser code can only send reports from an address listed here. " +
    "Server-side reporting doesn't need an entry — only pages running in a browser do.";
  el("origin-form").hidden = false;
  el("integration").hidden = false;
  void loadIntegration();
  settings.hidden = false;
  await loadOrigins();
});

el("settings-close").addEventListener("click", () => (settings.hidden = true));
settings.addEventListener("click", (event) => {
  if (event.target === settings) settings.hidden = true;
});

el("origin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("origin-input");
  const value = input.value.trim();
  if (!value) return;

  const current = [...el("origin-list").querySelectorAll(".mono")].map((n) => n.textContent);
  const next = [...current.filter((o) => !fixedOrigins.includes(o)), value];
  await (editingApp ? saveAppOrigins(next) : saveOrigins(next));
  if (el("settings-error").hidden) input.value = "";
});

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
  // Arrived from GlitchTip's "Requests" item: open the queue rather than
  // making them find it.
  if (params.get("view") === "requests") {
    requestsPanel.hidden = false;
    void loadRequests();
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
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
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
      const res = await fetch("/api/auth/sso", { method: "POST", credentials: "same-origin" });
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
