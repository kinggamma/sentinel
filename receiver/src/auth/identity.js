/**
 * Who is making this request, according to the one session there is.
 *
 * Sentinel used to answer this from a cookie it minted itself, carrying a
 * copy of the identity frozen at sign-in. That copy went stale in ways nobody
 * saw: somebody approved into an organisation kept being told they belonged
 * to none until their cookie expired, because the cookie still said so.
 *
 * Now nothing is stored. Each request is answered from GlitchTip's own
 * session cookie, by asking the two backends the questions each can answer,
 * and reducing what they say through the pure state machine next door.
 *
 * The cost of that is a round trip, so there is a short cache — long enough
 * that one page load asking six times costs one lookup, short enough that
 * being approved, removed, or signed out elsewhere shows up almost at once.
 */
import {
  GLITCHTIP_SESSION_COOKIE,
  GLITCHTIP_API_URL,
  callGlitchtip,
  glitchtipConfigured,
  orgSlug,
  revokeGlitchtipSession,
} from "../glitchtip.js";
import { idleEnabled, isIdle, touch, begin, forgetIdle } from "./idle.js";
import { rememberProjectOrgs } from "../project-map.js";
import { readAllauth, derive, describe, STATES } from "./state.js";

/**
 * Short enough that a change of circumstances is felt within seconds, long
 * enough that a screen making several calls does not multiply them into
 * several sets of lookups against GlitchTip.
 */
const CACHE_MS = Number(process.env.AUTH_CACHE_MS || 10_000);
const cache = new Map();

export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Nothing here is stored, so nothing has to be invalidated — but a sign-out
 *  should be felt immediately rather than in ten seconds' time. */
export function forget(sessionId) {
  if (sessionId) cache.delete(sessionId);
}

/** Re-export so callers have one import for "this session is alive". */
export { touch };

async function askAllauth(sessionId) {
  try {
    const res = await fetch(`${GLITCHTIP_API_URL}/_allauth/browser/v1/auth/session`, {
      headers: {
        accept: "application/json",
        cookie: `${GLITCHTIP_SESSION_COOKIE}=${sessionId}`,
      },
    });
    // Its 401 and 410 are answers, not failures: one means nobody is signed
    // in, the other that the session it knew about is gone. Both carry the
    // flow state the sign-in screen needs.
    const body = await res.json().catch(() => null);
    return readAllauth({ status: res.status, body });
  } catch {
    return null;
  }
}

/**
 * Three outcomes, and collapsing them into two is how authorisation fails
 * open.
 *
 *   answered    — GlitchTip told us something.
 *   refused     — GlitchTip understood and said no (401/403/404). That is an
 *                 answer: this caller may see none of it.
 *   unavailable — we never got an answer. A network fault, a 5xx, a restart
 *                 mid-request. We know nothing, and guessing in the
 *                 permissive direction means showing one organisation's
 *                 reports to another's for as long as the fault lasts.
 */
async function askGlitchtip(path, sessionId) {
  try {
    return { data: await callGlitchtip(path, { sessionId }) };
  } catch (error) {
    const status = error?.status || 0;
    if (status === 401 || status === 403 || status === 404) return { refused: true, status };
    return { unavailable: true, status };
  }
}

/**
 * Raised when the answer is unknown, so a caller turns it into a 502 rather
 * than into a permission.
 */
export class IdentityUnavailable extends Error {
  constructor(status) {
    super("couldn't reach GlitchTip to establish who is asking");
    this.name = "IdentityUnavailable";
    this.status = status;
  }
}

/**
 * Everything known about the caller, from the session cookie alone.
 *
 * @param {import("express").Request} req
 * @param {object} [options]
 * @param {(email: string) => Promise<"pending"|"approved"|"denied"|null>}
 *   [options.accessRequestFor] - Sentinel's own access queue, which GlitchTip
 *   has no concept of. Injected rather than imported so this stays testable
 *   and so the queue is only consulted for someone who might need it.
 */
