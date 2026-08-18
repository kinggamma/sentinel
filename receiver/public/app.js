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

import { sentinel as sentinelApi, useBearerToken, handleUnauthorized } from "./lib/api.js";
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
import { settingsView } from "./views/settings.js";
import { projectsView } from "./views/projects.js";
import { reportsView } from "./views/reports.js";
import { projectsListView, projectDetailView, projectNewView } from "./views/project.js";
import { peopleView } from "./views/people.js";
import { teamsListView, teamNewView, teamDetailView } from "./views/teams.js";
import { issuesListView, issueDetailView, issueTagsView } from "./views/issues.js";
import {
  signInView,
  signUpView,
  passwordRequestView,
  passwordResetView,
  mfaView,
  accessView,
  acceptInviteView,
} from "./views/auth.js";
import { session, forget as forgetSession } from "./lib/session.js";
import { reportPresence, stopReportingPresence } from "./lib/presence.js";
import { activeOrg, remember, withOrg } from "./lib/org.js";

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
/**
 * What a route needs, and where you go if you haven't got it.
 *
 * Every screen behind this asks the same question of the same answer — the
 * server's, already reduced to `can` — so no screen works out for itself
 * whether somebody may be here. That was the old shape: a boot sequence
 * decided once, and every screen after it assumed.
 *
 * Where you were trying to go travels with you as ?next=, so signing in
 * returns you to the report you followed a link to rather than to the
 * landing screen. auth.js refuses to honour a `next` that leaves this app.
 */
function guarded(view, { needs = "canRead" } = {}) {
  return async (ctx) => {
    const me = await session();

    if (me.can?.[needs]) {
      paintShell({ signedIn: true });
      // Which organisation this screen is about. Re-decided on every render
      // because the address can say, and a link to one organisation's issue
      // list must not open somebody else's just because that is the one this
      // browser last chose.
      organisations = me.orgs || [];
      organisation = activeOrg({ orgs: organisations, query: ctx.query });
      el("nav-issues").hidden = !organisation;
      paintOrg();
      await ensureData();
      void refreshRequestCount();
      return view(ctx, me);
    }

    const here = ctx.path + (location.search || "");
    const to = (path) => goRoute(`${path}?next=${encodeURIComponent(here)}`, { replace: true });

    switch (me.state) {
      case "pending":
      case "denied":
        return goRoute("/access", { replace: true });
      case "mfa_required":
        return to("/mfa");
      case "unreachable":
        // Not signed out — unknown. Sending someone to a sign-in form
        // because a request timed out is how a blip becomes a lost session.
        paintShell({ signedIn: false });
        return fill(
          ctx.outlet,
          h("div", { className: "gate" },
            h("section", { className: "gate-card" },
              h("h1", { text: "Can't reach Sentinel" }),
              h("p", { className: "muted", text: "It answered nothing. Reload in a moment." })))
        );
      default:
        return to("/signin");
    }
  };
}

/**
 * Auth screens are the whole window: no sidebar to navigate with, because
 * there is nothing yet to navigate, and no page header because the card says
 * what it is.
 */
function paintShell({ signedIn }) {
  app.hidden = false;
  viewOutlet.hidden = false;
  app.classList.toggle("signed-in", signedIn);
  el("sidebar").hidden = !signedIn;
  el("topbar").hidden = !signedIn;
}

const landing = (ctx) => {
  // Every route repaints the chrome, because the chrome describes the route.
  // Arriving at /settings from an app's reports, the breadcrumb still named
  // that app until this line: the topbar was only ever repainted by the two
  // routes that happened to remember to.
  paintChrome();
  return scopedApp
    ? undefined
    : projectsView(ctx, {
        onOpenReports: showReports,
        hueFor: appHue,
        org: organisation,
        orgs: organisations,
      });
};

// layer() rather than calling one and returning the other: two views in one
// render produce two cleanups, and a route hands the router only one. The
// card timers behind the dialog were being left running.
/**
 * The auth screens. Unguarded by definition — they are how you stop being
 * unauthorised — and they hide the topbar, because a sign-in form under a
 * navigation bar for an app you cannot see is a strange thing to look at.
 */
