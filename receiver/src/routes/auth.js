import { Router } from "express";
import {
  revokeGlitchtipSession,
  glitchtipConfigured,
  glitchtipInfo,
  GLITCHTIP_SESSION_COOKIE,
} from "../glitchtip.js";
import { currentUser, readCookie } from "../middleware/auth.js";
import { present, forget } from "../auth/identity.js";

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

/**
 * What this session is — Sentinel's read-only view of the one session there
 * is. It reads; it never creates one, and it never sets a cookie.
 *
 * Always 200, including for nobody at all. The state is the answer, and
 * "anonymous" is a perfectly good one: answering 401 here would make the
 * client's own central 401 handling fire on a question about whether anyone
 * is signed in, which is the thing that handling exists to avoid.
 */
authRouter.get("/auth/me", async (req, res) => {
  try {
    res.json(present(await currentUser(req)));
  } catch (error) {
    console.warn(`couldn't resolve the session: ${error.message}`);
    res.status(502).json({ error: "couldn't reach GlitchTip to check that session" });
  }
});

/**
 * Signing in is allauth's job now, at /_allauth/browser/v1/auth/login on this
 * same origin, and the session it creates is the only one there is.
 *
 * This endpoint used to take a personal auth token and mint a Sentinel
 * session from it. That was built when Sentinel ran as a separate app on its
 * own port with no way to reach GlitchTip's session; on one origin it is
 * vestigial, and it cannot survive one-session anyway — a token cannot create
 * a Django session. Personal tokens remain API credentials.
 *
 * It answers rather than disappearing, because a browser holding an old copy
 * of the page would otherwise get an unexplained 404.
 */
authRouter.post("/auth/login", (_req, res) => {
  res.status(410).json({
    error:
      "Signing in with a token has been removed. Sign in with your email and password — " +
      "personal auth tokens are for API calls now.",
  });
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
    // Ten seconds of cached identity would otherwise outlive the sign-out.
    forget(sessionId);
  }

  res.status(204).end();
});