export async function identify(req, { accessRequestFor = null } = {}) {
  const sessionId = readCookie(req, GLITCHTIP_SESSION_COOKIE);
  const sawCookie = Boolean(sessionId);

  if (!glitchtipConfigured || !sessionId) {
    const state = derive({ sawCookie });
    return { state, sessionId, user: null, orgs: [], projects: [], allauth: null };
  }

  /**
   * Left alone too long, if this installation asks for that.
   *
   * Checked before the cache, because a cached "authenticated" from four
   * seconds ago is exactly what an idle session looks like — and destroyed
   * at GlitchTip rather than merely refused here, or the session would go on
   * working in GlitchTip's own screens and in every other tab, which is not
   * what anybody means by signing someone out.
   */
  if (idleEnabled && isIdle(sessionId)) {
    cache.delete(sessionId);

    // Reported rather than swallowed: a timeout that fails to end the
    // session is a timeout that has not happened, and silence is how that
    // goes unnoticed.
    const revoked = await revokeGlitchtipSession({ sessionId }).catch(() => false);

    if (revoked) {
      // Gone for good, so the record has nothing left to say.
      forgetIdle(sessionId);
    } else {
      /**
       * Kept, deliberately.
       *
       * An unknown session is treated as newly arrived rather than idle, so
       * dropping the record here would hand a session we had just failed to
       * destroy a fresh window — and it is still alive at GlitchTip, which
       * is precisely the case where that must not happen. Holding on to it
       * keeps the answer "expired" and makes every later request try the
       * revoke again until one of them works.
       */
      console.warn(
        "an idle session could not be ended at GlitchTip — refusing it here and retrying"
      );
    }

    return { state: STATES.EXPIRED, sessionId, user: null, orgs: [], projects: [], allauth: null };
  }

  const hit = cache.get(sessionId);
  if (hit && hit.until > Date.now()) return hit.value;

  const [allauth, meRes, orgsRes, projectsRes] = await Promise.all([
    askAllauth(sessionId),
    askGlitchtip("/api/0/users/me/", sessionId),
    askGlitchtip("/api/0/organizations/", sessionId),
    // Which projects this person can see in GlitchTip, which is what decides
    // which apps' reports they may read here. Removing somebody from a team
    // there removes their access here, with nothing to keep in step.
    askGlitchtip("/api/0/projects/", sessionId),
  ]);

  /**
   * If any of these never answered, we do not know who is asking — and every
   * one of them narrows what this person may see. Answering anyway means
   * answering with less information than the last request had, in the
   * direction that grants more. So: no answer, no decision.
   */
  const unavailable = [meRes, orgsRes, projectsRes].find((result) => result?.unavailable);
  if (unavailable) throw new IdentityUnavailable(unavailable.status);

  const me = meRes.data;
  const user = me
    ? {
        email: me.email || me.username || null,
        name: me.name || null,
        /**
         * Taken from GlitchTip, not assumed.
         *
         * This was hardcoded true, reasoning that GlitchTip would not
         * describe a user it considered unusable. It does: deactivating an
         * account leaves its session working and /api/0/users/me/ answering
         * 200, with isActive false in the body — the only place that fact
         * appears. Hardcoding it left a disabled account signed in and fully
         * authorised until its session aged out.
         */
        isActive: me.isActive,
        hasPasswordAuth: me.hasPasswordAuth ?? null,
      }
    : null;

  const organizations = orgsRes.data;
  const memberOf = (Array.isArray(organizations) ? organizations : [])
    .map((org) => org.slug)
    .filter(Boolean);

  /**
   * GLITCHTIP_ORG is optional and only ever narrows: set it when one
   * GlitchTip serves more than this pipeline and a single organisation is
   * meant to be the gate. Membership of some *other* organisation is not
   * access here, and someone holding it comes out with no organisations at
   * all — which is to say pending, free to ask, and able to read nothing.
   *
   * This lived in the sign-in path that one-session deleted, and losing it
   * would have quietly let every member of every other organisation on a
   * shared GlitchTip straight in.
   */
  const restrictTo = orgSlug();
  const orgs = restrictTo ? memberOf.filter((slug) => slug === restrictTo) : memberOf;

  /**
   * The list of projects this person may see, and for a person it is always
   * a list.
   *
   * It used to fall back to null on any failure, and null meant "not
   * narrowed" — which report.js read as "sees everything". A refusal or a
   * momentary fault therefore widened someone's access instead of narrowing
   * it, across organisations. A refusal is now an empty list, which is what
   * GlitchTip actually said, and a fault has already thrown above.
   */
  const visible = projectsRes.data;
  const projects = Array.isArray(visible)
    ? visible.map((project) => project.slug).filter(Boolean)
    : [];

  /**
   * Which organisation each project belongs to, learned from whoever happens
   * to be looking. Deep links into GlitchTip are per-organisation
   * (/<org>/issues) and nothing configures that mapping — it arrives as a
   * side effect of people using the viewer.
   *
   * That side effect used to hang off signing in, which is exactly why it
   * needed moving here rather than deleting with it: sign-in happens once a
   * fortnight, and this happens on every request that isn't cached.
   *
   * Not awaited. It is a disk write of a file that usually does not change,
   * and no request should wait on it to answer who is asking.
   */
  if (Array.isArray(visible)) {
    const pairs = visible
      .map((project) => ({ slug: project.slug, org: project.organization?.slug || null }))
      .filter((pair) => pair.slug && pair.org);
    if (pairs.length) {
      rememberProjectOrgs(pairs).catch((error) =>
        console.warn(`couldn't record which organisation a project belongs to: ${error.message}`)
      );
    }
  }

  // Only asked for someone who has nowhere to go: everybody else's answer
  // cannot change what they are.
  let accessRequest = null;
  if (user && orgs.length === 0 && accessRequestFor) {
    accessRequest = await accessRequestFor(user.email).catch(() => null);
  }

  /**
   * Start the clock, now that this session has been resolved against
   * GlitchTip and found to belong to somebody.
   *
   * The only place a session enters the idle map. /auth/touch reads a cookie
   * that nobody has checked yet, so it may refresh a record and never create
   * one — otherwise inventing session ids would be a way to fill the map,
   * and filling the map used to evict the records that keep expired sessions
   * refused.
   */
  if (idleEnabled && user) begin(sessionId);

  const value = {
    state: derive({ sawCookie, allauth, user, orgs, accessRequest }),
    sessionId,
    user,
    orgs,
    projects,
    allauth,
    // Read straight off the identity by the access routes, which care about
    // the person rather than the state they are in.
    email: user?.email || null,
  };

  cache.set(sessionId, { value, until: Date.now() + CACHE_MS });
  // The cache is keyed by session and never grows on its own, but a long
  // running process meeting many sessions should not keep every one of them.
  if (cache.size > 500) {
    for (const [key, entry] of cache) {
      if (entry.until <= Date.now()) cache.delete(key);
    }
  }
  return value;
}

/** The `/auth/me` body for a resolved caller. */
export function present(identity) {
  return describe(identity);
}