const openRoute = (view) => (ctx) => {
  paintShell({ signedIn: false });
  return view(ctx);
};
route("/signin", openRoute(signInView));
route("/signup", openRoute(signUpView));
route("/password/request", openRoute(passwordRequestView));
route("/password/reset", openRoute(passwordResetView));
// The path form of the same screen, matching the shape GlitchTip's emailed
// link already uses, so Phase 9 can point those links here with a Caddy rule.
route("/password/reset/:key", openRoute(passwordResetView));
route("/mfa", openRoute(mfaView));
// Matching GlitchTip's own /accept/<org user id>/<token>/, so Phase 9 points
// the emailed links here with a Caddy rule rather than a rewrite.
route("/accept/:orgUserId/:token", openRoute((ctx) =>
  acceptInviteView(ctx, { onAccepted: invalidateData })
));

/**
 * Signed in, with nowhere to go. Its own address rather than a mode, so that
 * being approved and reloading lands somewhere real.
 */
route("/access", async (ctx) => {
  const me = await session();
  if (me.can?.canRead) return goRoute("/", { replace: true });
  if (!me.can?.canRequestAccess) return goRoute("/signin", { replace: true });

  paintShell({ signedIn: false });
  return accessView(ctx, {
    me,
    onRequest: (note) => sentinelApi.post("/access/request", { note }),
    onSignOut: signOut,
  });
});

