import { Router } from "express";
import {
  revokeGlitchtipSession,
  glitchtipConfigured,
  glitchtipInfo,
  GLITCHTIP_SESSION_COOKIE,
} from "../glitchtip.js";
import { currentUser, readCookie, presentsStaffToken } from "../middleware/auth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { STATES } from "../auth/state.js";
import { describe as describeState } from "../auth/state.js";
import { present, forget, touch } from "../auth/identity.js";
import { idleEnabled, idleWindowMs } from "../auth/idle.js";

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
  /**
   * The embedded viewer asks this before it renders anything, and it has no
   * cookie — it lives in another page's iframe and authenticates with a
   * header on every request. Answering only from the cookie told it that
   * nobody was signed in, and the guards in front of every screen duly sent
   * it to a sign-in form inside somebody's admin page.
   *
   * A valid staff token is an answer to "who is asking". It is an app rather
   * than a person, so it carries no identity and no organisations; what it
   * gets is permission to read, which is all the viewer needs.
   */
  if (presentsStaffToken(req)) {
    return res.json({
      ...describeState({ state: STATES.AUTHENTICATED, user: null, orgs: [] }),
      source: "staff-token",
    });
  }

  /**
   * ?fresh=1 skips the cache for this one session.
   *
   * Identity is cached for a few seconds so that a page load asking six
   * times costs one lookup. That is right for reading, and wrong immediately
   * after something changed what the answer is: accepting an invitation adds
   * you to an organisation through GlitchTip directly, which this receiver
   * never sees, so the next question is answered from a copy that still says
   * you belong to nothing — and the guard sends you back to "you're in no
   * organisation yet" for the rest of the window.
   *
   * Only ever affects the caller's own session, and only costs what the
   * caller would have paid by waiting.
   */
  if (req.query?.fresh) forget(readCookie(req, GLITCHTIP_SESSION_COOKIE));

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
 * "Still here."
 *
 * The receiver sees almost nothing of what somebody does — issues, projects
 * and the rest are proxied straight to GlitchTip and never reach this
 * process — so an idle timeout measured from requests arriving here would
 * sign out anyone quietly reading. The browser is the only party that knows,
 * and this is how it says so: no body, no answer, nothing to get wrong.
 *
 * Cheap on purpose. It touches a map and returns; it never asks GlitchTip
 * anything, so a page can call it as often as somebody moves a mouse.
 */
/*
 * Guarded, unlike the two tombstones elsewhere in this file. Keeping a
 * session alive is a small thing to be able to do from another site, but it
 * is still doing something to somebody's session from another site — and
 * unlike an endpoint whose whole job is to say "this is gone", refusing a
 * forged one costs nothing.
 */
authRouter.post("/auth/touch", requireCsrf, (req, res) => {
  if (!idleEnabled) return res.status(204).end();
  touch(readCookie(req, GLITCHTIP_SESSION_COOKIE));
  res.status(204).end();
});

/** What the client needs to know about how long it may sit still. */
authRouter.get("/auth/idle", (_req, res) => {
  res.json({ enabled: idleEnabled, windowMs: idleWindowMs() });
});

/**
 * Signing out signs you out of both. They're meant to read as one system,
 * and leaving GlitchTip signed in after "Sign out" is the sort of thing
 * that reminds everyone they aren't.
 */
authRouter.post("/auth/logout", requireCsrf, async (req, res) => {
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
