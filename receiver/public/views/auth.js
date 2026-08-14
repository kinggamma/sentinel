/**
 * Signing in, and everything around it.
 *
 * Sentinel's form, GlitchTip's accounts, one session. Every screen here posts
 * to allauth on this same origin and the session it creates is the only one
 * there is — Sentinel mints nothing and stores nothing.
 *
 * These are routes rather than a panel that gets unhidden, and one of them
 * settles it: a password reset link arrives by email carrying a key, and that
 * link has to land somewhere. /password/reset?key=… is somewhere.
 *
 * What exists is decided by allauth, not by us. It publishes a capability
 * document at /_allauth/browser/v1/config saying which login methods it
 * accepts, whether signup is open, which second factors it supports and which
 * social providers are configured. Rendering a button for something this
 * installation does not have is how you get a screen that 404s on submit, so
 * everything below is gated on that document.
 */
import { allauth } from "../lib/api.js";
import { h, fill } from "../lib/dom.js";
import { go, href as routeHref } from "../lib/router.js";
import { forget as forgetSession } from "../lib/session.js";
import { safeNext } from "../lib/next.js";

let capabilities = null;

/** What this installation offers. Asked once; it changes when GlitchTip is
 *  reconfigured, which restarts it. */
export async function authConfig() {
  if (capabilities) return capabilities;
  try {
    const body = await allauth.get("/config");
    capabilities = body?.data || {};
  } catch {
    // Unreachable: offer the one thing that always exists rather than a
    // screen with nothing on it.
    capabilities = { account: { login_methods: ["email"] }, socialaccount: { providers: [] } };
  }
  return capabilities;
}

// ------------------------------------------------------------- the shell

/** The centred card every screen here shares. */
function card(title, ...children) {
  return h(
    "div",
    { className: "gate" },
    h("section", { className: "gate-card" }, h("h1", { text: title }), children)
  );
}

function field({ id, type, label, autocomplete, value = "" }) {
  return h("input", {
    id,
    type,
    value,
    attrs: { placeholder: label, "aria-label": label, autocomplete },
  });
}

/** A message that says what to do, not what went wrong internally. */
function problem() {
  const node = h("p", { className: "error" });
  node.hidden = true;
  return {
    node,
    show(message) {
      node.hidden = false;
      node.textContent = message;
    },
    clear() {
      node.hidden = true;
      node.textContent = "";
    },
  };
}

/**
 * allauth answers a failed attempt with a list of errors, each carrying the
 * parameter it belongs to. Joining them beats "something went wrong", which
 * is what a caller sees if it only reads the status.
 */
function readErrors(error, fallback) {
  const errors = error?.body?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((entry) => entry.message).filter(Boolean).join(" ");
  }
  return error?.message || fallback;
}

/**
 * Where a completed step lands.
 *
 * allauth answers a successful login with 200 when it is finished and 401
 * when it is not — a second factor still outstanding is a 401 carrying a
 * pending flow, which is emphatically not a refusal. Reading only the status
 * would send somebody back to the sign-in screen at the exact moment they
 * were half way through it.
 */
function afterAuthStep(body, next) {
  const pending = (body?.data?.flows || []).find((flow) => flow?.is_pending);
  forgetSession();
  if (pending?.id === "mfa_authenticate") {
    return go(`/mfa?next=${encodeURIComponent(next)}`, { replace: true });
  }
  return go(next, { replace: true });
}

// -------------------------------------------------------------- sign in

export async function signInView({ outlet, query }) {
  const config = await authConfig();
  const next = safeNext(query);
  const canSignUp = config?.account?.is_open_for_signup;
  const providers = config?.socialaccount?.providers || [];

  const email = field({ id: "email-input", type: "email", label: "Email", autocomplete: "username" });
  const password = field({
    id: "password-input",
    type: "password",
    label: "Password",
    autocomplete: "current-password",
  });
  const error = problem();
  const submit = h("button", { type: "submit", text: "Sign in" });

  // Arrived from a completed reset. Saying so is the difference between
  // "did that work?" and knowing it did.
  const reset = query?.reset
    ? h("p", { className: "gate-hint muted", text: "Your password has been changed. Sign in with it." })
    : null;

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.clear();
          if (!email.value.trim() || !password.value) {
            return error.show("Enter your email and password.");
          }

          submit.disabled = true;
          try {
            const body = await allauth.post("/auth/login", {
              email: email.value.trim(),
              password: password.value,
            });
            password.value = "";
            await afterAuthStep(body, next);
          } catch (failure) {
            // A 401 here can mean two opposite things, and telling them apart
            // is the difference between "wrong password" and throwing away a
            // half-finished login.
            const pending = (failure?.body?.data?.flows || []).find((flow) => flow?.is_pending);
            if (pending?.id === "mfa_authenticate") {
              password.value = "";
              forgetSession();
              return go(`/mfa?next=${encodeURIComponent(next)}`, { replace: true });
            }
            error.show(readErrors(failure, "That email and password weren't accepted."));
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
    reset,
    email,
    password,
    submit,
    error.node,
    h(
      "p",
      { className: "gate-hint muted" },
      h("a", { href: routeHref("/password/request"), text: "Forgot your password?" })
    ),
    // Only when this installation actually accepts new accounts. GlitchTip
    // can be closed to signup, and offering a link to a screen that refuses
    // is worse than not offering it.
    canSignUp
      ? h(
          "p",
          { className: "gate-hint muted" },
          "No account? ",
          h("a", { href: routeHref(`/signup?next=${encodeURIComponent(next)}`), text: "Create one" })
        )
      : null,
    // Rendered from what is configured, which on an installation with no
    // providers is nothing at all rather than an empty row of buttons.
    providers.length
      ? h(
          "div",
          { className: "providers" },
          providers.map((provider) =>
            h("a", {
              className: "button-link",
              href: `/_allauth/browser/v1/auth/provider/redirect?provider=${encodeURIComponent(provider.id)}`,
              rel: "external",
              text: `Continue with ${provider.name || provider.id}`,
            })
          )
        )
      : null
  );

  fill(outlet, card("Sentinel", form));
  email.focus();
}