// The queue moved into People (Phase 5), where the people asking and the
// people already in sit in one list. The address stays, because it was
// linkable and because a badge in somebody's bookmark bar should not 404.
route("/requests", guarded(() => goRoute("/people", { replace: true })));
route("/settings", guarded(layer(landing, (ctx) => settingsView(ctx))));
// A per-app save changes what a project card shows (its origin count, or —
// for "add an app" — whether the card exists at all), so it's the one
// caller that needs to know when settingsView has saved something.
// /settings/apps/:app was where one app's addresses were edited. That is
// part of the project's own screen now (views/project.js), so the address
// redirects rather than 404ing — it was linkable, and links outlive screens.
route("/settings/apps/:app", guarded(async (ctx) => {
  const app = ctx.params.app;
  const forApp = (await sentinelApi.get("/projects", { signal: ctx.signal }).catch(() => null))
    ?.projects?.find((one) => one.appName === app);
  return goRoute(
    forApp?.glitchtipProject
      ? withOrg(`/projects/${encodeURIComponent(forApp.glitchtipProject)}`, organisation, { orgs: organisations })
      : "/settings",
    { replace: true }
  );
}));
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
const issuesRoute = (view) => (ctx, me) => {
  paintChrome();
  // The signed-in address comes from the guard, which already asked. A note
  // on an issue is signed, and only its author is offered a way to remove
  // it — GlitchTip enforces that too, but a button that always fails is its
  // own kind of rude.
  return view(ctx, { org: organisation, orgs: organisations, me: me?.email || null });
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

/**
 * Projects, which are GlitchTip's and Sentinel's at once: a project's keys
 * and alert rules live there, its reports and allowed origins live here, and
 * this is the screen that stops those being two places.
 */
const projectsRoute = (view) => (ctx, me) => {
  paintChrome();
  return view(ctx, { org: organisation, orgs: organisations, me });
};

route("/people", guarded(projectsRoute(peopleView)));

route("/teams", guarded(projectsRoute(teamsListView)));
// Before :slug, which would otherwise match "new" as a team.
route("/teams/new", guarded(projectsRoute(teamNewView)));
route("/teams/:slug", guarded(projectsRoute(teamDetailView)));

route("/projects", guarded(projectsRoute(projectsListView)));
// Before the :slug route, which would otherwise match "new" as a project.
route("/projects/new", guarded(projectsRoute(projectNewView)));
route("/projects/:slug", guarded(projectsRoute(projectDetailView)));

route("/issues", guarded(issuesRoute(issuesListView)));
route("/issues/:id", guarded(issuesRoute(issueDetailView)));
// Every value of every tag, which the detail screen only summarises.
route("/issues/:id/tags", guarded(issuesRoute(issueTagsView)));

route("/reports/:app", guarded(reportsRoute));
route("/reports/:app/:id", guarded(reportsRoute));

if (!scopedApp) {
  // hueFor is app.js's own appHue(), not a copy: it's keyed off appNames,
  // which spans both projects and reports, so an app with reports but no
  // project record still gets the same colour here as it does on a report
  // row's project chip. A card's own idea of "which apps exist" would only
  // ever see the project half of that list.
  route("/", guarded((ctx) => {
    paintChrome();
    return projectsView(ctx, {
      onOpenReports: showReports,
      hueFor: appHue,
      org: organisation,
      orgs: organisations,
    });
  }));
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
const app = el("app");
// The router's outlet. Every full-page screen renders here now — there is
// no second <main> to keep in step with it, and no mode that decides which
// of the two is showing.
const viewOutlet = el("view");

/** Only set when embedded: the shared staff token, from the host page. */
let bearerToken = "";

/**
 * The organisation currently being looked at, and every organisation this
 * account belongs to.
 *
 * Both, because they answer different questions: one decides which errors
 * are fetched, the other decides whether there is a choice to offer. Chosen
 * per render from the URL, this browser's last choice, or the first — see
 * lib/org.js — rather than being fixed to orgs[0], which was right for one
 * organisation and silently wrong for two.
 */
let organisation = null;
let organisations = [];

/** What this installation has switched on, for gating the links below. */
let features = { enabledFeatures: [], glitchtipUrl: null };

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

/**
 * Signing in, signing out, and the screens around them moved to
 * views/auth.js and their own addresses. What was here — showGate(),
 * describeSignIn(), paintSignIn(), passwordSignIn(), the gate form's
 * handlers, showWaiting() and paintWaiting() — was one screen pretending to
 * be several by unhiding parts of itself, and it could not answer the one
 * question a password reset link asks: what address does this land on.
 */

/** Ends the session at GlitchTip, which ends it here — there is only one. */
async function signOut() {
  stopReportingPresence();
  await sentinelApi.post("/auth/logout", null).catch(() => {});
  forgetSession();
  projects = [];
  reports = [];
  await goRoute("/signin", { replace: true });
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

// ------------------------------------------------------------------ data

async function loadData() {
  const [projectsRes, reportsRes] = await Promise.all([api("/sentinel/api/projects"), api("/sentinel/api/reports")]);

  // A session that died between the guard and here. lib/api.js's central
  // handler owns what to do about it; this only has to stop pretending it
  // loaded something.
  if (projectsRes.status === 401 || reportsRes.status === 401) {
    throw new Error("that session was refused");
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

/**
 * Which section a path belongs to. One place, so the sidebar and anything
 * else that cares agree about it.
 */
function sectionFor(path) {
  if (path.startsWith("/issues")) return "issues";
  if (path.startsWith("/projects")) return "projects";
  if (path.startsWith("/people")) return "people";
  if (path.startsWith("/teams")) return "people";
  if (path.startsWith("/requests")) return "people";
  if (path.startsWith("/settings")) return "settings";
  if (path === "/" || path.startsWith("/reports")) return "reports";
  // Somewhere that isn't a section. Falling through to "reports" would have
  // the sidebar claim you were on a screen you are not on, and the header
  // announce a page that failed to load as "Your apps".
  return null;
}

/**
 * The organisation, and everything that depends on which one it is.
 *
 * With one, its name. With several, a control — because the alternative is
 * that the others have no address at all, which is what "orgs[0] and nothing
 * else" quietly meant.
 */
function paintOrg() {
  const name = el("org-name");
  const switcher = el("org-switch");
  const several = organisations.length > 1;

  name.hidden = several || !organisation;
  name.textContent = organisation || "";

  switcher.hidden = !several;
  if (several) {
    fill(
      switcher,
      organisations.map((slug) => h("option", { value: slug, text: slug }))
    );
    switcher.value = organisation || organisations[0];
  }

  paintExternalLinks();
}

/**
 * The parts of the product that are still GlitchTip's own screens.
 *
 * Real links to real pages, per organisation, rather than a nav of things
 * that do not exist — each becomes an internal route as its phase lands.
 * Uptime and Logs are optional, so they are shown only where GlitchTip says
 * they are switched on; offering a link to a feature an installation does
 * not have is the same mistake as offering one to a screen not yet written.
 */
function paintExternalLinks() {
  const root = (features.glitchtipUrl || glitchtipRoot || "").replace(/\/+$/, "");
  const enabled = features.enabledFeatures || [];

  // Projects left this list in Phase 4 — it is a screen here now, and a
  // link to somebody else's version of a screen we have is worse than none.
  const links = [
    ["nav-performance", organisation && `${root}/${organisation}/performance`, true],
    ["nav-uptime", organisation && `${root}/${organisation}/uptime-monitors`, enabled.includes("uptime")],
    ["nav-logs", organisation && `${root}/${organisation}/logs`, enabled.includes("logs")],
    ["nav-releases", organisation && `${root}/${organisation}/releases`, true],
    ["nav-org-settings", organisation && `${root}/${organisation}/settings`, true],
    ["nav-profile", root && `${root}/profile`, true],
  ];

  let anyShown = false;
  for (const [id, href, allowed] of links) {
    const node = el(id);
    const show = Boolean(root && href && allowed);
    node.hidden = !show;
    if (show) node.href = href;
    anyShown = anyShown || show;
  }
  // A heading over nothing is worse than no heading.
  el("nav-external-heading").hidden = !anyShown;
}

/** The chrome, for whatever the route is showing. */
function paintChrome() {
  const appName = routedApp();
  const path = currentPath();
  const section = sectionFor(path);

  // Where you are is a fact about the path, not a variable a click handler
  // has to remember to set.
  for (const [id, name] of [
    ["nav-issues", "issues"],
    ["nav-projects", "projects"],
    ["nav-people", "people"],
    ["nav-reports", "reports"],
    ["nav-settings", "settings"],
  ]) {
    el(id).classList.toggle("current", section === name);
    // Announced as well as coloured: "selected" that only exists in the
    // styling is invisible to anyone not looking at it.
    if (section === name) el(id).setAttribute("aria-current", "page");
    else el(id).removeAttribute("aria-current");
  }

  /**
   * What this screen is.
   *
   * With navigation in the sidebar the header had nothing left to say, and
   * an empty bar with one button in it looks like something failed to load.
   * It names the page instead — the app you are looking at when that is the
   * answer, and the section otherwise.
   */
  const titles = {
    issues: "Issues",
    requests: "Access requests",
    settings: "Settings",
    reports: appName || "Your apps",
  };
  const heading = titles[section] || "";

  const crumb = el("crumb");
  crumb.hidden = !heading;
  crumb.textContent = heading || "";
  document.title = appName ? `${appName} — Sentinel` : "Sentinel";

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
//
// The screen is views/auth.js's accessView, at /access. It was three blocks
// of shell markup and two functions that unhid parts of them; being approved
// and reloading now lands somewhere real instead of on a screen that had no
// address to return to.


// ------------------------------------------------------- access requests
//
// The queue is part of views/people.js now. Registered
// down in boot(), where the router starts — this comment marks where it
// used to live so the history of what moved is easy to find later.

/** Only worth offering when there's something to decide. */
async function refreshRequestCount() {
  if (embedded) return;
  const res = await api("/sentinel/api/access/requests");
  if (!res.ok) return;
  const body = await res.json().catch(() => ({}));
  const pending = (body.requests || []).filter((r) => r.status === "pending").length;
  // On People, because that is where deciding happens. Nothing is hidden
  // when the queue is empty — People is a real destination either way, and a
  // nav entry that comes and goes is harder to find than one that stays.
  const link = el("nav-people");
  link.textContent = pending ? `People (${pending})` : "People";
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

el("refresh").addEventListener("click", () => void refresh());

/**
 * Changing organisation is a navigation, not a mode.
 *
 * The address carries it, so the screen you are looking at can be sent to
 * somebody and open the same way for them; the choice is also remembered, so
 * the next plain link opens where you left off.
 */
el("org-switch").addEventListener("change", (event) => {
  const slug = event.target.value;
  if (!slug || !organisations.includes(slug)) return;
  remember(slug);
  invalidateData();
  void goRoute(withOrg(currentPath() + location.search, slug, { orgs: organisations }));
});
el("forget").addEventListener("click", () => void signOut());

async function refresh() {
  invalidateData();
  try {
    await ensureData();
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
 * land() used to ask what this session was and pick a screen. Every route
 * asks now, through guarded(), which is the difference between deciding once
 * at boot and deciding for the screen actually being opened — a bookmark
 * straight to a report was previously decided by a boot sequence that had
 * already run.
 */


/**
 * The report data the landing screen and the report screens read from.
 *
 * Loaded once and shared, rather than by whichever screen happens to be
 * first: appHue() colours an app the same on its card and on every row
 * inside it, which it can only do from one list of every app that exists.
 */
let loading = null;
function ensureData() {
  if (!loading) {
    loading = loadData().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

/** After anything that changes what the data is. */
function invalidateData() {
  loading = null;
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

  /**
   * One answer to a credential that stopped working, for every fetch any
   * view makes. Embedded says so plainly; a browser session goes back to the
   * sign-in screen, carrying where it was so it can return there.
   *
   * The allauth client is exempt by construction (lib/api.js) and so is
   * /auth/me (lib/session.js): both answer 401 as part of a conversation
   * about whether anyone is signed in, and treating that as "your session
   * has gone" would be a loop.
   */
  handleUnauthorized(() => {
    forgetSession();
    invalidateData();
    if (embedded) return;
    const here = currentPath() + (location.search || "");
    if (here.startsWith("/signin")) return;
    void goRoute(`/signin?next=${encodeURIComponent(here)}`, { replace: true });
  });

  /**
   * If this installation signs idle sessions out, start saying we are here.
   *
   * Only for a browser session: the embedded viewer authenticates with a
   * header on every request and has no session to expire, so a heartbeat
   * from it would be reporting on nothing.
   */
  if (!embedded) {
    try {
      const idle = await sentinelApi.get("/auth/idle", { signalUnauthorized: false });
      if (idle?.enabled) reportPresence();
    } catch {
      // Not knowing means not reporting, which is the safe direction: the
      // receiver decides, and it will simply see no activity.
    }
  }

  // Embedded: the host hands us the shared staff token, and there is no
  // sign-in screen in an iframe. It authenticates by header and holds no
  // session, which is why it skips every guard above.
  const hostToken = await requestTokenFromHost();
  if (hostToken) {
    bearerToken = hostToken;
    useBearerToken(hostToken);
  }

  // Started before anything navigates: every routeHref() the views build
  // resolves against the mount, which would otherwise still be the default
  // "/sentinel" on the standalone port.
  /**
   * Which optional features exist here, and where GlitchTip's own screens
   * are. Read once: both change only when GlitchTip is reconfigured, which
   * restarts it.
   *
   * Deliberately not awaited. It decides nothing except which links the
   * sidebar's second block can offer, and paintOrg() puts them up whenever
   * the answer arrives — so waiting for it here would delay the first paint
   * of every screen, sign-in included, on two requests that screen does not
   * need. Awaiting it did exactly that, and made a sign-in test that checks
   * the screen the instant it loads start losing a race it used to win.
   */
  void Promise.all([
    fetch("/api/settings/", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    sentinelApi.get("/auth/config", { signalUnauthorized: false }).catch(() => null),
  ]).then(([settings, config]) => {
    features = {
      enabledFeatures: settings?.enabledFeatures || [],
      glitchtipUrl: config?.glitchtipUrl || null,
    };
    paintExternalLinks();
  });

  await startRouter({ outlet: viewOutlet, mount: MOUNT });


  // Static markup in index.html, so it can't read MOUNT itself.
  el("nav-settings").href = routeHref("/settings");
  el("nav-issues").href = routeHref("/issues");
  el("nav-projects").href = routeHref("/projects");
  el("nav-people").href = routeHref("/people");
  // A scoped session has no "all projects" to go home to, so both of these
  // point at the one app it is allowed to show.
  const home = routeHref(scopedApp ? `/reports/${encodeURIComponent(scopedApp)}` : "/");
  el("nav-reports").href = home;
  el("home-link").href = home;

  if (!embedded && params.get("view") === "requests") {
    // Arrived from GlitchTip's "Requests" nav item, which still links to the
    // old query-param address.
    await goRoute("/requests", { replace: true });
    return;
  }

  // A scoped session is pinned to one app and boots at "/", which has no
  // route in that mode — so it needs sending on. The query travels with it:
  // ?app= and ?embed= are how a reload inside the iframe knows what it is.
  if (scopedApp && currentPath() === "/") {
    await goRoute(`/reports/${encodeURIComponent(scopedApp)}${location.search}`, {
      replace: true,
    });
  }
}


void boot();
