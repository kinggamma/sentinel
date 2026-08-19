/**
 * Your own account: what you are called, which addresses reach you, what is
 * guarding the account, and the tokens that act as you.
 *
 * Phase 7, and the last of the screens that were one click away in GlitchTip
 * — but the one where "one click away" was least true. A person who has only
 * ever seen Sentinel had no way to add a second email, see what a token could
 * do, or find out whether their account had a second factor at all.
 *
 * Two things here are handled differently from every other screen in this
 * app, and both for the same reason: a credential is only shown once.
 *
 * A new token is displayed the moment it is made and never again, because
 * GlitchTip stores it hashed and cannot show it later. So it is presented as
 * something to copy now rather than a row in a list, and says so.
 *
 * And adding a second factor is not done here. Setting up an authenticator
 * means a QR code, a shared secret and recovery codes, and doing that badly
 * locks somebody out of their own account. Reading what exists is useful and
 * safe; creating it belongs where the flow is already written and tested.
 */

import { glitchtip, allauth } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";

/** Every scope a token can hold, as GlitchTip's own bitfield names them. */
const SCOPES = [
  ["project:read", "Read projects"],
  ["project:write", "Change projects"],
  ["project:admin", "Create and delete projects"],
  ["project:releases", "Releases"],
  ["team:read", "Read teams"],
  ["team:write", "Change teams"],
  ["team:admin", "Create and delete teams"],
  ["event:read", "Read errors"],
  ["event:write", "Change errors"],
  ["event:admin", "Delete errors"],
  ["org:read", "Read the organisation"],
  ["org:write", "Change the organisation"],
  ["org:admin", "Organisation administration"],
  ["member:read", "Read members"],
  ["member:write", "Invite and change members"],
  ["member:admin", "Remove members"],
];

function readFailure(status, subject = "this") {
  if (status === 403) return `You don't have access to ${subject}.`;
  if (status === 0) return "Couldn't reach the server.";
  return `Couldn't load ${subject} (${status}).`;
}

const settle = (promise) =>
  promise.then((data) => ({ data }), (error) => ({ failed: error?.status ?? 0 }));

function section(title, ...children) {
  return h("section", { className: "detail-section" }, h("h3", { text: title }), children);
}

function when(value) {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString();
}

export async function profileView({ outlet, signal }, me = {}) {
  const view = h("div", { className: "issues-view" });
  let notice = "";
  const say = (message) => {
    notice = message || "";
  };

  async function load() {
    const [account, emails, tokens, notifications, factors] = await Promise.all([
      settle(glitchtip.get("/users/me/", { signal })),
      settle(glitchtip.get("/users/me/emails/", { signal })),
      settle(glitchtip.get("/api-tokens/", { signal })),
      settle(glitchtip.get("/users/me/notifications/", { signal })),
      // allauth answers 401 as conversation rather than refusal, which the
      // shared client already knows not to treat as a lost session.
      settle(allauth.get("/account/authenticators", { signal })),
    ]);
    throwIfAborted(signal);
    return { account, emails, tokens, notifications, factors };
  }

  const repaint = async () => paint(await load());

  function paint({ account, emails, tokens, notifications, factors }) {
    if (account.failed !== undefined) {
      fill(view, h("p", { className: "error", text: readFailure(account.failed, "your account") }));
      return;
    }

    const banner = h("p", { className: "error", text: notice });
    banner.hidden = !notice;

    fill(
      view,
      h("section", { className: "issue-detail" },
        h("header", { className: "detail-head" },
          h("h2", { text: account.data.name || account.data.email || "Your profile" }),
          h("span", { className: "muted", text: account.data.email || "" })
        ),
        banner,

        nameSection(account.data, { repaint, say, signal }),

        emails.failed !== undefined
          ? section("Email addresses", h("p", { className: "muted", text: readFailure(emails.failed, "your addresses") }))
          : emailsSection(emails.data, account.data, { repaint, say, signal }),

        notifications.failed !== undefined
          ? section("Notifications", h("p", { className: "muted", text: readFailure(notifications.failed, "your notification settings") }))
          : notificationsSection(notifications.data, { repaint, say, signal }),

        factors.failed !== undefined
          ? section("Signing in", h("p", { className: "muted", text: readFailure(factors.failed, "your sign-in methods") }))
          : factorsSection(factors.data, account.data),

        tokens.failed !== undefined
          ? section("Tokens", h("p", { className: "muted", text: readFailure(tokens.failed, "your tokens") }))
          : tokensSection(tokens.data, { repaint, say, signal })
      )
    );
  }

  paint(await load());
  fill(outlet, view);
}

