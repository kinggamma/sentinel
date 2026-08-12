const STAFF_API_TOKEN = process.env.STAFF_API_TOKEN;

/**
 * Gates every route behind a shared staff API token sent by the per-app
 * SDK (incident-capture.js) or feedback widget. The token itself should
 * only ever be injected into pages already gated to staff/admin sessions
 * server-side — this is a second layer, not the primary access control.
 */
export function requireStaffToken(req, res, next) {
  if (!STAFF_API_TOKEN) {
    console.warn("STAFF_API_TOKEN is not set — refusing all requests. Set it in .env.");
    return res.status(503).json({ error: "receiver misconfigured" });
  }

  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (token !== STAFF_API_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}
