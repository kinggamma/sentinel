import crypto from "node:crypto";
import { Router } from "express";
import { verifyGlitchtipUser, glitchtipConfigured, glitchtipInfo } from "../glitchtip.js";
import { issueSession, clearSession, currentUser } from "../middleware/auth.js";

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
      if (err.status !== 401 && err.status !== 403) {
        return res.status(502).json({ error: "Couldn't reach GlitchTip to check that token." });
      }
      // 401/403 from GlitchTip: the token is neither a GlitchTip token nor
      // the staff one.
    }
  }

  res.status(401).json({ error: "That token wasn't accepted." });
});

authRouter.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.status(204).end();
});