/** What you are called, which is the only thing about you GlitchTip stores. */
function nameSection(account, { repaint, say, signal }) {
  const name = field({ label: "Name", id: "profile-name", value: account.name || "" });
  const saved = h("span", { className: "muted" });
  saved.hidden = true;
  const submit = h("button", { type: "submit", text: "Save" });

  return section(
    "Your name",
    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          saved.hidden = true;
          submit.disabled = true;
          try {
            await glitchtip.put(
              "/users/me/",
              // Options come back as they went: this endpoint replaces the
              // whole object, so leaving them out would quietly reset a
              // person's timezone and theme along with their name.
              { name: name.input.value.trim(), options: account.options || {} },
              { signal }
            );
            saved.hidden = false;
            saved.textContent = "Saved.";
            say("");
          } catch (failure) {
            say(failure?.message || `Couldn't save that (${failure?.status ?? 0}).`);
            await repaint().catch(() => {});
          } finally {
            submit.disabled = false;
          }
        },
      },
    }, name.node, h("div", { className: "form-actions" }, submit, saved))
  );
}

/**
 * The addresses that reach you.
 *
 * The primary one is where everything is sent, and it cannot be removed —
 * removing it would leave an account nothing can reach, including the message
 * telling you how to get back in. Another address has to be made primary
 * first, which is the same order GlitchTip enforces and worth showing rather
 * than discovering.
 */
function emailsSection(emails, account, { repaint, say, signal }) {
  const list = Array.isArray(emails) ? emails : [];
  const input = field({
    label: "Add an address",
    id: "profile-email",
    type: "email",
    placeholder: "you@example.org",
  });
  const submit = h("button", { type: "submit", text: "Add" });

  const act = async (run, wrong) => {
    try {
      await run();
      say("");
    } catch (failure) {
      say(failure?.message || `${wrong} (${failure?.status ?? 0}).`);
    }
    await repaint().catch(() => {});
  };

  return section(
    "Email addresses",
    list.length
      ? h("ul", { className: "origin-list" },
          list.map((one) =>
            h("li", {},
              h("div", {},
                h("div", { text: one.email }),
                h("div", { className: "muted",
                  text: [
                    one.isPrimary ? "primary" : null,
                    one.isVerified ? "verified" : "not verified yet",
                  ].filter(Boolean).join(" · ") })
              ),
              one.isPrimary
                ? null
                : h("span", { className: "row-actions" },
                    h("button", {
                      type: "button",
                      className: "ghost",
                      text: "Make primary",
                      on: {
                        click: () =>
                          void act(
                            () => glitchtip.put("/users/me/emails/", { email: one.email }, { signal }),
                            "Couldn't make that primary"
                          ),
                      },
                    }),
                    h("button", {
                      type: "button",
                      className: "ghost danger",
                      text: "Remove",
                      on: {
                        click: async () => {
                          const sure = await confirmAction({
                            title: `Remove ${one.email}?`,
                            detail: "Nothing will be sent to it again, and it can no longer be used to sign in.",
                            confirm: "Remove it",
                          });
                          if (!sure) return;
                          await act(
                            () => glitchtip.del("/users/me/emails/", { body: { email: one.email }, signal }),
                            "Couldn't remove that"
                          );
                        },
                      },
                    })
                  )
            )
          )
        )
      : h("p", { className: "muted",
          text: `Only ${account.email || "your sign-in address"}, which is where everything is sent.` }),
    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          const address = input.input.value.trim();
          if (!address) return;
          submit.disabled = true;
          await act(
            () => glitchtip.post("/users/me/emails/", { email: address }, { signal }),
            "Couldn't add that address"
          );
          input.input.value = "";
          submit.disabled = false;
        },
      },
    }, input.node, h("div", { className: "form-actions" }, submit))
  );
}

/** Whether new projects tell you about their errors by default. */
function notificationsSection(notifications, { repaint, say, signal }) {
  const subscribe = h("input", {
    id: "profile-subscribe",
    type: "checkbox",
    checked: Boolean(notifications?.subscribeByDefault),
    on: {
      change: async (event) => {
        try {
          await glitchtip.put(
            "/users/me/notifications/",
            { subscribeByDefault: event.target.checked },
            { signal }
          );
          say("");
        } catch (failure) {
          say(failure?.message || `Couldn't change that (${failure?.status ?? 0}).`);
          await repaint().catch(() => {});
        }
      },
    },
  });

  return section(
    "Notifications",
    h("label", { className: "field field-check" }, subscribe,
      h("span", { className: "field-label",
        text: "Tell me about errors in projects I am added to" }))
  );
}

