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

import { useBearerToken, handleUnauthorized } from "./lib/api.js";
import { h, fill } from "./lib/dom.js";
import {
  route,
  layer,
  start as startRouter,
  go as goRoute,
  refresh as refreshRoute,
  stop as stopRouter,
  setNotFound,
  currentPath,
  href as routeHref,
} from "./lib/router.js";
import { requestsView } from "./views/requests.js";
import { settingsView } from "./views/settings.js";
import { projectsView } from "./views/projects.js";
import { reportsView } from "./views/reports.js";
import { issuesListView, issueDetailView } from "./views/issues.js";

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
 * Composed with layer() rather than painted directly from enter(), because
 * going through the router is what earns the abort signal, the staleness
 * check, and a teardown that covers both views:
 * navigate away mid-fetch and this render is cancelled and discarded, where
 * a hand-rolled paint would land on whatever screen replaced it.
 *
 * It does mean "/" → "/requests" re-fetches the projects behind the dialog.
 * One small GET for a background that is definitely current, rather than a
 * cache to invalidate.
 */
const landing = (ctx) => {
  // Every route repaints the chrome, because the chrome describes the route.
  // Arriving at /settings from an app's reports, the breadcrumb still named
  // that app until this line: the topbar was only ever repainted by the two
  // routes that happened to remember to.
  paintChrome();
  return scopedApp ? undefined : projectsView(ctx, { onOpenReports: showReports, hueFor: appHue });
};

// layer() rather than calling one and returning the other: two views in one
// render produce two cleanups, and a route hands the router only one. The
// card timers behind the dialog were being left running.
route("/requests", layer(landing, requestsView));
route("/settings", layer(landing, (ctx) => settingsView(ctx)));
// A per-app save changes what a project card shows (its origin count, or —
// for "add an app" — whether the card exists at all), so it's the one
// caller that needs to know when settingsView has saved something.
route("/settings/apps/:app", layer(landing, (ctx) => settingsView(ctx, { onSaved: refresh })));
// Scoped and embedded sessions are locked to one app's reports and have no
// "all projects" to come home to — showProjects() already refused to show
// it for the same reason, this is that same refusal at the address level.
// Reports has an address per app, and per report inside it. Chrome is
// painted from the route rather than from a `view` variable, so there is one
// answer to "what is showing" and the URL is it.
const reportsRoute = (ctx) => {
  paintChrome();
  return reportsView(ctx, {
    hueFor: appHue,
    onChanged: () => void loadData(),
    // Embedded and scoped sessions are pinned to the app their host page is
    // about, so a report id from anywhere else is refused rather than
    // followed.
    lockedTo: scopedApp,
  });
};
/**
 * Errors, from GlitchTip, under whichever organisation this account belongs
 * to. The org is discovered at sign-in (enter(), below) rather than known at
 * module load, so the routes read it when they run.
 */
const issuesRoute = (view) => (ctx) => {
  paintChrome();
  return view(ctx, { org: organisation });
};
/**
 * Anything else. The router has always supported this and nothing ever
 * registered one, so a typo past the mount rendered an empty outlet inside a
 * complete shell — which reads as a screen that failed to load rather than
 * an address that doesn't exist.
 */
setNotFound(({ outlet, path }) => {
  paintChrome();
  fill(
    outlet,
    h(
      "div",
      { className: "not-found" },
      h("h2", { text: "That page doesn't exist" }),
      h("p", { className: "muted mono", text: path }),
      h("a", {
        className: "button-link",
        href: routeHref(scopedApp ? `/reports/${encodeURIComponent(scopedApp)}` : "/"),
        text: scopedApp ? "Back to reports" : "Back to your apps",
      })
    )
  );
});

route("/issues", issuesRoute(issuesListView));
route("/issues/:id", issuesRoute(issueDetailView));

route("/reports/:app", reportsRoute);
route("/reports/:app/:id", reportsRoute);

