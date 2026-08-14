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
export const GLITCHTIP_API_URL = (process.env.GLITCHTIP_API_URL || GLITCHTIP_URL).replace(/\/+$/, "");
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
export async function callGlitchtip(path, { token, sessionId } = {}, { method, body } = {}) {
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
 * Resolving a credential to a person used to live here — resolveMember(),
 * verifyGlitchtipUser(), verifyGlitchtipSession() and identifyGlitchtipUser().
 * All four existed to turn a token or a cookie into a Sentinel session, and
 * there is no Sentinel session any more. src/auth/identity.js answers the same
 * question per request, from GlitchTip's own cookie, and reduces it through
 * the state machine rather than freezing it into one of ours.
 */

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

  /**
   * Django refuses this without a CSRF token, and there is not always a
   * browser to have supplied one — an idle session is ended by the receiver
   * on its own initiative, with nobody present. So when none is offered, get
   * one the same way a browser would: ask allauth for the session, which
   * hands one back in a Set-Cookie, and echo it.
   *
   * Without this the request came back 403, the caller swallowed it, and the
   * session went on working everywhere except the screen that had just
   * decided to end it.
   */
  if (!csrfToken) {
    try {
      const primer = await fetch(`${GLITCHTIP_API_URL}/_allauth/browser/v1/auth/session`, {
        headers: { cookie: `${GLITCHTIP_SESSION_COOKIE}=${sessionId}`, accept: "application/json" },
      });
      csrfToken = (primer.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1] || null;
    } catch {
      // Fall through: the attempt below will simply fail, and say so.
    }
  }

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
