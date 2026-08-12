import fetch from "node-fetch";

/**
 * GlitchTip as the source of truth for who may read reports.
 *
 * Sentinel deliberately has no user database. Instead a person signs in with
 * a personal GlitchTip auth token (GlitchTip > Profile > Auth Tokens), and we
 * ask GlitchTip whether that token belongs to a member of the configured
 * organisation. Approving someone is therefore one action in one place —
 * invite them to the org — and revoking their GlitchTip access revokes this
 * too. Self-signup is off by default (ENABLE_OPEN_USER_REGISTRATION=false),
 * so a stranger can't create an account and walk in.
 */
/**
 * Two URLs, because they answer different questions. GLITCHTIP_URL is where a
 * browser can reach GlitchTip — it ends up in links we hand to staff, so it
 * has to work from their machine. GLITCHTIP_API_URL is where *this container*
 * can reach it, which in Docker is a service name no browser has heard of. It
 * defaults to the public one, which is right for a receiver running outside
 * Compose.
 */
const GLITCHTIP_URL = (process.env.GLITCHTIP_URL || "").replace(/\/+$/, "");
const GLITCHTIP_API_URL = (process.env.GLITCHTIP_API_URL || GLITCHTIP_URL).replace(/\/+$/, "");
const GLITCHTIP_ORG = process.env.GLITCHTIP_ORG || "";

/** Optional appName -> GlitchTip project slug map, as JSON. */
let PROJECT_MAP = {};
try {
  PROJECT_MAP = JSON.parse(process.env.GLITCHTIP_PROJECT_MAP || "{}");
} catch {
  console.warn("GLITCHTIP_PROJECT_MAP is not valid JSON — ignoring it.");
}

export const glitchtipConfigured = Boolean(GLITCHTIP_URL && GLITCHTIP_ORG);

export function glitchtipInfo() {
  return { url: GLITCHTIP_URL, org: GLITCHTIP_ORG, projectMap: PROJECT_MAP };
}

async function callGlitchtip(path, token) {
  const res = await fetch(`${GLITCHTIP_API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) {
    const error = new Error(`glitchtip responded ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Resolve a GlitchTip auth token to a person, but only if they belong to the
 * configured organisation. Membership of some *other* org is not access here.
 *
 * @returns {Promise<{email: string, name: string|null}|null>} null when the
 *          token is valid but the user isn't a member.
 */
export async function verifyGlitchtipUser(token) {
  if (!glitchtipConfigured) return null;

  const orgs = await callGlitchtip("/api/0/organizations/", token);
  const member = (Array.isArray(orgs) ? orgs : []).some((org) => org.slug === GLITCHTIP_ORG);
  if (!member) return null;

  let email = null;
  let name = null;
  try {
    const me = await callGlitchtip("/api/0/users/me/", token);
    email = me.email || me.username || null;
    name = me.name || null;
  } catch {
    // Older GlitchTip versions scope tokens more tightly; org membership is
    // the decision, the identity is only for display.
  }

  return { email, name };
}

/** Link to a project's issue stream, or to a single event when we have one. */
export function glitchtipLink({ projectSlug, eventId } = {}) {
  if (!glitchtipConfigured) return null;
  const base = `${GLITCHTIP_URL}/${GLITCHTIP_ORG}/issues`;
  if (eventId) return `${base}?query=${encodeURIComponent(eventId)}`;
  if (projectSlug) return `${base}?project=${encodeURIComponent(projectSlug)}`;
  return base;
}

/** GlitchTip project slug for one of our app names, if we know of one. */
export function projectSlugForApp(appName) {
  return PROJECT_MAP[appName] || null;
}