if (!scopedApp) {
  // hueFor is app.js's own appHue(), not a copy: it's keyed off appNames,
  // which spans both projects and reports, so an app with reports but no
  // project record still gets the same colour here as it does on a report
  // row's project chip. A card's own idea of "which apps exist" would only
  // ever see the project half of that list.
  route("/", (ctx) => {
    paintChrome();
    return projectsView(ctx, { onOpenReports: showReports, hueFor: appHue });
  });
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
// The router's outlet. Every full-page screen renders here now — there is
// no second <main> to keep in step with it, and no mode that decides which
// of the two is showing.
const viewOutlet = el("view");

/** Only set when embedded: the shared staff token, from the host page. */
let bearerToken = "";

/**
 * The GlitchTip organisation this account browses errors under. Discovered at
 * sign-in, read by the issue routes when they run — they're registered at
 * module load, long before anyone has signed in.
 */
let organisation = null;

let projects = [];
let reports = [];
let appNames = [];
let glitchtipRoot = null;


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

// ---------------------------------------------------------------- sign-in

function showGate(message) {
  // Hiding the app is not stopping it. The router kept its listeners on
  // document and kept the last view mounted behind the sign-in screen — a
  // replay still playing, its timers still running, and every link click on
  // this page still intercepted by a router whose session has gone.
  stopRouter();
  app.hidden = true;
  gate.hidden = false;
  const err = el("gate-error");
  err.hidden = !message;
  err.textContent = message || "";
  el("email-input").focus();
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
  const help = el("gate-help");

  if (config.glitchtipEnabled) {
    help.textContent = config.glitchtipOrg
      ? `Use your GlitchTip account. It has to belong to the ${config.glitchtipOrg} organisation.`
      : "Use your GlitchTip account.";
    return;
  }

  /**
   * No GlitchTip, no session, no way in — and saying so is better than a
   * form that cannot work.
   *
   * The staff token used to cover this case, because Sentinel could mint a
   * session of its own from it. It cannot any more: there is one session and
   * GlitchTip creates it. Apps still post reports with that token and the
   * embedded viewer still reads with it, both by header; it is only the
   * browser sign-in that has gone.
   */
  help.textContent =
    "This Sentinel has no GlitchTip configured, so there is no account to sign in with. " +
    "Set GLITCHTIP_URL and restart it.";
  el("password-submit").disabled = true;
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
      // allauth has created the session, and it is the only one there is —
      // there is no second sign-in to perform against Sentinel any more.
      return await land();
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

// The token sign-in form and its submit handler lived here. A personal auth
// token is an API credential and cannot create a browser session, so it can
// no longer be a way in; email and password go to allauth, which creates the
// one session there is.

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

// ------------------------------------------------------- projects landing
//
// The screen itself is views/projects.js, mounted by the router at "/".
// appHue() and projectChip() above stay here — Reports still uses them for
// its own project chips, and projects.js is handed appHue() directly as
// hueFor() (see the route registration) rather than keeping its own copy.

// ------------------------------------------------------------- navigation

/**
 * Which app the current route is showing, or "" for the landing screen.
 *
 * Derived from the path rather than tracked alongside it. The old pair of
 * `view` and `selectedApp` had to be kept in step with what was on screen by
 * every function that changed either, and the address bar was a third copy
 * that could disagree with both.
 */
function routedApp() {
  const found = currentPath().match(/^\/reports\/([^/]+)/);
  return found ? decodeURIComponent(found[1]) : "";
}

/** The topbar, for whatever the route is showing. */
function paintChrome() {
  const appName = routedApp();
  const onIssues = currentPath().startsWith("/issues");

  // Which half of the app is showing is a fact about the path now, not a
  // variable a click handler had to remember to set. There is nothing left
  // to hide either: both halves render into the same outlet.
  el("tab-issues").classList.toggle("selected", onIssues);
  el("tab-reports").classList.toggle("selected", !onIssues);

  const crumb = el("crumb");
  crumb.hidden = onIssues || !appName;
  crumb.textContent = appName ? `/ ${appName}` : "";
  document.title = appName ? `${appName} — Sentinel` : "Sentinel";

  // Scoped to one app by its host: there is no "all projects" to go back to.
  el("home-link").disabled = Boolean(scopedApp) || !appName;

  const url = appName ? projectFor(appName)?.glitchtipUrl || glitchtipRoot : glitchtipRoot;
  const link = el("glitchtip-link");
  link.hidden = !url;
  if (url) link.href = url;
}

/**
 * Both are navigations now. What used to be a mode change with three
 * elements to hide is a URL, and the router does the rest.
 */
function showProjects() {
  if (scopedApp) return;
  void goRoute("/");
}

function showReports(appName) {
  // The query survives the navigation: embedded sessions carry ?app= and
  // ?embed= in it, and a reload inside the iframe has to still find them.
  void goRoute(`/reports/${encodeURIComponent(appName || "")}${location.search}`);
}

// ------------------------------------------------------- awaiting access

const waiting = el("waiting");

/**
 * Someone with a GlitchTip account and no organisation. They can't be shown
 * reports, but a dead end is the wrong answer — GlitchTip has no way to ask
 * for access, so this is it.
 */
async function showWaiting(identity) {
  // Same transition as showGate(): whatever was mounted is behind this
  // screen now, and nothing behind a screen should still be running.
  stopRouter();
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
//
// Issues and Reports were tabs toggling two <main> elements by hand, with a
// `section` variable deciding which. They're two routes now — the tabs are
// ordinary links in index.html, and paintChrome() reads which one is current
// off the path. showSection() is gone rather than moved.

// ---------------------------------------------------------- settings
//
// The screen itself is views/settings.js, mounted by the router — both
// "/settings" (global) and "/settings/apps/:app" (one app, opened from
// its project card). Registered down in boot(), alongside requests.
// ------------------------------------------------------------- wiring

const themeToggle = el("theme-toggle");

function labelThemeToggle(theme) {
  const icons = { light: "☀︎ Light", dark: "☾ Dark", system: "◐ System" };
  themeToggle.textContent = icons[theme] || icons.system;
}

themeToggle.addEventListener("click", () => labelThemeToggle(cycleTheme()));

el("home-link").addEventListener("click", () => showProjects());
el("refresh").addEventListener("click", () => void refresh());

async function refresh() {
  try {
    if (!(await loadData())) return;
  } catch (err) {
    fill(viewOutlet, h("p", { className: "error", text: err.message }));
    return;
  }
  // The app we were looking at may have had its last report deleted. Going
  // home re-runs the landing view, so it can't show the app that just
  // stopped existing.
  const appName = routedApp();
  if (appName && !projectFor(appName) && !scopedApp) return void goRoute("/");

  paintChrome();
  void refreshRoute();
}

/**
 * Ask what this session is, and show the screen that belongs to the answer.
 *
 * One question, one place. Before this there were three ways in — a session
 * check, a silent sign-in, and a token form — each deciding for itself what
 * to show, which is why "you belong to no organisation" could survive being
 * approved: nothing re-asked.
 */
async function land() {
  let me;
  try {
    const res = await fetch("/sentinel/api/auth/me", { credentials: "same-origin" });
    me = res.ok ? await res.json() : null;
  } catch {
    me = null;
  }

  if (!me) return showGate("Couldn't reach Sentinel to check your session.");

  switch (me.state) {
    case "authenticated":
      return enter(me);
    case "pending":
    case "denied":
      return showWaiting(me);
    case "disabled":
      return showGate("That account has been switched off.");
    case "expired":
      return showGate("You were signed out.");
    case "mfa_required":
      // Its own screen arrives with the MFA flow; until then, saying so is
      // better than a blank sign-in form that discards the half-finished
      // login behind it.
      return showGate("Finish signing in — a second factor is outstanding.");
    default:
      return showGate("");
  }
}

/** Past the gate: load everything, then land on the right view. */
async function enter(me = null) {
  gate.hidden = true;
  waiting.hidden = true;
  app.hidden = false;
  // The outlet starts hidden so the shell isn't a bare empty frame before
  // anything has been signed into. From here on its visibility is the tab's
  // business (paintChrome), not any individual route's — routes that layer a
  // dialog over the landing screen never call it.
  viewOutlet.hidden = false;
  if (!(await loadData())) return;
  void refreshRequestCount();

  // Issues live under an organisation. land() already asked; only a caller
  // that skipped it has to ask again.
  if (!me) {
    me = await fetch("/sentinel/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  organisation = (me?.orgs || [])[0] || null;
  // Nothing to browse errors under — the staff token, typically.
  el("tab-issues").hidden = !organisation;
  // The router runs in both modes now. It used to be skipped when embedded,
  // on the grounds that an iframe has no address bar to route within — but
  // embedded is nothing *but* Reports, and Reports is a route. The iframe
  // does have a URL, it just isn't on display; navigations inside it replace
  // rather than push, so the host page's back button stays out of it.
  //
  // Started before the first navigation below: every routeHref() link the
  // views build resolves against the mount, which would otherwise still be
  // the default "/sentinel" on the standalone port.
  await startRouter({ outlet: viewOutlet, mount: MOUNT });

  // Static markup in index.html, so it can't read MOUNT itself. Set in both
  // modes: embedded runs on the standalone root, where the mount is empty,
  // and the router now intercepts these links there too — left at the
  // literal "/sentinel/settings" it would route to a path that matches
  // nothing and blank the screen.
  el("requests-open").href = routeHref("/requests");
  el("settings-open").href = routeHref("/settings");
  el("tab-issues").href = routeHref("/issues");
  // A scoped session has no "all projects" to go home to, so its Reports tab
  // points at the one app it is allowed to show.
  el("tab-reports").href = routeHref(
    scopedApp ? `/reports/${encodeURIComponent(scopedApp)}` : "/"
  );

  if (!embedded) {
    // Arrived from GlitchTip's "Requests" nav item (glitchtip/index.html),
    // which still links to the old query-param address. Land on the real
    // one instead of teaching the router about a second spelling of it.
    if (params.get("view") === "requests") {
      await goRoute("/requests", { replace: true });
      return;
    }
  }

  // A scoped session is pinned to one app and boots at "/", which has no
  // route registered for it in that mode — so it needs sending on.
  if (scopedApp) {
    await goRoute(`/reports/${encodeURIComponent(scopedApp)}${location.search}`, {
      replace: true,
    });
  }
}

async function boot() {
  // One answer to a rejected credential, for every fetch any view makes.
  // The allauth client is exempt (lib/api.js): its 401s are conversation,
  // not refusal.
  handleUnauthorized(() =>
    showGate(
      embedded ? "The token this page was given was rejected." : "Your session has expired."
    )
  );

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
    // The views fetch through lib/api.js, which keeps its own copy — the
    // embedded viewer has no cookie, so without this every screen it renders
    // is anonymous.
    useBearerToken(hostToken);
    try {
      await enter();
    } catch (err) {
      showGate(err.message);
    }
    return;
  }

  // One question now, and the answer is a state. Being signed in to
  // GlitchTip in this browser *is* being signed in here, so there is no
  // silent second sign-in to attempt and nothing to fall through to.
  await describeSignIn();
  await land();
}

void boot();
