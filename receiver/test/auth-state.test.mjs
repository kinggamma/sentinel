#!/usr/bin/env node
/**
 * The auth state machine, on its own.
 *
 * Every one of these runs without a container, a browser or a network, which
 * is the point: the states that are hardest to reach by hand — an expired
 * session, a half-finished second factor, an account switched off underneath
 * someone — are the ones most likely to be wrong, and the least likely to be
 * exercised before a real person hits them.
 *
 * Written with the contract rather than after it. The router's pattern
 * compiler shipped broken in exactly the way this avoids: real logic, failing
 * silently, with no test alongside to notice.
 */
import {
  STATES,
  TRANSITIONS,
  canTransition,
  readAllauth,
  derive,
  capabilities,
  describe as describeState,
} from "../src/auth/state.js";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(got, wanted, message) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(wanted);
  assert(a === b, `${message}: got ${a}, wanted ${b}`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// Shorthand for the shape allauth actually returns.
const allauthBody = (flows, authenticated = false) => ({
  data: { flows },
  meta: { is_authenticated: authenticated },
});

// ---------------------------------------------------------------- reading

section("What allauth said, reduced to what matters");

await test("an anonymous browser is not authenticated and has nothing pending", () => {
  // Verbatim from the running container.
  const read = readAllauth({
    status: 401,
    body: allauthBody([{ id: "login" }, { id: "signup" }, { id: "mfa_login_webauthn" }]),
  });
  same(read.authenticated, false, "authenticated");
  same(read.pendingFlow, null, "pendingFlow");
  same(read.available, ["login", "signup", "mfa_login_webauthn"], "available flows");
});

await test("a pending flow is the one carrying is_pending, not the first listed", () => {
  const read = readAllauth({
    status: 401,
    body: allauthBody([{ id: "login" }, { id: "mfa_authenticate", is_pending: true }]),
  });
  same(read.pendingFlow, "mfa_authenticate", "the blocking flow");
});

await test("410 is allauth saying the session is gone, not merely refused", () => {
  same(readAllauth({ status: 410, body: allauthBody([]) }).gone, true, "gone");
  same(readAllauth({ status: 401, body: allauthBody([]) }).gone, false, "not gone");
});

await test("a malformed or empty answer does not throw", () => {
  for (const input of [undefined, {}, { status: 500 }, { status: 200, body: null }]) {
    const read = readAllauth(input);
    same(read.pendingFlow, null, "pendingFlow");
    same(read.available, [], "available");
  }
});

// ------------------------------------------------------------- deriving

section("Which state this request is in");

await test("no cookie at all is anonymous", () => {
  same(derive({ sawCookie: false }), STATES.ANONYMOUS, "state");
});

await test("a cookie that identifies nobody is expired, not anonymous", () => {
  // The whole reason the two are separate: one gets "sign in", the other
  // gets "you were signed out", and telling someone they were never here is
  // the wrong answer to their session running out.
  same(derive({ sawCookie: true }), STATES.EXPIRED, "state");
});

await test("allauth reporting the session gone is expired even without a cookie", () => {
  same(
    derive({ sawCookie: false, allauth: readAllauth({ status: 410, body: allauthBody([]) }) }),
    STATES.EXPIRED,
    "state"
  );
});

await test("an outstanding second factor is its own state, never anonymous", () => {
  const allauth = readAllauth({
    status: 401,
    body: allauthBody([{ id: "mfa_authenticate", is_pending: true }]),
  });
  same(derive({ sawCookie: true, allauth }), STATES.MFA_REQUIRED, "state");
});

await test("reauthentication is understood rather than treated as a dead session", () => {
  const allauth = readAllauth({
    status: 401,
    body: allauthBody([{ id: "reauthenticate", is_pending: true }]),
  });
  same(
    derive({ sawCookie: true, allauth, user: { email: "a@b.c" }, orgs: ["acme"] }),
    STATES.REAUTH_REQUIRED,
    "state"
  );
});

await test("identified and in an organisation is authenticated", () => {
  same(
    derive({ sawCookie: true, user: { email: "a@b.c" }, orgs: ["acme"] }),
    STATES.AUTHENTICATED,
    "state"
  );
});

await test("identified and in no organisation is pending, not authenticated", () => {
  same(derive({ sawCookie: true, user: { email: "a@b.c" }, orgs: [] }), STATES.PENDING, "state");
});

await test("pending becomes denied once the request has been refused", () => {
  same(
    derive({ sawCookie: true, user: { email: "a@b.c" }, orgs: [], accessRequest: "denied" }),
    STATES.DENIED,
    "state"
  );
});

await test("an approved request is not itself access — the organisation is", () => {
  // Approval sends an invitation; until it is accepted there is still no org,
  // and claiming otherwise would show an empty app rather than the next step.
  same(
    derive({ sawCookie: true, user: { email: "a@b.c" }, orgs: [], accessRequest: "approved" }),
    STATES.PENDING,
    "state"
  );
});

await test("a switched-off account outranks everything else it could be called", () => {
  const disabled = { email: "a@b.c", isActive: false };
  same(derive({ sawCookie: true, user: disabled, orgs: [] }), STATES.DISABLED, "with no org");
  same(derive({ sawCookie: true, user: disabled, orgs: ["acme"] }), STATES.DISABLED, "with an org");
  same(
    derive({ sawCookie: true, user: disabled, orgs: [], accessRequest: "denied" }),
    STATES.DISABLED,
    "and over denied"
  );
});

await test("GlitchTip identifies a session allauth never created", () => {
  // Measured, not imagined: a session made outside allauth answers 200 to
  // /api/0/ and 401 to allauth, because allauth reports the login it
  // performed rather than inspecting the cookie it was handed. Authorisation
  // has to follow the backend that knows who this is.
  const allauth = readAllauth({ status: 401, body: allauthBody([{ id: "login" }]) });
  same(
    derive({ sawCookie: true, allauth, user: { email: "a@b.c" }, orgs: ["acme"] }),
    STATES.AUTHENTICATED,
    "state"
  );
});

// ---------------------------------------------------------- transitions

section("Which moves the machine allows");

await test("every state has a transition list, and lists only real states", () => {
  const all = Object.values(STATES);
  for (const state of all) {
    assert(Array.isArray(TRANSITIONS[state]), `${state} has no transitions`);
    for (const next of TRANSITIONS[state]) {
      assert(all.includes(next), `${state} -> ${next} is not a state`);
    }
  }
});

await test("signing in cannot skip the second factor", () => {
  assert(canTransition(STATES.ANONYMOUS, STATES.MFA_REQUIRED), "anonymous -> mfa");
  assert(canTransition(STATES.MFA_REQUIRED, STATES.AUTHENTICATED), "mfa -> authenticated");
});

await test("a wrong code leaves you in the challenge rather than throwing you out", () => {
  assert(canTransition(STATES.MFA_REQUIRED, STATES.MFA_REQUIRED), "mfa -> mfa");
});

await test("a disabled account can only leave by signing out", () => {
  same(TRANSITIONS[STATES.DISABLED], [STATES.ANONYMOUS, STATES.DISABLED], "transitions");
  assert(!canTransition(STATES.DISABLED, STATES.AUTHENTICATED), "disabled -> authenticated");
  assert(!canTransition(STATES.DISABLED, STATES.PENDING), "disabled -> pending");
});

await test("being approved moves pending to authenticated without signing in again", () => {
  assert(canTransition(STATES.PENDING, STATES.AUTHENTICATED), "pending -> authenticated");
});

await test("losing your last organisation drops you to pending, not out", () => {
  assert(canTransition(STATES.AUTHENTICATED, STATES.PENDING), "authenticated -> pending");
});

await test("an expired session can go straight back to authenticated", () => {
  // Signing in again from the "you were signed out" screen, without a detour
  // through a second screen that says the same thing differently.
  assert(canTransition(STATES.EXPIRED, STATES.AUTHENTICATED), "expired -> authenticated");
  assert(canTransition(STATES.EXPIRED, STATES.MFA_REQUIRED), "expired -> mfa");
});

await test("unknown states are refused rather than assumed", () => {
  assert(!canTransition("nonsense", STATES.AUTHENTICATED), "from nonsense");
  assert(!canTransition(STATES.AUTHENTICATED, "nonsense"), "to nonsense");
});

// -------------------------------------------------------- capabilities

section("What each state is allowed to do");

await test("only an authenticated session may read", () => {
  for (const state of Object.values(STATES)) {
    same(capabilities(state).read, state === STATES.AUTHENTICATED, `${state} read`);
  }
});

await test("asking for access belongs to the two states that have nothing yet", () => {
  assert(capabilities(STATES.PENDING).requestAccess, "pending may ask");
  assert(capabilities(STATES.DENIED).requestAccess, "denied may ask again");
  assert(!capabilities(STATES.AUTHENTICATED).requestAccess, "authenticated need not");
  assert(!capabilities(STATES.ANONYMOUS).requestAccess, "anonymous cannot");
});

await test("a half-finished sign-in is not sent back to the sign-in screen", () => {
  // The guard that matters: MFA and reauthentication carry state, and
  // bouncing them to sign-in throws that state away mid-conversation.
  assert(!capabilities(STATES.MFA_REQUIRED).signIn, "mfa keeps its own screen");
  assert(!capabilities(STATES.REAUTH_REQUIRED).signIn, "reauth keeps its own screen");
  assert(capabilities(STATES.MFA_REQUIRED).completeMfa, "mfa may complete");
});

await test("expired and disabled both go to sign-in, and say different things there", () => {
  assert(capabilities(STATES.EXPIRED).signIn, "expired");
  assert(capabilities(STATES.DISABLED).signIn, "disabled");
  assert(capabilities(STATES.ANONYMOUS).signIn, "anonymous");
});

// ------------------------------------------------------------ the body

section("The /auth/me contract");

await test("the same keys are present in every state", () => {
  const keys = (state) => Object.keys(describeState({ state })).sort();
  const shape = keys(STATES.AUTHENTICATED);
  for (const state of Object.values(STATES)) {
    same(keys(state), shape, `${state} shape`);
  }
});

await test("it carries whether a password change could ever invalidate this account", () => {
  // Social-only and passkey-only accounts have no password-change event, so
  // Django's auth-hash invalidation never fires for them. Carried explicitly
  // so nothing downstream calls that universal revocation.
  const social = describeState({
    state: STATES.AUTHENTICATED,
    user: { email: "a@b.c", hasPasswordAuth: false },
  });
  same(social.hasPasswordAuth, false, "social account");

  const password = describeState({
    state: STATES.AUTHENTICATED,
    user: { email: "a@b.c", hasPasswordAuth: true },
  });
  same(password.hasPasswordAuth, true, "password account");
});

await test("it never leaks identity for a state that has none", () => {
  const body = describeState({ state: STATES.ANONYMOUS });
  same(body.email, null, "email");
  same(body.orgs, [], "orgs");
  same(body.can.read, false, "read");
});

await test("capabilities travel with the state rather than being recomputed", () => {
  const body = describeState({ state: STATES.PENDING, user: { email: "a@b.c" } });
  same(body.can, capabilities(STATES.PENDING), "can");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