// -------------------------------------------------------------- sign up

export async function signUpView({ outlet, query }) {
  const config = await authConfig();
  const next = safeNext(query);

  if (!config?.account?.is_open_for_signup) {
    fill(
      outlet,
      card(
        "Registration is closed",
        h("p", { className: "muted", text: "This Sentinel doesn't accept new accounts." }),
        h("a", { className: "button-link", href: routeHref("/signin"), text: "Back to sign in" })
      )
    );
    return;
  }

  const email = field({ id: "email-input", type: "email", label: "Email", autocomplete: "username" });
  const password = field({
    id: "password-input",
    type: "password",
    label: "Password",
    autocomplete: "new-password",
  });
  const error = problem();
  const submit = h("button", { type: "submit", text: "Create account" });

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.clear();
          submit.disabled = true;
          try {
            const body = await allauth.post("/auth/signup", {
              email: email.value.trim(),
              password: password.value,
            });
            password.value = "";
            await afterAuthStep(body, next);
          } catch (failure) {
            error.show(readErrors(failure, "That account couldn't be created."));
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
    email,
    password,
    submit,
    error.node,
    h(
      "p",
      { className: "gate-hint muted" },
      // Said before they sign up rather than after: a new account belongs to
      // no organisation, and landing on "you can't see anything yet" with no
      // warning reads as a broken app.
      "A new account can't see anything until somebody adds it to an organisation."
    ),
    h(
      "p",
      { className: "gate-hint muted" },
      h("a", { href: routeHref("/signin"), text: "← Back to sign in" })
    )
  );

  fill(outlet, card("Create an account", form));
  email.focus();
}

// ------------------------------------------------------------- password

export async function passwordRequestView({ outlet }) {
  const email = field({ id: "email-input", type: "email", label: "Email", autocomplete: "username" });
  const error = problem();
  const submit = h("button", { type: "submit", text: "Send a reset link" });
  const done = h("p", { className: "muted" });
  done.hidden = true;

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.clear();
          submit.disabled = true;
          try {
            await allauth.post("/auth/password/request", { email: email.value.trim() });
          } catch (failure) {
            // 400 for a malformed address is worth saying; anything else is
            // not, for the reason below.
            if (failure?.status === 400) {
              submit.disabled = false;
              return error.show(readErrors(failure, "That doesn't look like an email address."));
            }
          }
          /**
           * The same answer either way, deliberately. Saying "no such
           * account" turns this form into a way to find out who has one.
           */
          done.hidden = false;
          done.textContent =
            "If that address has an account, a reset link is on its way. The link expires, so use it soon.";
          form.querySelectorAll("input, button").forEach((node) => (node.disabled = true));
        },
      },
    },
    email,
    submit,
    error.node,
    done,
    h(
      "p",
      { className: "gate-hint muted" },
      h("a", { href: routeHref("/signin"), text: "← Back to sign in" })
    )
  );

  fill(outlet, card("Reset your password", form));
  email.focus();
}

/**
 * The other end of that link. The key is in the URL because that is where
 * allauth put it when it sent the email.
 */
