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
} from "../glitchtip.js";
import { rememberProjectOrgs } from "../project-map.js";
import { readAllauth, derive, describe } from "./state.js";

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
 * A read that is allowed to come back empty-handed. Every one of these is a
 * question about the caller, and a refusal is part of the answer — a token
 * without project:read, a user GlitchTip will not describe — so none of them
 * should abort resolving the rest.
 */
async function askGlitchtip(path, sessionId) {
  try {
    return await callGlitchtip(path, { sessionId });
  } catch {
    return null;
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
    return { state, sessionId, user: null, orgs: [], projects: null, allauth: null };
  }

  const hit = cache.get(sessionId);
  if (hit && hit.until > Date.now()) return hit.value;

  const [allauth, me, organizations, visible] = await Promise.all([
    askAllauth(sessionId),
    askGlitchtip("/api/0/users/me/", sessionId),
    askGlitchtip("/api/0/organizations/", sessionId),
    // Which projects this person can see in GlitchTip, which is what decides
    // which apps' reports they may read here. Removing somebody from a team
    // there removes their access here, with nothing to keep in step.
    askGlitchtip("/api/0/projects/", sessionId),
  ]);

  const user = me
    ? {
        email: me.email || me.username || null,
        name: me.name || null,
        // GlitchTip only returns a user it considers usable, so reaching this
        // at all means active. Kept explicit because the state machine treats
        // "switched off" as outranking everything else, and a silent
        // undefined would read as "not disabled" rather than "unknown".
        isActive: true,
        hasPasswordAuth: me.hasPasswordAuth ?? null,
      }
    : null;

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
   * null means "not narrowed", and that is not the same as an empty list.
   * A failed or refused project listing has to stay unrestricted, because
   * the alternative is an empty viewer with no explanation — organisation
   * membership has already decided this person may be here. An empty array
   * would silently hide everything.
   */
  const projects = Array.isArray(visible)
    ? visible.map((project) => project.slug).filter(Boolean)
    : null;

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
