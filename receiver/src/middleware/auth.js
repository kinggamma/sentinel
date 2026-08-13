import crypto from "node:crypto";

const STAFF_API_TOKEN = process.env.STAFF_API_TOKEN;

/**
 * Sessions are a signed cookie rather than server state — one container, no
 * store to run, and nothing to lose on restart beyond making people sign in
 * again. The secret defaults to a random value per boot, which has exactly
 * that effect; set SESSION_SECRET to survive restarts.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_COOKIE = "sentinel_session";
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign(value) {
  const [body, mac] = String(value).split(".");
  if (!body || !mac) return null;

  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  // Constant-time compare: a length mismatch would throw, so check that first.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fingerprint of the GlitchTip session a silent sign-in came from. Stored in
 * our own cookie so that signing out of GlitchTip — or signing in there as
 * somebody else — invalidates the Sentinel session on the very next request,
 * without a round trip to GlitchTip to find out.
 */
export function fingerprint(sessionId) {
  return crypto.createHash("sha256").update(String(sessionId)).digest("base64url").slice(0, 22);
}

export function issueSession(res, { email, name, source, boundTo = null, projects = null }) {
  const payload = {
    email: email || null,
    name: name || null,
    source, // "glitchtip" | "glitchtip-sso" | "staff-token"
    boundTo, // fingerprint of the GlitchTip session, for SSO sessions
    // GlitchTip project slugs this person can see. null means unrestricted,
    // which is the staff token and nothing else.
    projects,
    exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
  };
  res.cookie?.(SESSION_COOKIE, sign(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SECURE_COOKIES === "true",
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: "/",
  });
  return payload;
}

export function clearSession(res) {
  res.clearCookie?.(SESSION_COOKIE, { path: "/" });
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function currentUser(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  const session = cookie ? unsign(cookie) : null;
  if (!session) return null;

  // A session that came from GlitchTip's lasts exactly as long as GlitchTip's
  // does. Sign out there and this one stops working here, in the same click.
  if (session.boundTo) {
    const glitchtipSession = readCookie(req, process.env.GLITCHTIP_SESSION_COOKIE || "sessionid");
    if (!glitchtipSession || fingerprint(glitchtipSession) !== session.boundTo) return null;
  }

  return session;
}

/**
 * Two ways in:
 *
 *   1. `Authorization: Bearer <STAFF_API_TOKEN>` — how apps' SDKs post
 *      reports, and how the embedded viewer reads them. A shared secret,
 *      not an identity.
 *   2. A session cookie from signing in with a GlitchTip account that
 *      belongs to the organisation. That's a person, and actions can be
 *      attributed to them.
 */
export function requireStaffToken(req, res, next) {
  if (!STAFF_API_TOKEN) {
    console.warn("STAFF_API_TOKEN is not set — refusing all requests. Set it in .env.");
    return res.status(503).json({ error: "receiver misconfigured" });
  }

  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (token && token.length === STAFF_API_TOKEN.length) {
    const matches = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(STAFF_API_TOKEN));
    if (matches) {
      req.viewer = { source: "staff-token", email: null };
      return next();
    }
  }

  const session = currentUser(req);
  if (session) {
    req.viewer = session;
    return next();
  }

  return res.status(401).json({ error: "unauthorized" });
}
