import crypto from "node:crypto";
import { Router } from "express";
import {
  verifyGlitchtipUser,
  verifyGlitchtipSession,
  glitchtipConfigured,
  glitchtipInfo,
  GLITCHTIP_SESSION_COOKIE,
} from "../glitchtip.js";
import { issueSession, clearSession, currentUser, readCookie } from "../middleware/auth.js";

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
  res.json({ email: session.email, name: session.name, source: session.source });
});

/**
 * Sign in with either a personal GlitchTip auth token (preferred — it's a
 * person, and membership of the organisation is the approval) or the shared
 * staff token (for setups with no GlitchTip, and for automation).
 */
authRouter.post("/auth/login", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "token is required" });

  // The shared secret is checked here, first, for two reasons: it means the
  // staff token is never sent on to GlitchTip, and it means GlitchTip being
  // down doesn't take the fallback down with it.
  if (STAFF_API_TOKEN && token.length === STAFF_API_TOKEN.length) {
    const matches = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(STAFF_API_TOKEN));
    if (matches) {
      const session = issueSession(res, { email: null, name: null, source: "staff-token" });
      return res.json({ email: null, name: null, source: session.source });
    }
  }

  if (glitchtipConfigured) {
    try {
      const user = await verifyGlitchtipUser(token);
      if (user) {
        const session = issueSession(res, { ...user, source: "glitchtip" });
        return res.json({ email: session.email, name: session.name, source: session.source });
      }
      // A valid token whose owner isn't in the org: say so plainly rather
      // than implying the token was wrong.
      return res.status(403).json({
        error: `That GlitchTip account isn't a member of the ${glitchtipInfo().org} organisation. Ask an admin to invite it.`,
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
      // 401: GlitchTip doesn't know this token, and it isn't the staff one
      // either.
    }
  }

  res.status(401).json({
    error: glitchtipConfigured
      ? "GlitchTip didn't recognise that token. Check it was copied whole, and that it hasn't been revoked."
      : "That token wasn't accepted.",
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
      return res.status(403).json({
        error: `You're signed in to GlitchTip, but not as a member of the ${glitchtipInfo().org} organisation.`,
      });
    }
    const session = issueSession(res, { ...user, source: "glitchtip-sso" });
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

authRouter.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.status(204).end();
});
