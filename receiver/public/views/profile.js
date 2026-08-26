/**
 * Your own account: what you are called, which addresses reach you, what is
 * guarding the account, and the tokens that act as you.
 *
 * Phase 7, and the last of the screens that were one click away in GlitchTip
 * — but the one where "one click away" was least true. A person who has only
 * ever seen Sentinel had no way to add a second email, see what a token could
 * do, or find out whether their account had a second factor at all.
 *
 * One thing here is handled differently from every other screen, and the
 * reason is not the one it looks like.
 *
 * A new token is shown the moment it is made and never again — but that is
 * this screen's choice, not a limit GlitchTip imposes. GlitchTip keeps the
 * token in the clear and its list endpoint returns the value on every row,
 * so this screen could redisplay any token at any time. It doesn't. A list
 * that paints live credentials into the page turns a passing glance, a
 * screenshot or a shared screen into a leak, and the value is the one field
 * nobody needs in order to answer "what is this for, and should it still
 * exist". So the list carries the label, the scopes and the date, and the
 * value appears once, at the moment it was asked for.
 */

import { glitchtip, allauth } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction, modal } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { create as createCredential, supported as webauthnSupported } from "../lib/webauthn.js";
import { tokenCreatedAt, validWizardHash } from "../lib/phase67.js";
import QRCode from "qrcode";

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

export async function profileView({ outlet, signal }, me = {}, { wizardHash = "" } = {}) {
  const view = h("div", { className: "issues-view" });
  const banner = h("p", { className: "error profile-notice" });
  banner.hidden = true;
  let notice = "";
  const say = (message) => {
    notice = message || "";
    banner.textContent = notice;
    banner.hidden = !notice;
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
          : factorsSection(factors.data, account.data, { repaint, say, signal }),

        setupWizardSection({ hash: wizardHash, say, signal }),

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
 * What stands between somebody else and this account, and — since Phase 7 —
 * where it is changed.
 *
 * This was read-only at first, on the grounds that a botched enrolment locks
 * a person out of their own account, so setting one up belonged where the
 * flow was already written. That was the wrong trade. The flow it deferred
 * to is GlitchTip's own screen, which is the seam this app exists to remove,
 * and "nothing is guarding this account" is a useless thing to say to
 * somebody with no way to act on it. So enrolment happens here, and the two
 * edges that made it dangerous are handled rather than avoided: the QR is
 * drawn by a library bundled into this app, never fetched from an image
 * service that would then have the shared secret, and the recovery codes are
 * put on screen as part of enrolling rather than left to be found later.
 */
function factorsSection(factors, account, { repaint, say, signal }) {
  const list = factors?.data || factors || [];
  const rows = Array.isArray(list) ? list : [];

  const named = {
    totp: "An authenticator app",
    webauthn: "A passkey or security key",
    recovery_codes: "Recovery codes",
  };

  const act = async (run) => {
    try {
      await run();
      say("");
      await repaint();
    } catch (failure) {
      say(failure?.message || `Couldn't change that (${failure?.status ?? 0}).`);
    }
  };

  const showCodes = (body) => {
    const codes = body?.data?.unused_codes || body?.unused_codes || [];
    const done = h("button", { type: "button", text: "Done" });
    const dialog = modal({
      title: "Save these recovery codes",
      body: h("div", {},
        h("p", { className: "muted", text: "Each code works once. Keep them somewhere separate from this account." }),
        h("pre", { className: "mono recovery-codes", text: codes.join("\n") })),
      actions: [done], signal,
    });
    done.addEventListener("click", dialog.close);
  };

  const setUpTotp = async () => {
    let setup;
    try {
      await allauth.get("/account/authenticators/totp", { signal });
      say("An authenticator app is already configured.");
      return;
    } catch (failure) {
      if (failure?.status !== 404 || !failure?.body?.meta?.secret) {
        say(failure?.message || "Couldn't start authenticator setup.");
        return;
      }
      setup = failure.body.meta;
    }
    const qr = await QRCode.toDataURL(setup.totp_url, { width: 200, margin: 1 });
    const code = field({ label: "Six-digit code", id: "totp-code", inputMode: "numeric" });
    const verify = h("button", { type: "button", text: "Verify and turn on" });
    const cancel = h("button", { type: "button", className: "ghost", text: "Cancel" });
    const dialog = modal({
      title: "Set up an authenticator",
      body: h("div", {},
        h("p", { className: "muted", text: "Scan this code with your authenticator app, then enter its current code." }),
        h("img", { className: "totp-qr", src: qr, alt: "Authenticator setup QR code", width: 200, height: 200 }),
        h("p", { className: "muted", text: "If you cannot scan it, enter this secret manually:" }),
        h("code", { id: "totp-secret", className: "mono dsn", text: setup.secret }),
        code.node),
      actions: [cancel, verify], signal,
    });
    cancel.addEventListener("click", dialog.close);
    verify.addEventListener("click", async () => {
      verify.disabled = true;
      try {
        await allauth.post("/account/authenticators/totp", { code: code.input.value.trim() }, { signal });
        const recovery = await allauth.get("/account/authenticators/recovery-codes", { signal });
        dialog.close();
        showCodes(recovery);
        await repaint();
      } catch (failure) {
        say(failure?.message || "That code was not accepted.");
      } finally {
        verify.disabled = false;
      }
    });
  };

  const regenerate = async () => {
    const sure = await confirmAction({
      title: "Replace every recovery code?",
      detail: "The old codes stop working immediately.",
      confirm: "Regenerate",
      signal,
    });
    if (!sure) return;
    try { showCodes(await allauth.post("/account/authenticators/recovery-codes", {}, { signal })); }
    catch (failure) { say(failure?.message || "Couldn't regenerate recovery codes."); }
  };

  const removeTotp = async () => {
    const sure = await confirmAction({
      title: "Remove the authenticator app?",
      detail: "It and its recovery codes stop protecting this account.",
      confirm: "Remove it",
      signal,
    });
    if (sure) await act(() => allauth.del("/account/authenticators/totp", { signal }));
  };

  const addPasskey = async () => {
    const name = field({ label: "Name", id: "passkey-name", placeholder: "Laptop or security key" });
    const create = h("button", { type: "button", text: "Create passkey" });
    const cancel = h("button", { type: "button", className: "ghost", text: "Cancel" });
    const dialog = modal({ title: "Add a passkey", body: name.node, actions: [cancel, create], signal });
    cancel.addEventListener("click", dialog.close);
    create.addEventListener("click", async () => {
      create.disabled = true;
      try {
        const options = await allauth.get("/account/authenticators/webauthn", { signal });
        const credential = await createCredential(options?.data?.creation_options, signal);
        await allauth.post("/account/authenticators/webauthn", {
          name: name.input.value.trim() || "Passkey",
          credential,
        }, { signal });
        dialog.close();
        await repaint();
      } catch (failure) {
        say(failure?.message || "Couldn't add that passkey.");
      } finally { create.disabled = false; }
    });
  };

  const renamePasskey = async (one) => {
    const name = field({ label: "Name", id: "passkey-name", value: one.name || "" });
    const save = h("button", { type: "button", text: "Save name" });
    const dialog = modal({ title: "Rename passkey", body: name.node, actions: [save], signal });
    save.addEventListener("click", async () => {
      await act(() => allauth.put("/account/authenticators/webauthn", { id: one.id, name: name.input.value.trim() }, { signal }));
      dialog.close();
    });
  };

  const removePasskey = async (one) => {
    const sure = await confirmAction({ title: `Remove ${one.name || "this passkey"}?`, detail: "It can no longer sign in to this account.", confirm: "Remove it", signal });
    if (sure) await act(() => allauth.del("/account/authenticators/webauthn", { body: { authenticators: [one.id] }, signal }));
  };

  const hasTotp = rows.some((one) => one.type === "totp");
  const passkeys = rows.filter((one) => one.type === "webauthn");
  const hasRecovery = rows.some((one) => one.type === "recovery_codes");

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
              h("div", {},
                h("span", { text: one.name || named[one.type] || one.type }),
                h("span", { className: "muted", text: when(one.created_at * 1000) })),
              one.type === "webauthn"
                ? h("span", { className: "row-actions" },
                    h("button", { type: "button", className: "ghost", text: "Rename", on: { click: () => void renamePasskey(one) } }),
                    h("button", { type: "button", className: "ghost danger", text: "Remove", on: { click: () => void removePasskey(one) } }))
                : null
            )
          )
        )
      : h("p", { className: "muted",
          text: "No second factor. A password alone is all that protects this account." }),
    h("div", { className: "form-actions" },
      hasTotp
        ? h("button", { type: "button", className: "ghost danger", text: "Remove authenticator", on: { click: () => void removeTotp() } })
        : h("button", { type: "button", text: "Set up authenticator", on: { click: () => void setUpTotp() } }),
      webauthnSupported()
        ? h("button", { type: "button", text: "Add passkey", on: { click: () => void addPasskey() } })
        : null,
      hasRecovery
        ? h("button", { type: "button", className: "ghost", text: "Regenerate recovery codes", on: { click: () => void regenerate() } })
        : null)
  );
}

