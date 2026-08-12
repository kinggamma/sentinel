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

export function issueSession(res, { email, name, source }) {
  const payload = {
    email: email || null,
    name: name || null,
    source, // "glitchtip" | "staff-token"
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
  return cookie ? unsign(cookie) : null;
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