export async function passwordResetView({ outlet, query, params }) {
  // Two shapes, because the key arrives two ways. Sentinel's own links use
  // ?key=; the email GlitchTip sends puts it in the path
  // (/reset-password/set-new-password/<key>), and that link lands on
  // GlitchTip's own screen until Phase 9 routes those paths here. Accepting
  // both now means that flip is a Caddy rule rather than a rewrite.
  const key = params?.key || query?.key || "";

  if (!key) {
    fill(
      outlet,
      card(
        "That link is incomplete",
        h("p", { className: "muted", text: "Ask for a new reset link and use the whole thing." }),
        h("a", { className: "button-link", href: routeHref("/password/request"), text: "Start again" })
      )
    );
    return;
  }

  const password = field({
    id: "password-input",
    type: "password",
    label: "New password",
    autocomplete: "new-password",
  });
  const error = problem();
  const submit = h("button", { type: "submit", text: "Set password" });

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.clear();
          submit.disabled = true;
          try {
            await allauth.post("/auth/password/reset", { key, password: password.value });
            password.value = "";
            // Reached only if allauth ever starts signing people in here.
            forgetSession();
            await go("/", { replace: true });
          } catch (failure) {
            password.value = "";

            /**
             * A 401 here is success.
             *
             * allauth changes the password and deliberately does not sign
             * anyone in, so it answers with "nobody is authenticated" and the
             * flows now available — which is a 401 with no errors in it. A
             * real failure, a key already spent or expired, is a 400 that
             * says so. Reading only the status told people their reset had
             * failed at the moment it had worked, and sent them back to ask
             * for another link that would arrive against a password already
             * changed.
             */
            const spent = Array.isArray(failure?.body?.errors) && failure.body.errors.length;
            if (failure?.status === 401 && !spent) {
              forgetSession();
              return go("/signin?reset=1", { replace: true });
            }

            submit.disabled = false;
            error.show(
              readErrors(
                failure,
                "That link has expired or been used already. Ask for a new one."
              )
            );
          }
        },
      },
    },
    password,
    submit,
    error.node,
    h(
      "p",
      { className: "gate-hint muted" },
      "Setting a new password signs out anywhere else you were signed in, and you'll sign in again here."
    )
  );

  fill(outlet, card("Choose a new password", form));
  password.focus();
}

// ------------------------------------------------------------------ mfa

export async function mfaView({ outlet, query }) {
  const config = await authConfig();
  const next = safeNext(query);
  const supported = config?.mfa?.supported_types || [];

  const code = field({ id: "mfa-code", type: "text", label: "Six-digit code", autocomplete: "one-time-code" });
  code.setAttribute("inputmode", "numeric");
  const error = problem();
  const submit = h("button", { type: "submit", text: "Confirm" });

  const send = async (value) => {
    error.clear();
    submit.disabled = true;
    try {
      const body = await allauth.post("/auth/2fa/authenticate", { code: value });
      await afterAuthStep(body, next);
    } catch (failure) {
      submit.disabled = false;
      code.value = "";
      code.focus();
      // A wrong code leaves you exactly here. It is not a failed sign-in and
      // must not become one — the flow behind it is still open.
      error.show(readErrors(failure, "That code wasn't accepted. Try the next one."));
    }
  };

  const form = h(
    "form",
    {
      on: {
        submit: (event) => {
          event.preventDefault();
          const value = code.value.trim();
          if (value) void send(value);
        },
      },
    },
    code,
    submit,
    error.node,
    // Only mentioned when this installation actually has them.
    supported.includes("recovery_codes")
      ? h("p", {
          className: "gate-hint muted",
          text: "Lost your authenticator? A recovery code works here too.",
        })
      : null,
    h(
      "p",
      { className: "gate-hint muted" },
      h("a", { href: routeHref("/signin"), text: "← Start again" })
    )
  );

  fill(outlet, card("One more step", form));
  code.focus();
}

// ------------------------------------------- states that are not sign-in

/**
 * Signed in, and nowhere to go. GlitchTip has no way to express "I would
 * like access", so this is it.
 */
export function accessView({ outlet }, { me, onRequest, onSignOut } = {}) {
  const denied = me?.state === "denied";
  const error = problem();
  const status = h("p", { className: "muted" });
  status.hidden = true;

  const note = field({ id: "waiting-note", type: "text", label: "Which team you're on, what you need" });
  const ask = h("button", {
    type: "button",
    text: denied ? "Ask again" : "Request access",
    on: {
      click: async (event) => {
        error.clear();
        event.target.disabled = true;
        try {
          await onRequest(note.value.trim());
          status.hidden = false;
          status.textContent =
            "Your request has been sent. Someone in the organisation has to approve it.";
          note.disabled = true;
        } catch (failure) {
          event.target.disabled = false;
          error.show(failure.message || "That request couldn't be sent.");
        }
      },
    },
  });

  fill(
    outlet,
    card(
      denied ? "That request was turned down" : "Not in an organisation yet",
      h("p", {
        className: "muted",
        text: `You're signed in as ${me?.email || "your account"}, but your account doesn't belong to an organisation — so there are no reports it can show you.`,
      }),
      note,
      ask,
      status,
      error.node,
      h("button", {
        type: "button",
        className: "ghost",
        text: "Sign out",
        on: { click: () => void onSignOut() },
      })
    )
  );
}