function setupWizardSection({ hash = "", say, signal }) {
  const input = field({ label: "Setup code", id: "wizard-hash", value: hash });
  const status = h("p", { className: "muted" });
  const connect = h("button", { type: "submit", text: "Connect setup wizard" });
  return section(
    "Setup wizard",
    h("p", { className: "muted", text: "Connect the short-lived code opened by GlitchTip's setup tool. It expires after ten minutes." }),
    h("form", { on: { submit: async (event) => {
      event.preventDefault();
      const value = input.input.value.trim();
      if (!validWizardHash(value)) { say("That setup code is not valid."); return; }
      connect.disabled = true;
      try {
        await glitchtip.post("/wizard-set-token/", { hash: value }, { signal });
        status.textContent = "Setup wizard connected. You may return to the terminal.";
        say("");
      } catch (failure) {
        say(failure?.message || `Couldn't connect that setup wizard (${failure?.status ?? 0}).`);
      } finally { connect.disabled = false; }
    } } }, input.node, h("div", { className: "form-actions" }, connect, status))
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
                  text: [(token.scopes || []).join(", ") || "no scopes", when(tokenCreatedAt(token))]
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
             * Shown once because this screen shows it once — the note at the
             * top of the file says why, since the reason is not the obvious
             * one. The row that joins the list below will say what this
             * token is for and never what it is.
             */
            made.hidden = false;
            fill(
              made,
              h("p", { text: "Copy this now — Sentinel won't show it again." }),
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
