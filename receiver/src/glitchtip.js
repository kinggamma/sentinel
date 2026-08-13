import fetch from "node-fetch";
import { serviceTeam, serviceToken } from "./settings.js";

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
/**
 * There is deliberately no "the organisation" here.
 *
 * GlitchTip already knows which organisations a person belongs to and which
 * projects they can see, so naming one in configuration would either be
 * wrong the moment a second organisation exists, or would hand whoever it
 * named the right to read every other organisation's reports. Instead each
 * sign-in asks GlitchTip, and what someone sees follows from that.
 *
 * GLITCHTIP_ORG remains as an optional narrowing, for a GlitchTip that
 * serves more than this pipeline. Unset — the normal case — membership of
 * any organisation gets you in, and you see that organisation's apps.
 */
const CONFIGURED_ORG = process.env.GLITCHTIP_ORG || "";
/** Guards the session cookie against an install with hundreds of projects. */
const PROJECT_LIMIT = 200;

export function orgSlug() {
  return CONFIGURED_ORG;
}

/**
 * Sign-in is available as soon as we know where GlitchTip is. The
 * organisation can arrive later, so it isn't required here.
 */
export const glitchtipConfigured = Boolean(GLITCHTIP_URL);

export function glitchtipInfo() {
  return { url: GLITCHTIP_URL, org: orgSlug() };
}

/**
 * GlitchTip's own session cookie. Host-only and port-blind, so a browser
 * already signed in to GlitchTip on this host sends it to the receiver too —
 * which is what makes silent sign-in possible.
 */
export const GLITCHTIP_SESSION_COOKIE = process.env.GLITCHTIP_SESSION_COOKIE || "sessionid";

/**
 * One call, two ways to prove who you are: a personal auth token, or the
 * caller's own GlitchTip session forwarded back to GlitchTip.
 */
