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
let current = null;

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

/** The path within the app, with the mount point removed. */
export function currentPath() {
  const path = location.pathname.startsWith(mountPoint)
    ? location.pathname.slice(mountPoint.length)
    : location.pathname;
  return path.replace(/\/+$/, "") || "/";
}

export function href(path) {
  return `${mountPoint}${path === "/" ? "/" : path}`;
}

/** Navigate without a reload. Same path is a no-op, so links can be naive. */
export function go(path, { replace = false } = {}) {
  const url = href(path);
  if (url === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  return render();
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
 * Views may return a cleanup function — timers, listeners on document, an
 * object URL to revoke. It runs before the next view mounts, which is the
 * bit hand-rolled switching kept forgetting.
 */
async function render() {
  const path = currentPath();
  const found = match(path);

  if (current?.cleanup) {
    try {
      current.cleanup();
    } catch (error) {
      console.warn("view cleanup failed", error);
    }
  }
  current = null;
  outlet.replaceChildren();

  const view = found ? found.entry.view : notFound;
  if (!view) return;

  const query = Object.fromEntries(new URLSearchParams(location.search));
  const context = { params: found?.params || {}, query, path, outlet };

  try {
    const cleanup = await view(context);
    current = { view, cleanup: typeof cleanup === "function" ? cleanup : null };
  } catch (error) {
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
 * Anchors are ordinary links — they work with middle-click, "open in new
 * tab" and a screen reader — so navigation is intercepted here rather than
 * every link needing a handler.
 */
function interceptLinks() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    if (!url.pathname.startsWith(mountPoint)) return;

    event.preventDefault();
    go(url.pathname.slice(mountPoint.length) + url.search);
  });
}

export function start({ mount = "/sentinel", outlet: node } = {}) {
  mountPoint = mount.replace(/\/+$/, "");
  outlet = node;
  window.addEventListener("popstate", () => void render());
  interceptLinks();
  return render();
}

/** Re-run the current view — after data changes that the view reads on mount. */
export function refresh() {
  return render();
}