/**
 * What stands between somebody else and this account.
 *
 * Read-only on purpose. Adding an authenticator is a QR code, a shared
 * secret and a set of recovery codes, and getting that wrong locks a person
 * out of their own account — so it stays where the flow already exists and
 * has been tested. Saying whether anything is configured is the useful half,
 * and it is the half nobody could see from here at all.
 */
function factorsSection(factors, account) {
  const list = factors?.data || factors || [];
  const rows = Array.isArray(list) ? list : [];

  const named = {
    totp: "An authenticator app",
    webauthn: "A passkey or security key",
    recovery_codes: "Recovery codes",
  };

  return section(
    "Signing in",
    h("p", { className: "muted",
      text: account.hasPasswordAuth === false
        ? "This account has no password — it signs in another way."
        : "This account signs in with a password." }),
    rows.length
      ? h("ul", { className: "origin-list" },
          rows.map((one) =>
            h("li", {},
              h("span", { text: named[one.type] || one.type }),
              h("span", { className: "muted", text: when(one.created_at * 1000) })
            )
          )
        )
      : h("p", { className: "muted",
          text: "No second factor. A password alone is all that protects this account." })
  );
}

/**
 * Tokens, which act as you without being you.
 *
 * Every scope is listed rather than summarised, because "what can this token
 * do" is the only question worth asking before making one, and a token with
 * every box ticked is the thing people make when the boxes are hidden behind
 * a word like "full".
 */
function tokensSection(tokens, { repaint, say, signal }) {
  const list = Array.isArray(tokens) ? tokens : [];
  const label = field({ label: "What is it for", id: "token-label", placeholder: "CI, or a script" });
  const boxes = SCOPES.map(([value, description]) => {
    const box = h("input", { type: "checkbox", value, attrs: { "aria-label": description } });
    return { value, box, node: h("label", { className: "field field-check" }, box,
      h("span", { className: "field-label", text: description })) };
  });
  const submit = h("button", { type: "submit", text: "Make a token" });
  const made = h("div", { className: "token-made" });
  made.hidden = true;

  const remove = async (token) => {
    const sure = await confirmAction({
      title: `Delete the ${token.label || "unnamed"} token?`,
      detail: "Anything using it stops working immediately, and it cannot be restored.",
      confirm: "Delete it",
    });
    if (!sure) return;
    try {
      await glitchtip.del(`/api-tokens/${encodeURIComponent(token.id)}/`, { signal });
      say("");
      await repaint();
    } catch (failure) {
      say(failure?.message || `Couldn't delete that (${failure?.status ?? 0}).`);
      await repaint().catch(() => {});
    }
  };

  return section(
    "Tokens",
    list.length
      ? h("ul", { className: "origin-list" },
          list.map((token) =>
            h("li", {},
              h("div", {},
                h("div", { text: token.label || "unnamed token" }),
                h("div", { className: "muted",
                  text: [(token.scopes || []).join(", ") || "no scopes", when(token.dateCreated)]
                    .filter(Boolean).join(" · ") })
              ),
              h("button", {
                type: "button",
                className: "ghost danger",
                text: "Delete",
                on: { click: () => void remove(token) },
              })
            )
          )
        )
      : h("p", { className: "muted", text: "No tokens. Nothing is acting as you." }),

    made,

    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          const scopes = boxes.filter((one) => one.box.checked).map((one) => one.value);
          if (!scopes.length) {
            say("A token with no scopes can do nothing. Tick what it needs.");
            return;
          }
          submit.disabled = true;
          try {
            const token = await glitchtip.post(
              "/api-tokens/",
              { label: label.input.value.trim(), scopes },
              { signal }
            );
            /**
             * Shown once, because that is all GlitchTip will ever show. It
             * is stored hashed, so a row in the list below can say what a
             * token is for and never what it is.
             */
            made.hidden = false;
            fill(
              made,
              h("p", { text: "Copy this now — it is not shown again." }),
              h("code", { className: "mono dsn", text: token.token || "" })
            );
            for (const one of boxes) one.box.checked = false;
            label.input.value = "";
            say("");
          } catch (failure) {
            say(failure?.message || `Couldn't make that (${failure?.status ?? 0}).`);
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
      label.node,
      h("div", { className: "token-scopes" }, boxes.map((one) => one.node)),
      h("div", { className: "form-actions" }, submit)
    )
  );
}
