import crypto from "node:crypto";
import { STATES } from "../auth/state.js";
import { identify, readCookie } from "../auth/identity.js";
import { myRequest } from "../access-requests.js";

const STAFF_API_TOKEN = process.env.STAFF_API_TOKEN;

export { readCookie };

/**
 * Whether this request carries the shared staff token.
 *
 * Its own function because two things need the same answer and getting it
 * twice, differently, is how they drift: the guard below, and /auth/me — the
 * one the embedded viewer asks before it renders anything at all.
 */
export function presentsStaffToken(req) {
  if (!STAFF_API_TOKEN) return false;
  const header = req.header?.("authorization") || req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token.length !== STAFF_API_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(STAFF_API_TOKEN));
}

/**
 * There is one session, and it is GlitchTip's.
 *
 * This file used to mint a second: an HMAC-signed cookie carrying email,
 * organisations and projects, with its own twelve-hour clock. It was really
 * an identity cache — already tied to GlitchTip's session by a fingerprint so
 * that signing out there invalidated it here — but it was a second copy of
 * the truth on a different schedule from the truth, and it went stale in
 * ways nobody noticed. Someone approved into an organisation kept being told
 * they belonged to none, because the cookie still said so and the cookie was
 * what we asked.
 *
 * Every request now resolves the caller from GlitchTip's cookie directly.
 */
export async function currentUser(req, options) {
  const identity = await identify(req, {
    // Sentinel's own queue, which GlitchTip has no concept of. Only consulted
    // for somebody who belongs to no organisation.
    accessRequestFor: async (email) => (email ? (await myRequest(email))?.status || null : null),
    ...options,
  });
  return identity;
}

/**
 * Two ways in, and they have not changed:
 *
 *   1. `Authorization: Bearer <STAFF_API_TOKEN>` — how apps' SDKs post
 *      reports, and how the embedded viewer reads them. A shared secret,
 *      not an identity, and deliberately cookie-free: the embedded viewer
 *      lives in another page's iframe where no session of ours exists.
 *   2. GlitchTip's session cookie. That's a person, and actions can be
 *      attributed to them.
 */
export async function requireStaffToken(req, res, next) {
  if (!STAFF_API_TOKEN) {
    console.warn("STAFF_API_TOKEN is not set — refusing all requests. Set it in .env.");
    return res.status(503).json({ error: "receiver misconfigured" });
  }

  // Checked before anything touches a cookie, so a bearer request never costs
  // a lookup and never depends on one being reachable.
  if (presentsStaffToken(req)) {
    req.viewer = { source: "staff-token", email: null, state: null, projects: null };
    return next();
  }

  let identity;
  try {
    identity = await currentUser(req);
  } catch (error) {
    // Refusing is the only safe answer. Everything this guard protects is
    // narrowed by facts we just failed to establish, so proceeding would
    // mean proceeding with fewer restrictions than the last request had.
    console.warn(`could not resolve the caller: ${error.message}`);
    return res.status(502).json({ error: "couldn't reach GlitchTip to check that session" });
  }

  if (identity.state === STATES.AUTHENTICATED) {
    req.viewer = identity;
    return next();
  }

  // Someone we know of who hasn't been let in yet. "Unauthorized" would be
  // true and useless; the viewer needs to tell them where they stand.
  if (identity.state === STATES.PENDING || identity.state === STATES.DENIED) {
    return res.status(403).json({ error: "awaiting access", pending: true, state: identity.state });
  }

  return res.status(401).json({ error: "unauthorized", state: identity.state });
}

/**
 * For the few routes a not-yet-approved person may use: asking for access,
 * and being told what happened to that request. Everything else goes through
 * requireStaffToken, which refuses them.
 */
export async function requireSignedIn(req, res, next) {
  let identity;
  try {
    identity = await currentUser(req);
  } catch (error) {
    console.warn(`could not resolve the caller: ${error.message}`);
    return res.status(502).json({ error: "couldn't reach GlitchTip to check that session" });
  }

  // Anything with a real account behind it, whether or not it has anywhere to
  // go yet. Only a session that identifies nobody is turned away.
  const known = [
    STATES.AUTHENTICATED,
    STATES.PENDING,
    STATES.DENIED,
    STATES.REAUTH_REQUIRED,
  ].includes(identity.state);

  if (!known) return res.status(401).json({ error: "unauthorized", state: identity.state });
  req.viewer = identity;
  return next();
}
