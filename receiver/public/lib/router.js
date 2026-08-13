/**
 * Which screen is showing.
 *
 * Before this, screens were divs hidden and unhidden by hand, and each
 * switcher had to know about every other screen's elements — so adding one
 * meant editing all of them, and none of it survived a reload. GlitchTip's
 * own screens are all addressable; ours were one address with modes.
 *
 * A route owns a path, and the view it names owns what appears. Nothing else
 * hides anything.
 *
 * Paths are written without the mount point: register "/issues/:id" and the
 * URL is /sentinel/issues/123. The mount is one place to change if the
 * viewer ever moves.
 */

const routes = [];
let mountPoint = "/sentinel";
let outlet = null;
let notFound = null;

/** The mounted view and whatever it asked to have torn down. */
let current = null;
/**
 * Bumped on every render. A view that awaits — and they all do, they fetch —
 * can finish after the user has already moved on, and would then paint its
 * data over the screen that replaced it. It compares this on the way out and
 * discards itself if it lost the race.
 */
let generation = 0;
/** Aborted when a render is superseded, so a slow view can give up early. */
let inFlight = null;
/**
 * pathname + search of the last render. A fragment change fires popstate too,
 * and remounting on one would throw away the screen the fragment points into.
 */
let lastKey = null;
let listening = false;

/** "/issues/:id" -> a matcher that yields { id }. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Slashes aren't regex metacharacters, so they survive the escape above
    // unchanged — match ":name" against a plain slash, not an escaped one.
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return "/([^/]+)";
    });
  return { regex: new RegExp(`^${source || "\\/"}\\/?$`), names };
}

export function route(pattern, view) {
  routes.push({ pattern, view, ...compile(pattern) });
}

export function setNotFound(view) {
  notFound = view;
}

/**
 * The part of a pathname below the mount, or null if it isn't below it.
 *
 * The boundary is checked rather than assumed: "/sentinelfoo" starts with
 * "/sentinel" and is not ours, and treating it as "foo" would have us
 * swallow a link meant for somewhere else.
 */
function withinMount(pathname) {
  if (!pathname.startsWith(mountPoint)) return null;
  const rest = pathname.slice(mountPoint.length);
  if (rest !== "" && !rest.startsWith("/")) return null;
  return rest || "/";
}

/** The path within the app, with the mount point removed. */
export function currentPath() {
  const rest = withinMount(location.pathname) ?? location.pathname;
  return rest.replace(/\/+$/, "") || "/";
}

/** Accepts a query string and a fragment; they travel with the path. */
export function href(path) {
  const clean = String(path).startsWith("/") ? String(path) : `/${path}`;
  return `${mountPoint}${clean}`;
}

/** Navigate without a reload. Same URL is a no-op, so links can be naive. */
export function go(path, { replace = false } = {}) {
  const url = href(path);
  if (url === location.pathname + location.search + location.hash) return Promise.resolve();
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  return render({ scroll: !replace });
}

function match(path) {
  for (const entry of routes) {
    const found = entry.regex.exec(path);
    if (!found) continue;
    const params = {};
    entry.names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]);
    });
    return { entry, params };
  }
  return null;
}

/**
 * Teardown is best-effort on purpose. A view whose cleanup throws is a bug in
 * that view; stranding the user on it because the next screen never mounted
 * would be a worse one.
 */
function safely(fn, label) {
  try {
    fn();
  } catch (error) {
    console.warn(`${label} failed`, error);
  }
}

/**
 * Views may return a cleanup function — timers, listeners on document, an
 * object URL to revoke. It runs before the next view mounts, which is the
 * bit hand-rolled switching kept forgetting.
 *
 * Returning it is not enough on its own, and this is the trap: a view opens
 * a dialog, appends a listener to document, starts a fetch — and only then
 * awaits. If that await throws, or is aborted by the navigation that
 * superseded it, the view never reaches its `return cleanup` and the router
 * is handed nothing. The dialog stays on screen over the next screen, the
 * listener stays on document, and nothing knows they exist. So a view can
 * also register cleanups the moment it allocates, through ctx.onCleanup(),
 * and the router honours those on every exit — returned, thrown, aborted or
 * superseded.
 *
 * Both are run, in reverse order of registration, with the returned one
 * first: it's the view's own summary of its teardown, and whatever it
 * registered on the way up is unwound behind it.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - render even if the URL matches the last
 *   one, for refresh() and for the first render at boot.
 * @param {boolean} [options.scroll] - start the new screen at the top, which
 *   a pushed navigation wants and a popped one does not.
 */
