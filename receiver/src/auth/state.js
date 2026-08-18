/**
 * What a session is, and what it is allowed to become.
 *
 * There is one session — GlitchTip's `sessionid` — and Sentinel does not mint
 * another. This module is the read-only reading of it: given what the two
 * backends said, which state is this, and is the move being attempted one the
 * machine allows.
 *
 * It is deliberately pure. Nothing here fetches, reads a cookie, or touches
 * `req`; the adapters above it do that and hand the facts down. That is what
 * makes every transition testable without a browser, a container, or a clock.
 *
 * Two backends answer two different questions, and conflating them was the
 * first thing this design got wrong:
 *
 *   allauth (`/_allauth/browser/v1/auth/session`) knows the *auth* state —
 *   whether a login completed, whether a second factor is outstanding,
 *   whether it wants reauthentication. It reports on its own flow, not on
 *   `request.user`.
 *
 *   GlitchTip's API (`/api/0/users/me/`, `/api/0/organizations/`) knows the
 *   *identity and authorisation* — who this is, and which organisations they
 *   belong to, which is what decides whether they can read anything.
 *
 * They can disagree, and the disagreement is not hypothetical: a session
 * created outside allauth is authenticated to `/api/0/` and anonymous to
 * allauth, because allauth records the login it performed rather than
 * inspecting the session it was handed.
 */

/**
 * @typedef {"anonymous"|"mfa_required"|"reauth_required"|"pending"|"denied"
 *   |"disabled"|"expired"|"authenticated"} AuthState
 */

export const STATES = Object.freeze({
  /** No session was presented at all. The sign-in screen. */
  ANONYMOUS: "anonymous",
  /** Credentials accepted, second factor outstanding. Carries state; never a redirect to sign-in. */
  MFA_REQUIRED: "mfa_required",
  /**
   * allauth wants the password again before a sensitive operation.
   * Understood so it is never mistaken for a dead session — but in this
   * deployment it cannot fire: ACCOUNT_REAUTHENTICATION_TIMEOUT is derived
   * from SESSION_COOKIE_AGE rather than read from env, so the window is always
   * the whole session. No screen is built behind it.
   */
  REAUTH_REQUIRED: "reauth_required",
  /** A real account in no organisation. Can ask for access; can read nothing. */
  PENDING: "pending",
  /** Asked, and was turned down. Distinct from pending so it can say so. */
  DENIED: "denied",
  /** The account exists and has been switched off. */
  DISABLED: "disabled",
  /**
   * A session was presented and is no longer good. Distinct from anonymous
   * because the two deserve different words: one is "sign in", the other is
   * "you were signed out".
   */
  EXPIRED: "expired",
  /** Signed in, in at least one organisation. */
  AUTHENTICATED: "authenticated",
});

const ALL = Object.values(STATES);

/**
 * Which moves are legal.
 *
 * Written out rather than inferred so that an impossible move — say, straight
 * from anonymous to authenticated without a login, or out of `disabled` by
 * anything other than being re-enabled — fails a test rather than quietly
 * working because some code path happened to allow it.
 */
