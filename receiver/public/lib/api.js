/**
 * One way to call either backend.
 *
 * Two live behind the same origin and this is the only thing that knows the
 * difference: the receiver owns reports, replays, access requests and
 * settings under /sentinel/api; GlitchTip owns errors, projects,
 * organisations and auth under /api/0 and /_allauth. A screen asks for
 * `sentinel.get("/projects")` or `glitchtip.get("/organizations/x/issues/")`
 * and doesn't carry the routing rules around with it.
 *
 * Everything callers used to repeat lives here now: parsing the body,
 * throwing on failure with the server's own message, attaching CSRF to
 * session writes, and handling 401 once rather than at a dozen call sites.
 */

/** Thrown for any non-2xx, carrying enough to decide what to say. */
export class ApiError extends Error {
  constructor(message, { status, body, url }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * Django's CSRF cookie is deliberately readable — echoing it back is the
 * whole protocol. Session-authenticated writes are rejected without it, and
 * the failure is a bare 403 that says nothing, so it's applied centrally.
 */
export function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

let onUnauthorized = null;

/** What to do when a session has gone: set once, at boot. */
export function handleUnauthorized(handler) {
  onUnauthorized = handler;
}

/** Only set when embedded in an app's admin, where a host page holds it. */
let bearerToken = "";

export function useBearerToken(token) {
  bearerToken = token || "";
}

async function request(base, path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const url = `${base}${path}`;
  const init = {
    method,
    credentials: "same-origin",
    headers: { ...headers },
  };

  if (bearerToken) init.headers.authorization = `Bearer ${bearerToken}`;

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  // A bearer token authenticates by header and is exempt; a browser session
  // is not. GET/HEAD are exempt either way.
  if (!bearerToken && !["GET", "HEAD"].includes(method)) {
    init.headers["x-csrftoken"] = csrfToken();
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError("Couldn't reach the server.", { status: 0, url, body: null });
  }

  if (response.status === 401 && onUnauthorized) onUnauthorized();

  if (raw) return response;
  if (response.status === 204) return null;

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    // Both backends explain themselves, in different shapes: the receiver
    // uses {error}, GlitchTip uses {detail} or allauth's {errors:[{message}]}.
    const message =
      parsed?.error ||
      parsed?.detail ||
      parsed?.errors?.[0]?.message ||
      `Request failed (${response.status}).`;
    throw new ApiError(message, { status: response.status, body: parsed, url });
  }

  return parsed;
}

function client(base) {
  return {
    base,
    get: (path, options) => request(base, path, { ...options, method: "GET" }),
    post: (path, body, options) => request(base, path, { ...options, method: "POST", body }),
    put: (path, body, options) => request(base, path, { ...options, method: "PUT", body }),
    del: (path, options) => request(base, path, { ...options, method: "DELETE" }),
    /** For responses whose headers matter — cursor pagination reads Link. */
    raw: (path, options) => request(base, path, { ...options, raw: true }),
  };
}

/** The receiver: reports, replays, access requests, settings. */
export const sentinel = client("/sentinel/api");

/** GlitchTip's API: errors, projects, organisations, members, teams. */
export const glitchtip = client("/api/0");

/** GlitchTip's auth, which is allauth rather than its API. */
export const allauth = client("/_allauth/browser/v1");
