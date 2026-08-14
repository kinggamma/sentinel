/**
 * Where apps may report from, plus the GlitchTip service token.
 *
 * One view, two addresses: `/settings` is the global list (plus the
 * integration token and "add an app"), `/settings/apps/:app` is one app's
 * addresses, reached from its project card. They used to be one shared DOM
 * tree (`#settings`) toggled between two "modes" by hand — same lightbox,
 * different visibility flags on its children. Splitting them by URL instead
 * means the per-app screen is bookmarkable, which it never was before: there
 * was no way to link someone straight to "where does mewaka-lms run."
 *
 * The second of the three copy-pasted lightboxes (styles.css:611) to move
 * onto modal() — access requests was the first.
 */
import { sentinel } from "../lib/api.js";
import { h, fill, modal } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { go } from "../lib/router.js";

function originRow(origin, { fixed, onRemove }) {
  return h(
    "li",
    {},
    h("span", { className: "mono", text: origin }),
    // Set in the deployment's own configuration, so removing it here would
    // last until the next restart and no longer — say so instead.
    fixed
      ? h("span", { className: "muted", text: "from .env" })
      : h("button", { type: "button", className: "ghost danger", text: "Remove", on: { click: onRemove } })
  );
}

/** @param {object} [opts] - onSaved is called after a change worth reflecting elsewhere: a project card's origin count, its very existence. */
export async function settingsView({ params, signal, onCleanup }, { onSaved } = {}) {
  const appName = params.app || null;
  let active = true;
  // Never populated for an app-scoped list: "from .env" describes the global
  // list only — an app's own addresses can't be one of the fixed ones.
  let fixedOrigins = [];
  let currentOrigins = [];

  const list = h("ul", { className: "origin-list" });
  const error = h("p", { className: "error" });
  error.hidden = true;

  const input = h("input", {
    type: "url",
    attrs: { placeholder: "http://your-app-host:5173", autocomplete: "off", spellcheck: "false" },
  });
  const originForm = h(
    "form",
    { className: "origin-add", on: { submit: onAddOrigin } },
    input,
    h("button", { type: "submit", text: "Add" })
  );

  function paintList() {
    fill(
      list,
      currentOrigins.length
        ? currentOrigins.map((origin) =>
            originRow(origin, {
              fixed: fixedOrigins.includes(origin),
              onRemove: () => void save(currentOrigins.filter((o) => o !== origin && !fixedOrigins.includes(o))),
            })
          )
        : h("li", { className: "empty", text: "No app may report yet." })
    );
  }

  async function save(nextOrigins) {
    error.hidden = true;
    try {
      if (appName) {
        const body = await sentinel.put(`/settings/apps/${encodeURIComponent(appName)}`, { origins: nextOrigins }, { signal });
        throwIfAborted(signal);
        currentOrigins = (body.apps || []).find((a) => a.appName === appName)?.origins || [];
        onSaved?.();
      } else {
        const body = await sentinel.put("/settings/origins", { origins: nextOrigins }, { signal });
        throwIfAborted(signal);
        fixedOrigins = body.fixed || [];
        currentOrigins = body.origins || [];
      }
    } catch (err) {
      throwIfAborted(signal);
      error.hidden = false;
      error.textContent = err.message || "Could not save.";
      return;
    }
    paintList();
    return true;
  }

  async function onAddOrigin(event) {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const next = [...currentOrigins.filter((o) => !fixedOrigins.includes(o)), value];
    if (await save(next)) input.value = "";
  }

  const sections = [
    h(
      "p",
      { className: "muted" },
      appName
        ? "Its browser code may only post reports from these addresses. An app that reports from its own server doesn't need one."
        : "An app's browser code can only send reports from an address listed here. Server-side reporting doesn't need an entry — only pages running in a browser do."
    ),
    list,
    originForm,
    error,
  ];

  if (!appName) {
    // Created with no addresses: an app that reports from its own server
    // never needs one, and the card is where you'd add them if it does.
    const addAppInput = h("input", { type: "text", attrs: { placeholder: "e.g. admin-panel", autocomplete: "off" } });
    const addAppError = h("p", { className: "error" });
    addAppError.hidden = true;

    sections.push(
      h(
        "div",
        { className: "integration" },
        h("h3", { text: "Add an app" }),
        h("p", {
          className: "muted",
          text:
            "Gives it a card straight away, so you can set where it runs before it has reported. " +
            "The name must match the appName the app sends.",
        }),
        h(
          "form",
          {
            className: "origin-add",
            on: {
              submit: async (event) => {
                event.preventDefault();
                addAppError.hidden = true;
                const name = addAppInput.value.trim();
                if (!name) return;
                try {
                  await sentinel.put(`/settings/apps/${encodeURIComponent(name)}`, { origins: [] }, { signal });
                } catch (err) {
                  throwIfAborted(signal);
                  addAppError.hidden = false;
                  addAppError.textContent = err.message || "Could not add that.";
                  return;
                }
                throwIfAborted(signal);
                addAppInput.value = "";
                onSaved?.();
                close();
              },
            },
          },
          addAppInput,
          h("button", { type: "submit", text: "Add" })
        ),
        addAppError
      )
    );

    const status = h("p", { className: "muted" });
    const tokenInput = h("input", {
      type: "password",
      attrs: { placeholder: "Paste a token to set it", autocomplete: "off", spellcheck: "false" },
    });
    const teamInput = h("input", { type: "text", attrs: { placeholder: "Team slug" } });
    const integrationError = h("p", { className: "error" });
    integrationError.hidden = true;

    async function loadIntegration() {
      let body;
      try {
        body = await sentinel.get("/settings/integration", { signal });
      } catch {
        throwIfAborted(signal);
        return;
      }
      throwIfAborted(signal);
      const parts = [
        body.hasToken ? "A token is set." : "No token set — approving access and creating projects are unavailable.",
      ];
      if (body.team) parts.push(`New projects go to the "${body.team}" team.`);
      if (body.tokenFromEnv) parts.push("Set in this deployment's environment, so it can't be changed here.");
      status.textContent = parts.join(" ");
      tokenInput.disabled = body.tokenFromEnv;
      teamInput.disabled = body.teamFromEnv;
      teamInput.value = body.team || "";
      tokenInput.placeholder = body.hasToken ? "Paste a new token to replace it" : "Paste a token to set it";
    }

    sections.push(
      h(
        "div",
        { className: "integration" },
        h("h3", { text: "GlitchTip service token" }),
        h("p", {
          className: "muted",
          text:
            "Lets Sentinel invite people you approve, and create a GlitchTip project the first time a new app " +
            "reports. Create it in GlitchTip under Profile → Auth Tokens with member:write and project:write, on " +
            "an account with the Admin role. Leave project:admin unticked so it can never delete a project.",
        }),
        status,
        h(
          "form",
          {
            className: "origin-add",
            on: {
              submit: async (event) => {
                event.preventDefault();
                integrationError.hidden = true;
                const token = tokenInput.value.trim();
                const team = teamInput.value.trim();
                const payload = { team };
                // Only send the token when one was typed, so saving the team
                // alone doesn't wipe a token that's already set.
                if (token) payload.serviceToken = token;
                try {
                  await sentinel.put("/settings/integration", payload, { signal });
                } catch (err) {
                  throwIfAborted(signal);
                  integrationError.hidden = false;
                  integrationError.textContent = err.message || "Could not save.";
                  return;
                }
                throwIfAborted(signal);
                tokenInput.value = "";
                await loadIntegration();
              },
            },
          },
          tokenInput,
          teamInput,
          h("button", { type: "submit", text: "Save" })
        ),
        integrationError
      )
    );

    void loadIntegration();
  }

  const done = h("button", { type: "button", className: "ghost", text: "Done" });
  const { close, panel } = modal({
    title: appName ? `Where ${appName} runs` : "Apps allowed to report",
    body: h("div", {}, sections),
    actions: [done],
    onClose: () => {
      if (active) void go("/");
    },
  });
  done.addEventListener("click", close);
  // Registered here, not returned at the end. load() below rethrows an
  // AbortError when the navigation that superseded this one cancels its
  // fetch — and that throw skips the return, so the router would be handed
  // no teardown and this dialog would stay open over the next screen.
  onCleanup(() => {
    active = false;
    close();
  });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", appName ? `Where ${appName} runs` : "Apps allowed to report");

  async function load() {
    try {
      if (appName) {
        const body = await sentinel.get("/settings/apps", { signal });
        throwIfAborted(signal);
        currentOrigins = (body.apps || []).find((a) => a.appName === appName)?.origins || [];
      } else {
        const body = await sentinel.get("/settings/origins", { signal });
        throwIfAborted(signal);
        fixedOrigins = body.fixed || [];
        currentOrigins = body.origins || [];
      }
    } catch (err) {
      throwIfAborted(signal);
      error.hidden = false;
      error.textContent = err.message || "Could not load settings.";
      return;
    }
    paintList();
  }

  await load();

}