export const TRANSITIONS = Object.freeze({
  [STATES.ANONYMOUS]: [
    STATES.MFA_REQUIRED, // credentials accepted, second factor outstanding
    STATES.AUTHENTICATED, // credentials accepted, no second factor, has an org
    STATES.PENDING, // credentials accepted, belongs to nothing yet
    STATES.DENIED, // signs in, and their request was refused
    STATES.DISABLED, // the account is switched off
    STATES.ANONYMOUS, // a failed attempt is not a state change
  ],
  [STATES.MFA_REQUIRED]: [
    STATES.AUTHENTICATED,
    STATES.PENDING,
    STATES.DENIED,
    STATES.DISABLED,
    STATES.ANONYMOUS, // abandoned or failed out of the challenge
    STATES.MFA_REQUIRED, // a wrong code leaves you exactly where you were
  ],
  [STATES.REAUTH_REQUIRED]: [
    STATES.AUTHENTICATED,
    STATES.ANONYMOUS,
    STATES.EXPIRED,
    STATES.REAUTH_REQUIRED,
  ],
  [STATES.PENDING]: [
    STATES.AUTHENTICATED, // approved into an organisation
    STATES.DENIED,
    STATES.DISABLED,
    STATES.EXPIRED,
    STATES.ANONYMOUS, // signed out
    STATES.PENDING,
  ],
  [STATES.DENIED]: [
    STATES.PENDING, // asked again
    STATES.AUTHENTICATED, // someone changed their mind
    STATES.DISABLED,
    STATES.EXPIRED,
    STATES.ANONYMOUS,
    STATES.DENIED,
  ],
  // Only an administrator re-enabling the account gets you out of here, and
  // that arrives as a fresh sign-in.
  [STATES.DISABLED]: [STATES.ANONYMOUS, STATES.DISABLED],
  [STATES.EXPIRED]: [
    STATES.ANONYMOUS, // acknowledged, or the cookie was cleared
    STATES.MFA_REQUIRED,
    STATES.AUTHENTICATED,
    STATES.PENDING,
    STATES.DENIED,
    STATES.DISABLED,
    STATES.EXPIRED,
  ],
  [STATES.AUTHENTICATED]: [
    STATES.EXPIRED, // idle window passed, or the absolute cap
    STATES.ANONYMOUS, // signed out deliberately
    STATES.REAUTH_REQUIRED,
    STATES.PENDING, // removed from their last organisation
    STATES.DENIED,
    STATES.DISABLED,
    STATES.AUTHENTICATED,
  ],
});

