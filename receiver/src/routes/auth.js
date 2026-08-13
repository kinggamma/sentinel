import crypto from "node:crypto";
import { Router } from "express";
import {
  verifyGlitchtipUser,
  verifyGlitchtipSession,
  identifyGlitchtipUser,
  revokeGlitchtipSession,
  glitchtipConfigured,
  glitchtipInfo,
  GLITCHTIP_SESSION_COOKIE,
} from "../glitchtip.js";
import { rememberProjectOrgs } from "../project-map.js";
import {
  issueSession,
  clearSession,
  currentUser,
  readCookie,
  fingerprint,
} from "../middleware/auth.js";

const STAFF_API_TOKEN = process.env.STAFF_API_TOKEN;

export const authRouter = Router();

/** What the sign-in screen needs to know before anyone types anything. */
authRouter.get("/auth/config", (_req, res) => {
  const { url, org } = glitchtipInfo();
  res.json({
    glitchtipEnabled: glitchtipConfigured,
    glitchtipUrl: url || null,
    glitchtipOrg: org || null,
  });
});

authRouter.get("/auth/me", (req, res) => {
  const session = currentUser(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  res.json({
    email: session.email,
    name: session.name,
    source: session.source,
    pending: Boolean(session.pending),
  });
});

/**
 * Sign in with either a personal GlitchTip auth token (preferred — it's a
 * person, and membership of the organisation is the approval) or the shared
 * staff token (for setups with no GlitchTip, and for automation).
 */
authRouter.post("/auth/login", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "token is required" });

  /**
   * The staff token is not a way to sign in.
   *
   * It's a shared secret that ships inside client-rendered admin panels, so
   * anyone who can open one can read it — and letting it sign a person in
   * would mean anyone who viewed source could browse every report and every
   * session replay. Apps still send it to post reports, and the embedded
   * viewer still uses it, but a human signing in brings a GlitchTip account
   * of their own.
   *
   * Without GlitchTip configured there'd otherwise be no way in at all, so
   * it stays the credential of last resort for that setup only.
   */
  if (!glitchtipConfigured) {
    if (STAFF_API_TOKEN && token.length === STAFF_API_TOKEN.length) {
      const matches = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(STAFF_API_TOKEN));
      if (matches) {
        const session = issueSession(res, { email: null, name: null, source: "staff-token" });
        return res.json({ email: null, name: null, source: session.source });
      }
    }
    return res.status(401).json({ error: "That token wasn't accepted." });
  }

  try {
    const user = await verifyGlitchtipUser(token);
    if (user) {
      await rememberProjectOrgs(user.projects || []);
      const session = issueSession(res, {
        ...user,
        source: "glitchtip",
        projects: user.projects ? user.projects.map((p) => p.slug) : null,
        orgs: user.orgs || [],
      });
      return res.json({ email: session.email, name: session.name, source: session.source });
    }
    // A real account that belongs to no organisation. Rather than a dead
    // end, give them a session that can do exactly one thing: ask.
    const identity = await identifyGlitchtipUser({ token });
    if (identity) {
      const session = issueSession(res, {
        ...identity,
        source: "glitchtip",
        projects: [],
        pending: true,
      });
      return res.json({ email: session.email, name: session.name, pending: true });
    }

    return res.status(403).json({
      error: glitchtipInfo().org
        ? `That GlitchTip account isn't a member of the ${glitchtipInfo().org} organisation.`
        : "That account doesn't belong to any GlitchTip organisation.",
    });
  } catch (err) {
    // Worth separating, because the fixes are completely different: 403
    // means the token is real but was created without the scope that
    // reading org membership needs, and no amount of retyping helps.
    console.warn(`glitchtip rejected a sign-in token: ${err.status || err.message}`);

    if (err.status === 403) {
      return res.status(403).json({
        error:
          "That token is missing the org:read scope. Create a new one in " +
          "GlitchTip under Profile → Auth Tokens with org:read ticked.",
      });
    }
    if (err.status !== 401) {
      return res.status(502).json({ error: "Couldn't reach GlitchTip to check that token." });
    }
  }

  res.status(401).json({
    error:
      "GlitchTip didn't recognise that token. Check it was copied whole, and that it hasn't been revoked.",
  });
});

/**
 * Silent sign-in for someone already signed in to GlitchTip.
 *
 * GlitchTip's session cookie is host-only and cookies ignore ports, so a
 * browser signed in at <host>:8000 sends that cookie to the receiver at
 * <host>:4000 as well. We hand it straight back to GlitchTip to ask whose
 * it is, and issue our own session if the answer is a member of the
 * organisation. Nothing here trusts the cookie's contents — GlitchTip is
 * still the one deciding.
 *
 * Only works when GlitchTip and Sentinel share a hostname; on separate
 * hosts the cookie never arrives and the sign-in screen takes over.
 */
authRouter.post("/auth/sso", async (req, res) => {
  if (!glitchtipConfigured) return res.status(401).json({ error: "no glitchtip configured" });

  const sessionId = readCookie(req, GLITCHTIP_SESSION_COOKIE);
  if (!sessionId) return res.status(401).json({ error: "not signed in to GlitchTip" });

  try {
    const user = await verifyGlitchtipSession(sessionId);
    if (!user) {
      const identity = await identifyGlitchtipUser({ sessionId });
      if (identity) {
        const session = issueSession(res, {
          ...identity,
          source: "glitchtip-sso",
          boundTo: fingerprint(sessionId),
          projects: [],
          pending: true,
        });
        return res.json({ email: session.email, name: session.name, pending: true });
      }
      return res.status(403).json({
        error: "You're signed in to GlitchTip, but that account belongs to no organisation.",
      });
    }
    await rememberProjectOrgs(user.projects || []);
    const session = issueSession(res, {
      ...user,
      source: "glitchtip-sso",
      // Tie this session's life to the GlitchTip session it came from.
      boundTo: fingerprint(sessionId),
      projects: user.projects ? user.projects.map((p) => p.slug) : null,
      orgs: user.orgs || [],
    });
    return res.json({ email: session.email, name: session.name, source: session.source });
  } catch (err) {
    // An expired or unknown GlitchTip session is the ordinary case here, not
    // an error worth shouting about — the sign-in screen handles it.
    if (err.status === 401 || err.status === 403) {
      return res.status(401).json({ error: "not signed in to GlitchTip" });
    }
    console.warn(`glitchtip sso check failed: ${err.status || err.message}`);
    return res.status(502).json({ error: "Couldn't reach GlitchTip." });
  }
});

/**
 * Signing out signs you out of both. They're meant to read as one system,
 * and leaving GlitchTip signed in after "Sign out" is the sort of thing
 * that reminds everyone they aren't.
 */
authRouter.post("/auth/logout", async (req, res) => {
  const sessionId = readCookie(req, GLITCHTIP_SESSION_COOKIE);
  const csrfToken = readCookie(req, "csrftoken");

  if (sessionId) {
    // Destroy it at GlitchTip if allauth lets us; either way the cookie goes
    // below, which is what signs this browser out.
    await revokeGlitchtipSession({ sessionId, csrfToken });
    // Host-only cookie, and cookies ignore ports — so clearing it here
    // clears it for GlitchTip on :8000 too.
    res.clearCookie(GLITCHTIP_SESSION_COOKIE, { path: "/" });
  }

  clearSession(res);
  res.status(204).end();
});
