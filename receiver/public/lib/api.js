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
 *
 * With one exception, and it matters: allauth answers 401 as a normal part
 * of a conversation, not as a refusal. `GET auth/session` returns 401 with
 * the available flows when nobody is signed in, and an MFA challenge or a
 * reauthentication prompt is a 401 carrying the pending flow. Treating those
 * as "your session has gone" would throw someone out of the app at the exact
 * moment they were signing into it, so the allauth client never signals.
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
function readCookie(name) {
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`)
  );
  return match ? decodeURIComponent(match[1]) : "";
}

export function csrfToken() {
  return readCookie("csrftoken");
}

/**
 * Having one, rather than assuming one.
 *
 * Nothing Sentinel serves can set that cookie. Django writes it from a view
 * that asks for a token, and every page here comes from the receiver, which
 * is not Django — so the only reason a token was ever present is that the
 * browser had been through allauth to sign in, and that cookie outlived the
 * flow.
 *
 * Which held often enough to hide the hole completely. Sign-in mints one,
 * so a person who signs in can write, and the whole app was tested that way.
 * A session that arrives any other way — the cookie cleared on its own
 * schedule while the session stayed, a browser restored from a profile that
 * kept one and not the other — got a bare 403 on every write, on a screen
 * that offered the buttons anyway. Resolving an issue, ignoring it, leaving
 * a note: all refused, none of them explicably.
 *
 * So the token is fetched when it is missing. allauth's capability document
 * is a GET that changes nothing and hands one back, which makes it the
 * cheapest correct way to ask. Once fetched the cookie serves every later
 * write, and concurrent writes share one request rather than each starting
 * their own.
 *
 * It is only there to ask on one of the two mounts, though. Behind the
 * shared origin GlitchTip answers /_allauth and this works; on the
 * receiver's own port nothing does, because GlitchTip is not there at all —
 * /api/0 is equally absent, so no write that needs a token can be attempted
 * from that mount in the first place, and the receiver's own writes never
 * wanted one. A 404 there is the origin saying "not here", which is a
 * permanent answer, so it is remembered rather than re-asked before every
 * write forever.
 *
 * Anything else that goes wrong — offline, a 5xx, a token that does not
 * arrive — is not permanent and is left retryable. Latching on those would
 * turn one bad moment into an app that quietly cannot write until it is
 * reloaded.
 */
let minting = null;
let mintable = true;

async function ensureCsrfToken() {
  const held = csrfToken();
  if (held) return held;
  if (!mintable) return "";

  minting ??= fetch("/_allauth/browser/v1/config", { credentials: "same-origin" })
    .then((response) => {
      // Not "the request failed" — "allauth is not part of this origin."
      if (response.status === 404) mintable = false;
    })
    .catch(() => {
      // Offline or blocked: worth trying again on the next write.
    })
    .then(() => {
      minting = null;
      return csrfToken();
    });

  return minting;
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

async function request(
  base,
  path,
  { method = "GET", body, headers = {}, raw = false, signalUnauthorized = true, signal } = {}
) {
  const url = `${base}${path}`;
  const init = {
    method,
    credentials: "same-origin",
    headers: { ...headers },
    // A view's own AbortSignal, passed through so a superseded navigation
    // cancels the request in flight rather than leaving it to resolve into
    // nothing. fetch throws AbortError for us when this fires.
    ...(signal ? { signal } : {}),
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
    // Two backends, two tokens, and each ignores the other's. Django's is
    // fetched when missing; the receiver issues its own on any safe request,
    // so by the time anything is written it is simply there — including on
    // the receiver's own port, where Django's cannot be had at all.
    init.headers["x-csrftoken"] = await ensureCsrfToken();
    init.headers["x-sentinel-csrf"] = readCookie("sentinel-csrf");
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    // A cancelled request throws AbortError, and it means "the caller moved
    // on," not "the network failed" — let it through as itself so a view's
    // throwIfAborted (and the router's own AbortError handling) recognise
    // it, instead of it arriving disguised as a generic connectivity error.
    if (cause?.name === "AbortError") throw cause;
    throw new ApiError("Couldn't reach the server.", { status: 0, url, body: null });
  }

  if (response.status === 401 && signalUnauthorized && onUnauthorized) onUnauthorized();

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

/**
 * @param {string} base
 * @param {object} [defaults] - signalUnauthorized false for backends that use
 *   401 to mean something other than "sign in again". A single call can still
 *   override it either way.
 */
function client(base, defaults = {}) {
  const send = (path, options, extra) => request(base, path, { ...defaults, ...options, ...extra });
  return {
    base,
    get: (path, options) => send(path, options, { method: "GET" }),
    post: (path, body, options) => send(path, options, { method: "POST", body }),
    put: (path, body, options) => send(path, options, { method: "PUT", body }),
    del: (path, options) => send(path, options, { method: "DELETE" }),
    /** For responses whose headers matter — cursor pagination reads Link. */
    raw: (path, options) => send(path, options, { raw: true }),
  };
}

/** The receiver: reports, replays, access requests, settings. */
export const sentinel = client("/sentinel/api");

/** GlitchTip's API: errors, projects, organisations, members, teams. */
export const glitchtip = client("/api/0");

/**
 * GlitchTip's auth, which is allauth rather than its API.
 *
 * Exempt from the 401 handler by construction: every one of its 401s is a
 * state to read, not a session to abandon.
 */
export const allauth = client("/_allauth/browser/v1", { signalUnauthorized: false });