export function canTransition(from, to) {
  if (!ALL.includes(from) || !ALL.includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * allauth's answer, reduced to the two facts that matter.
 *
 * Its shape is a status plus `data.flows`, where a flow carrying
 * `is_pending: true` is the one blocking progress. Everything else in that
 * payload describes what *could* be started, not what is happening.
 *
 * A 410 means the session it knew about is gone — allauth says so explicitly
 * rather than making us infer it from a 401.
 */
export function readAllauth({ status, body } = {}) {
  const flows = body?.data?.flows || [];
  const pending = flows.find((flow) => flow?.is_pending) || null;

  return {
    authenticated: Boolean(body?.meta?.is_authenticated),
    gone: status === 410,
    pendingFlow: pending?.id || null,
    // What this installation offers, for gating the screens we render.
    available: flows.map((flow) => flow?.id).filter(Boolean),
  };
}

/**
 * The state, from everything known about one request.
 *
 * @param {object} facts
 * @param {boolean} facts.sawCookie - a session cookie arrived, whatever it
 *   turned out to be worth. The only thing separating "you were signed out"
 *   from "you were never signed in".
 * @param {ReturnType<readAllauth>} [facts.allauth]
 * @param {{ isActive?: boolean }|null} [facts.user] - from /api/0/users/me/,
 *   or null when GlitchTip would not identify the caller.
 * @param {string[]} [facts.orgs] - organisation slugs this account belongs to.
 * @param {"pending"|"approved"|"denied"|null} [facts.accessRequest] - what
 *   Sentinel's own access queue says, which GlitchTip has no concept of.
 * @returns {AuthState}
 */
export function derive({
  sawCookie = false,
  allauth = null,
  user = null,
  orgs = [],
  accessRequest = null,
} = {}) {
  // Switched off outranks everything else that could be said about them: an
  // account that is disabled and also in no organisation should be told the
  // thing it can do nothing about.
  if (user && user.isActive === false) return STATES.DISABLED;

  // A second factor outstanding is not a failure to authenticate, and must
  // never be answered with "sign in again" — the flow it belongs to would be
  // thrown away at the moment it is half finished.
  if (allauth?.pendingFlow === "mfa_authenticate") return STATES.MFA_REQUIRED;
  if (allauth?.pendingFlow === "reauthenticate") return STATES.REAUTH_REQUIRED;

  // Authorisation is GlitchTip's answer, not allauth's. A session allauth
  // did not create still identifies a real user to /api/0/, and the reverse —
  // allauth mid-flow with no usable identity yet — is the case above.
  const identified = Boolean(user);
  if (!identified) {
    if (allauth?.gone) return STATES.EXPIRED;
    return sawCookie ? STATES.EXPIRED : STATES.ANONYMOUS;
  }

  if (orgs.length > 0) return STATES.AUTHENTICATED;
  if (accessRequest === "denied") return STATES.DENIED;
  return STATES.PENDING;
}

/**
 * What this session may do — conclusions, not the facts they were drawn from.
 *
 * The client is handed answers rather than ingredients. Shipping
 * `hasPasswordAuth` and letting each screen work out what it implies is how
 * two screens end up implying different things from it; the interesting one
 * here is a security claim, and it has exactly one correct reading.
 *
 * Unknown reads as "no" throughout. These gate actions, and a fact we could
 * not establish must never open a door.
 */
export function capabilities({ state, user = null, orgs = [] } = {}) {
  /**
   * Two different questions, and conflating them produced a contradiction.
   *
   * `authorised` is "may this person see Sentinel's data", which needs an
   * organisation. `signedIn` is "is there a real account behind this
   * session", which does not — pending and denied are fully authenticated
   * identities that simply have nowhere to go yet, and reauthentication is a
   * live session being asked to prove itself again.
   *
   * Account-level abilities belong to the second. Gating them on the first
   * told a pending user with a password that they could not change it while
   * simultaneously telling them that changing it would sign their other
   * sessions out.
   */
  const authorised = state === STATES.AUTHENTICATED;
  const signedIn = [
    STATES.AUTHENTICATED,
    STATES.PENDING,
    STATES.DENIED,
    STATES.REAUTH_REQUIRED,
  ].includes(state);

  // Explicitly true, not merely truthy: null means "we could not tell".
  const hasPassword = user?.hasPasswordAuth === true;

  return Object.freeze({
    canRead: authorised,

    canRequestAccess: state === STATES.PENDING || state === STATES.DENIED,

    /**
     * Approving somebody is performed with Sentinel's own service token
     * rather than the approver's credentials (glitchtip.js: inviteToOrg), so
     * GlitchTip never checks the caller's role and the only real guard is
     * membership. Encoded as it actually behaves. If approval is ever meant
     * to need manager or above, this is the line that changes, and the lie
     * would have been telling the UI it already does.
     */
    canManageAccess: authorised && orgs.length > 0,

    /**
     * Changing a password needs one to exist. A social-only or passkey-only
     * account is offered "set a password" instead, which is a different flow
     * with a different endpoint.
     */
    canChangePassword: signedIn && hasPassword,

    /**
     * Whether a password change would actually sign this account's other
     * sessions out. Django derives the session auth hash from the password
     * hash, so it does — but only for accounts that have a password. A
     * social-only or passkey-only account has no password-change event, and
     * nothing invalidates its sessions until per-user session indexing
     * exists. This is why the flag is a conclusion and not a raw fact: it is
     * the difference between "we revoked your sessions" and "we did not".
     *
     * Identical to canChangePassword today, and deliberately not aliased to
     * it: one is permission to perform an action, the other is what that
     * action would achieve. A policy forbidding password changes without
     * altering Django's invalidation would separate them again.
     */
    canInvalidateSessionsByPasswordChange: signedIn && hasPassword,

    // Routing, rather than authorisation. MFA and reauthentication are
    // mid-conversation and own their own screens; sending them to sign-in
    // discards the flow at the moment it is half finished.
    canSignIn: [STATES.ANONYMOUS, STATES.EXPIRED, STATES.DISABLED].includes(state),
    canCompleteMfa: state === STATES.MFA_REQUIRED,
  });
}

/**
 * The `/auth/me` body. One shape, whatever the state, so the client never has
 * to branch on which keys are present.
 */
export function describe({ state, user = null, orgs = [], orgRoles = {}, allauth = null } = {}) {
  return {
    state,
    email: user?.email || null,
    name: user?.name || null,
    orgs,
    // Kept alongside the conclusions rather than instead of them: a screen
    // that needs to explain *why* it is offering "set a password" instead of
    // "change password" needs the fact, not just the verdict.
    hasPasswordAuth: user?.hasPasswordAuth ?? null,
    available: allauth?.available || [],
    /**
     * What this person may do, per organisation.
     *
     * Beside `can` rather than inside it, because these answers depend on
     * which organisation is being looked at and the ones in `can` do not.
     * Folding them together would mean either publishing the most a person
     * can do anywhere — offering controls that fail in the organisation
     * actually on screen — or making `can` change meaning when the switcher
     * moves.
     *
     * Still the server's conclusions and not the client's: a screen looks up
     * the organisation it is showing and reads the answer, exactly as it
     * reads `can`, and works nothing out for itself.
     */
    orgRoles,
    can: capabilities({ state, user, orgs }),
  };
}