async function callGlitchtip(path, { token, sessionId } = {}, { method, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers.cookie = `${GLITCHTIP_SESSION_COOKIE}=${sessionId}`;
  if (body) headers["content-type"] = "application/json";

  const res = await fetch(`${GLITCHTIP_API_URL}${path}`, {
    method: method || "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const error = new Error(`glitchtip responded ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Resolve a GlitchTip credential to a person, but only if they belong to the
 * configured organisation. Membership of some *other* org is not access here.
 *
 * @returns {Promise<{email: string, name: string|null}|null>} null when the
 *          credential is valid but the user isn't a member.
 */
async function resolveMember(credential) {
  if (!glitchtipConfigured) return null;

  const orgs = await callGlitchtip("/api/0/organizations/", credential);
  const memberOf = (Array.isArray(orgs) ? orgs : []).map((o) => o.slug).filter(Boolean);
  if (!memberOf.length) return null;

  // GLITCHTIP_ORG is optional and only ever narrows: set it when one
  // GlitchTip serves more than this pipeline and you want a single
  // organisation to be the gate.
  const restrictTo = orgSlug();
  if (restrictTo && !memberOf.includes(restrictTo)) return null;

  /**
   * Which projects this person can see, straight from GlitchTip, with the
   * organisation each belongs to. This is what makes a shared GlitchTip work
   * without anything here having to be told about it: someone in two
   * organisations sees both organisations' apps, someone in one sees one,
   * and taking them off a team in GlitchTip takes their access away here
   * too.
   */
  let projects = [];
  try {
    const visible = await callGlitchtip("/api/0/projects/", credential);
    projects = (Array.isArray(visible) ? visible : [])
      .map((p) => ({ slug: p.slug, org: p.organization?.slug || null }))
      .filter((p) => p.slug);
  } catch (err) {
    // A token without project:read still identifies its owner, and org
    // membership already decided that they may be here — so let them in and
    // fall back to showing everything, rather than an empty viewer with no
    // explanation.
    console.warn(
      `couldn't list projects for this sign-in (${err.status || err.message}) — ` +
        "reports won't be narrowed to their projects."
    );
    projects = null;
  }

  let email = null;
  let name = null;
  try {
    const me = await callGlitchtip("/api/0/users/me/", credential);
    email = me.email || me.username || null;
    name = me.name || null;
  } catch {
    // Older GlitchTip versions scope tokens more tightly; org membership is
    // the decision, the identity is only for display.
  }

  return { email, name, orgs: memberOf, projects };
}

/** A personal auth token, pasted into the sign-in screen. */
export function verifyGlitchtipUser(token) {
  return resolveMember({ token });
}

/**
 * Who a credential belongs to, without requiring that they belong anywhere.
 *
 * Someone with a GlitchTip account and no organisation can't be let in to
 * read anything — but they can be allowed to ask, and that needs their
 * identity. Returns null only if GlitchTip doesn't recognise them at all.
 */
export async function identifyGlitchtipUser(credential) {
  if (!glitchtipConfigured) return null;
  try {
    const me = await callGlitchtip("/api/0/users/me/", credential);
    const email = me.email || me.username || null;
    return email ? { email, name: me.name || null } : null;
  } catch {
    return null;
  }
}

/**
 * Ask GlitchTip to invite someone to an organisation.
 *
 * Done with the service token rather than the approver's own credential:
 * approving happens in Sentinel, where we have a session but not the
 * GlitchTip token behind it. The service account therefore has to be a
 * manager or above in that organisation, and its token needs member:write.
 *
 * The response carries the acceptance link. That matters more than it
 * sounds: with email disabled — which is the default here — it is the only
 * way the invitation can reach the person it's for.
 */
export async function inviteToOrg({ org, email, role = "member" }) {
  if (!glitchtipConfigured) throw new Error("GlitchTip isn't configured");
  if (!serviceToken()) {
    const err = new Error(
      "No GlitchTip service token is set, so invitations can't be sent from here. " +
        "Add one in Settings, or invite them in GlitchTip under Organization > Members."
    );
    err.status = 501;
    throw err;
  }

  const created = await callGlitchtip(
    `/api/0/organizations/${org}/members/`,
    { token: serviceToken() },
    { method: "POST", body: { email, orgRole: role, teamRoles: [] } }
  );
  return { inviteLink: created.inviteLink || created.invite_link || null };
}

/**
 * The caller's own GlitchTip session, handed straight back to GlitchTip to
 * ask who it belongs to. Note that a session skips GlitchTip's token-scope
 * check entirely — `has_permission` only applies it to token auth — so this
 * works without anyone having to tick org:read on anything.
 */
export function verifyGlitchtipSession(sessionId) {
  return resolveMember({ sessionId });
}

/**
 * Creating projects on an app's behalf.
 *
 * A token, never a browser session: GlitchTip only enforces token scopes on
 * token auth, so the scopes below are a real limit here and would be no
 * limit at all through a session. Give this token project:write and NOT
 * project:admin — creating a project needs the former, deleting one needs
 * the latter, so a leak can't lose you a project's history. The account
 * still has to be an organisation admin; that part GlitchTip checks by role
 * and no scope can soften it.
 */
// Read through settings so they can be set in the viewer as well as the
// environment, and take effect without a restart.

/**
 * A function rather than a constant: the organisation may not be known when
 * this module loads, since it can be learned at the first sign-in.
 */
export function provisioningReady() {
  return Boolean(glitchtipConfigured && serviceToken() && serviceTeam() && orgSlug());
}

/** GlitchTip slugs are lowercase, dashed, and have to be unique in the org. */
export function slugify(appName) {
  return String(appName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Create the GlitchTip project an app reports to, and return its slug and
 * DSN. Returns null when provisioning isn't configured.
 *
 * A slug collision (409/400) is treated as success: something already owns
 * that slug, which is the state we wanted anyway.
 */
export async function createProjectForApp(appName) {
  if (!provisioningReady()) return null;

  const slug = slugify(appName);
  if (!slug) throw new Error(`"${appName}" has no usable slug`);

  try {
    const project = await callGlitchtip(
      `/api/0/teams/${orgSlug()}/${serviceTeam()}/projects/`,
      { token: serviceToken() },
      { method: "POST", body: { name: appName, slug, platform: null } }
    );
    return { slug: project.slug || slug, dsn: await fetchProjectDsn(project.slug || slug) };
  } catch (err) {
    if (err.status === 400 || err.status === 409) {
      // Already there. Adopt it rather than failing — the point is that the
      // app ends up with somewhere to report.
      return { slug, dsn: await fetchProjectDsn(slug).catch(() => null) };
    }
    throw err;
  }
}

/** The public DSN of a project, which is what an app's SDK needs. */
export async function fetchProjectDsn(projectSlug) {
  if (!provisioningReady()) return null;
  const keys = await callGlitchtip(
    `/api/0/projects/${orgSlug()}/${projectSlug}/keys/`,
    { token: serviceToken() }
  );
  const key = (Array.isArray(keys) ? keys : [])[0];
  return key?.dsn?.public || null;
}

/**
 * End the caller's GlitchTip session as well as ours.
 *
 * Signing out of one of two things that feel like one thing, and staying
 * signed in to the other, is the sort of detail that makes them feel like
 * two again. Best effort: allauth guards this with CSRF, and the browser
 * hands us its csrftoken cookie for the same reason it hands us sessionid,
 * so we can usually satisfy it. When we can't, expiring the cookie still
 * signs the browser out — it just leaves the session record to age out on
 * GlitchTip's side rather than being destroyed now.
 */
export async function revokeGlitchtipSession({ sessionId, csrfToken }) {
  if (!glitchtipConfigured || !sessionId) return false;

  const cookies = [`${GLITCHTIP_SESSION_COOKIE}=${sessionId}`];
  if (csrfToken) cookies.push(`csrftoken=${csrfToken}`);

  try {
    const res = await fetch(`${GLITCHTIP_API_URL}/_allauth/browser/v1/auth/session`, {
      method: "DELETE",
      headers: {
        cookie: cookies.join("; "),
        accept: "application/json",
        ...(csrfToken ? { "x-csrftoken": csrfToken, referer: GLITCHTIP_API_URL } : {}),
      },
    });
    // allauth answers 401 once the session is gone, which is the outcome we
    // were after.
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/** Link to a project's issue stream, or to a single event when we have one. */
export function glitchtipLink({ projectSlug, org, eventId } = {}) {
  if (!glitchtipConfigured) return null;
  // Without an organisation there is no URL to build: GlitchTip's issue
  // stream lives under /<org>/issues, and guessing would send people to
  // somebody else's.
  const owner = org || orgSlug();
  if (!owner) return null;
  const base = `${GLITCHTIP_URL}/${owner}/issues`;
  if (eventId) return `${base}?query=${encodeURIComponent(eventId)}`;
  if (projectSlug) return `${base}?project=${encodeURIComponent(projectSlug)}`;
  return base;
}
