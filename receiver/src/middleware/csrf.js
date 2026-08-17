import crypto from "node:crypto";
import { readCookie } from "../auth/identity.js";
import { presentsStaffToken } from "./auth.js";

/**
 * Cross-site request forgery, checked here rather than assumed elsewhere.
 *
 * Every write GlitchTip owns is protected by Django, which refuses a session
 * write without a token and does not care what any client intended to send.
 * Every write the receiver owns — approving somebody's access, changing which
 * origins may report, deleting a report — was protected by the client
 * choosing to attach a header, which is not protection at all: the attacker
 * writes the client.
 *
 * What stood between that and an exploit was SameSite=Lax on the session
 * cookie, which keeps a cross-site POST from carrying it. That is a real
 * defence and it is one browser-side control, granted by the cookie's issuer
 * rather than by anything here, covering only browsers that honour it. Django
 * does not rely on it alone for the writes on the other side of the same
 * origin, and neither should this.
 *
 * So: a double-submit token of the receiver's own.
 *
 * Its own, rather than Django's, for a reason the other mount settles. The
 * app is served both behind the shared origin and on the receiver's own port,
 * and on that port there is no allauth to mint a Django token — a check that
 * demanded one would refuse every write on a mount where nothing is wrong.
 * This cookie is issued by the thing doing the checking, so it exists
 * wherever the app does.
 *
 * The pairing is the point: the cookie is readable by scripts on this origin
 * and echoed back in a header, and a cross-site page can cause the cookie to
 * be sent but cannot read it to produce the header.
 */

const COOKIE = "sentinel-csrf";
const HEADER = "x-sentinel-csrf";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Long enough that guessing is not a strategy. */
function mint() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Given to the page that has to echo it, and to nothing else.
 *
 * Issued when the app's own HTML is served, rather than on every response.
 * That is early enough — the page has it before it can render a button, so
 * no write ever waits on a round trip to fetch one — and it keeps every API
 * response cookie-free, which two things here depend on.
 *
 * The embedded viewer is the reason for the rest. It runs in another site's
 * iframe, authenticates with a bearer token its host hands over, and holds
 * no session at all; a Set-Cookie from us in that context would be a
 * third-party cookie written into somebody else's page, for a token that
 * viewer can never need. It is excluded by asking the same question the
 * viewer's own boot asks — whether this is the embedded mode — rather than
 * by trusting the referrer.
 *
 * Not httpOnly, deliberately and necessarily: the page has to read it to
 * echo it back. That is what makes it a token rather than one more cookie
 * the browser sends on its own.
 */
export function issueCsrfCookie(req, res) {
  const embedded = req.query?.embed === "1";
  if (embedded || presentsStaffToken(req) || readCookie(req, COOKIE)) return;

  res.cookie(COOKIE, mint(), {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.SECURE_COOKIES === "true",
    path: "/",
  });
}

/**
 * Refuse an unsafe request that cannot prove it came from this origin.
 *
 * Bearer callers are exempt by construction and not by exception: they
 * authenticate with a header, which a cross-site page cannot set on a request
 * the browser makes on its own behalf, and they carry no cookie for a forged
 * request to ride on. That covers apps posting reports and the embedded
 * viewer, neither of which has a session at all.
 */
export function requireCsrf(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (presentsStaffToken(req)) return next();

  const cookie = readCookie(req, COOKIE);
  const header = req.header?.(HEADER) || req.headers?.[HEADER] || "";

  if (!cookie || !header) {
    return res.status(403).json({
      error: "missing CSRF token",
      // Said plainly because the fix is a reload: a session can outlive this
      // cookie, and a page told only "forbidden" looks broken instead of
      // stale.
      csrf: true,
    });
  }

  const a = Buffer.from(String(cookie));
  const b = Buffer.from(String(header));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "bad CSRF token", csrf: true });
  }

  return next();
}