async function render({ force = false, scroll = false } = {}) {
  const key = location.pathname + location.search;
  if (!force && key === lastKey) return;
  lastKey = key;

  const token = ++generation;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  if (current?.cleanup) safely(current.cleanup, "view cleanup");
  current = null;
  outlet.replaceChildren();

  const path = currentPath();
  const found = match(path);
  const view = found ? found.entry.view : notFound;
  if (!view) return;

  const cleanups = [];
  const unwind = (label) => {
    while (cleanups.length) safely(cleanups.pop(), label);
  };

  const context = {
    params: found?.params || {},
    query: Object.fromEntries(new URLSearchParams(location.search)),
    hash: location.hash.replace(/^#/, ""),
    path,
    outlet,
    // Pass to fetch, or check before touching the DOM after an await.
    signal: controller.signal,
    /**
     * Hand back a teardown at the moment the thing needing it is created,
     * rather than at the end of a render that may never be reached.
     */
    onCleanup(fn) {
      if (typeof fn === "function") cleanups.push(fn);
    },
  };

  try {
    const cleanup = await view(context);
    if (typeof cleanup === "function") cleanups.push(cleanup);
    // Lost the race: the outlet belongs to someone else now. Still honour
    // whatever this view opened, or it leaks.
    if (token !== generation) return unwind("superseded view cleanup");
    current = { view, cleanup: cleanups.length ? () => unwind("view cleanup") : null };
    if (scroll) window.scrollTo?.(0, 0);
  } catch (error) {
    // Whatever it managed to open before it failed still has to close. This
    // is the whole reason onCleanup exists: a view that throws mid-mount
    // never returns its own teardown.
    unwind(token === generation ? "failed view cleanup" : "superseded view cleanup");
    if (token !== generation) return;
    // An aborted view isn't a failure, it's a view that was told to stop.
    if (error?.name === "AbortError") return;
    console.error("view failed to render", error);
    outlet.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "error",
        textContent: error?.message || "Something went wrong rendering this screen.",
      })
    );
  }
}

/**
 * Mount several views into one route.
 *
 * A dialog that layers over a screen is two views in a single render, and a
 * route hands the router exactly one cleanup — so composing them by hand
 * silently drops whichever cleanup isn't the one returned, and the screen
 * underneath keeps its timers and listeners for the rest of the session.
 *
 * Each one's cleanup is registered as it mounts, so they unwind in reverse
 * and the thing on top goes first. This used to keep its own list and its
 * own try/catch to unwind it, which was the same job render() above now does
 * for every view — including the case that list couldn't see, a view that
 * throws before returning anything at all.
 */
export function layer(...views) {
  return async (ctx) => {
    for (const view of views) {
      ctx.onCleanup(await view(ctx));
    }
  };
}

function onPopState() {
  // Not forced: a fragment-only step in history keeps the screen it lands on.
  void render();
}

/**
 * Anchors are ordinary links — they work with middle-click, "open in new
 * tab" and a screen reader — so navigation is intercepted here rather than
 * every link needing a handler.
 *
 * Everything that isn't a plain left-click on an in-app URL is left to the
 * browser: modified clicks, other mouse buttons, downloads, targeted and
 * rel="external" links, other origins, other protocols, paths outside the
 * mount (GlitchTip's own screens, /admin/), and same-page fragments.
 */
function onClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = event.target?.closest?.("a[href]");
  if (!anchor || anchor.hasAttribute("download")) return;

  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return;
  if ((anchor.getAttribute("rel") || "").split(/\s+/).includes("external")) return;

  let url;
  try {
    url = new URL(anchor.getAttribute("href"), location.href);
  } catch {
    return;
  }
  // mailto: and tel: fail this too — their origin is "null", never ours.
  if (url.origin !== location.origin) return;

  const inside = withinMount(url.pathname);
  if (inside === null) return;

  // Same screen, different fragment: let the browser do the scrolling it
  // already does well, and keep the view mounted.
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;

  event.preventDefault();
  void go(inside + url.search + url.hash);
}

export function start({ mount = "/sentinel", outlet: node } = {}) {
  stop();
  mountPoint = mount.replace(/\/+$/, "");
  outlet = node;
  window.addEventListener("popstate", onPopState);
  document.addEventListener("click", onClick);
  listening = true;
  return render({ force: true });
}

/** Unmount and stop listening. Called by start(), so it can't stack handlers. */
export function stop() {
  if (listening) {
    window.removeEventListener("popstate", onPopState);
    document.removeEventListener("click", onClick);
    listening = false;
  }
  generation += 1;
  inFlight?.abort();
  inFlight = null;
  if (current?.cleanup) safely(current.cleanup, "view cleanup");
  current = null;
  lastKey = null;
}

/** Re-run the current view — after data changes that the view reads on mount. */
export function refresh() {
  return render({ force: true });
}
