/**
 * Incident report viewer.
 *
 * Every API route needs `Authorization: Bearer <staff token>`, which a
 * browser can't attach by navigating — so the token is entered once and
 * kept in localStorage, and all fetches (including screenshot images) go
 * through fetch() rather than plain <img src>.
 */

const TOKEN_KEY = "incident-viewer-token";

/**
 * Two ways this page runs:
 *   standalone — http://localhost:4000, every app's reports, token pasted once.
 *   embedded   — inside an app's own admin area via <iframe src="?app=<name>&embed=1">.
 *                The host page already holds the staff token, so it hands it
 *                over by postMessage instead of asking staff to paste it, and
 *                the list is locked to that one app.
 */
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

let token = localStorage.getItem(TOKEN_KEY) || "";
let reports = [];
let selectedId = null;
let lightboxFrames = [];
let lightboxIndex = 0;

/** Object URLs we minted for screenshots — revoked when the view changes. */
let objectUrls = [];

function api(path, init = {}) {
  return fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
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

// ---------------------------------------------------------------- gate

function showGate(message) {
  app.hidden = true;
  gate.hidden = false;
  const err = el("gate-error");
  err.hidden = !message;
  err.textContent = message || "";
  el("token-input").focus();
}

async function unlock(candidate, { persist = true } = {}) {
  const res = await fetch("/api/reports", {
    headers: { authorization: `Bearer ${candidate}` },
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`receiver responded ${res.status}`);
  token = candidate;
  // Embedded, the host page supplies the token on every load — no reason
  // to leave a second copy of it lying around in storage.
  if (persist) localStorage.setItem(TOKEN_KEY, candidate);
  reports = await res.json();
  return true;
}

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

el("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = el("token-input").value.trim();
  if (!candidate) return;
  try {
    if (await unlock(candidate)) {
      gate.hidden = true;
      app.hidden = false;
      render();
    } else {
      showGate("That token was rejected.");
    }
  } catch (err) {
    showGate(err.message);
  }
});

el("forget").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  reports = [];
  el("token-input").value = "";
  showGate();
});

// -------------------------------------------------------------- render

/**
 * A stable colour per app, derived from its name — so the same app always
 * looks the same without anyone configuring a palette.
 */
/** Twelve hues chosen to stay tellable apart at chip size, in both themes. */
const PROJECT_HUES = [210, 340, 150, 35, 275, 190, 15, 120, 300, 60, 240, 95];

/**
 * A colour per app, handed out by position in the sorted list of apps that
 * actually have reports. Hashing the name instead would be stable across
 * datasets, but two of a handful of apps regularly hash to neighbouring
 * hues — and telling apps apart at a glance is the entire point.
 */
function appHue(appName) {
  const names = [...new Set(reports.map((r) => r.appName))].sort();
  const index = names.indexOf(appName);
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

function currentFilters() {
  return {
    q: el("search").value.trim().toLowerCase(),
    app: el("app-filter").value,
    source: el("source-filter").value,
  };
}

function visibleReports() {
  const { q, app: appName, source } = currentFilters();
  return reports.filter((r) => {
    // Scoped embed: an app's own admin only ever shows that app's reports.
    if (scopedApp && r.appName !== scopedApp) return false;
    if (appName && r.appName !== appName) return false;
    if (source && r.source !== source) return false;
    if (!q) return true;
    return [r.note, r.url, r.reporterEmail, r.appName, r.id]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q));
  });
}

function syncAppFilter() {
  const select = el("app-filter");
  if (scopedApp) {
    // Nothing to choose between — the scope is fixed by the host app.
    select.hidden = true;
    return;
  }
  const names = [...new Set(reports.map((r) => r.appName))].sort();
  const current = select.value;
  select.innerHTML = '<option value="">All apps</option>';
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  if (names.includes(current)) select.value = current;
}

function render() {
  syncAppFilter();
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
    // Which app this came from is the first thing you need when the list
    // mixes several — give it a chip of its own, colour-keyed per app.
    const project = document.createElement("span");
    project.className = "tag project";
    project.style.setProperty("--project-hue", String(appHue(report.appName)));
    project.textContent = report.appName;
    meta.append(
      project,
      Object.assign(document.createElement("span"), { textContent: fmtTime(report.createdAt) }),
      Object.assign(document.createElement("span"), { textContent: evidenceLabel(report) })
    );

    button.append(top, meta);
    button.addEventListener("click", () => selectReport(report.id));
    li.appendChild(button);
    list.appendChild(li);
  }
}

async function selectReport(id) {
  selectedId = id;
  render();
  releaseObjectUrls();
  detail.innerHTML = "<p class='empty'>Loading…</p>";

  const res = await api(`/api/reports/${encodeURIComponent(id)}`);
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
  const project = document.createElement("span");
  project.className = "tag project";
  project.style.setProperty("--project-hue", String(appHue(report.appName)));
  project.textContent = report.appName;
  const id = document.createElement("span");
  id.className = "muted mono";
  id.textContent = report.id;
  sub.append(project, id);
  detail.appendChild(sub);

  const kv = document.createElement("dl");
  kv.className = "kv";
  const rows = [
    ["App", report.appName],
    ["Source", report.source === "auto-error" ? "Auto-captured error" : "Staff report"],
    ["Reported by", report.reporterEmail || "—"],
    ["Page", report.url || "—"],
    ["When", fmtTime(report.createdAt)],
    ["GlitchTip event", report.glitchtipEventId || "— (staff reports aren't sent to GlitchTip)"],
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
    selectedId = null;
    detail.innerHTML = "<p class='empty'>Report deleted.</p>";
    render();
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
el("app-filter").addEventListener("change", render);
el("source-filter").addEventListener("change", render);
el("refresh").addEventListener("click", () => void refresh());

async function refresh() {
  const res = await api("/api/reports");
  if (res.status === 401) return showGate("Token no longer accepted.");
  reports = await res.json();
  render();
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
  if (scopedApp) {
    document.title = `${scopedApp} — incident reports`;
    el("search").placeholder = `Search ${scopedApp} reports…`;
  }

  const hostToken = await requestTokenFromHost();
  const candidate = hostToken || token;
  if (!candidate) return showGate();

  try {
    if (await unlock(candidate, { persist: !hostToken })) {
      app.hidden = false;
      render();
    } else {
      showGate(hostToken ? "The token this page was given was rejected." : "Saved token was rejected.");
    }
  } catch (err) {
    showGate(err.message);
  }
}

void boot();
