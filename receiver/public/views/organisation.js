/**
 * The organisation itself: what it is called, how much it is reporting, and
 * how people sign into it.
 *
 * Phase 6. Three things that had no home in Sentinel and one click away in
 * GlitchTip, which is the same distance as anything else this project has
 * been folding in.
 *
 * The numbers earn their place at the top. Everything else here is
 * configuration somebody changes twice a year; how many errors arrived this
 * fortnight is the question the organisation actually gets asked, and it had
 * no answer anywhere in this app.
 *
 * Every write needs org:write — manager and above — and a member cannot even
 * read the sign-on list, so that section is hidden rather than shown empty.
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { environmentRows, socialAppPayload } from "../lib/phase67.js";

function readFailure(status, subject = "this") {
  if (status === 403) return `You don't have access to ${subject}.`;
  if (status === 404) return `${subject} isn't there, or your role can't reach it.`;
  if (status === 0) return "Couldn't reach the server.";
  return `Couldn't load ${subject} (${status}).`;
}

const settle = (promise) =>
  promise.then((data) => ({ data }), (error) => ({ failed: error?.status ?? 0 }));

function section(title, ...children) {
  return h("section", { className: "detail-section" }, h("h3", { text: title }), children);
}

/** The last fortnight, which is the window the issue list defaults near. */
function fortnight() {
  const end = new Date();
  const start = new Date(end.getTime() - 13 * 24 * 60 * 60 * 1000);
  const day = (at) => at.toISOString().slice(0, 10);
  return { start: day(start), end: day(end) };
}

export async function organisationView({ outlet, signal }, { org, me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show."));
    return;
  }

  const can = me?.orgRoles?.[org] || {};
  const { start, end } = fortnight();

  const [detail, stats, social, environments] = await Promise.all([
    settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/`, { signal })),
    settle(
      glitchtip.get(
        `/organizations/${encodeURIComponent(org)}/stats_v2/` +
          `?category=error&field=sum(quantity)&start=${start}&end=${end}&interval=1d`,
        { signal }
      )
    ),
    can.canManageOrganisation
      ? settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/social-apps/`, { signal }))
      : Promise.resolve({ data: null }),
    settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/environments/?visibility=all`, { signal })),
  ]);
  throwIfAborted(signal);

  if (detail.failed !== undefined) {
    fill(outlet, h("div", { className: "issues-view" },
      h("p", { className: "error", text: readFailure(detail.failed, "this organisation") })));
    return;
  }

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("section", { className: "issue-detail" },
        h("header", { className: "detail-head" }, h("h2", { text: detail.data.name || org })),

        stats.failed !== undefined
          ? section("Errors", h("p", { className: "muted", text: readFailure(stats.failed, "the numbers") }))
          : errorsSection(stats.data),

        environments.failed !== undefined
          ? section("Environments", h("p", { className: "muted", text: readFailure(environments.failed, "the environments") }))
          : environmentsSection(environments.data),

        can.canManageOrganisation
          ? generalSection(detail.data, { org, signal })
          : section("Settings",
              h("p", { className: "muted",
                text: "Changing what this organisation is called needs the manager role." })),

        can.canManageOrganisation
          ? social.failed !== undefined
            ? section("Signing in", h("p", { className: "muted", text: readFailure(social.failed, "the sign-on settings") }))
            : socialSection(social.data, { org, signal })
          : null
      )
    )
  );
}

/**
 * How many errors arrived, per day, for a fortnight.
 *
 * Drawn as bars rather than a chart library, because a chart library is a
 * dependency and this is fourteen numbers. The tallest day sets the scale,
 * so the shape is relative — which is the only thing a strip this size can
 * honestly convey, and why the total is written out beside it.
 */
function errorsSection(stats) {
  const intervals = stats?.intervals || [];
  const series = stats?.groups?.[0]?.series?.["sum(quantity)"] || [];

  if (!intervals.length || !series.length) {
    return section("Errors", h("p", { className: "muted", text: "Nothing reported in the last fortnight." }));
  }

  /**
   * Null is not zero, and saying so matters.
   *
   * GlitchTip fills these counters from a periodic task; where that has never
   * run, every value comes back null rather than 0. Adding them up produces
   * "0 errors in the last fortnight" on an installation with plenty of
   * errors, which is a confident and completely false sentence — and worse
   * than admitting the numbers are not being kept, because it looks like an
   * answer.
   */
  if (series.every((one) => one === null || one === undefined)) {
    return section(
      "Errors",
      h("p", { className: "muted",
        text: "GlitchTip has not recorded any statistics for this period. They come from its " +
          "periodic task; the issue list is unaffected and is the accurate count." })
    );
  }

  const total = series.reduce((sum, one) => sum + (Number(one) || 0), 0);
  const tallest = Math.max(...series.map((one) => Number(one) || 0), 1);

  return section(
    "Errors",
    h("p", { className: "muted",
      text: `${total} in the last fortnight, ${Math.round(total / series.length)} on an average day.` }),
    h(
      "div",
      { className: "spark" },
      series.map((value, at) =>
        h("span", {
          className: "spark-bar",
          style: { height: `${Math.max(2, Math.round(((Number(value) || 0) / tallest) * 100))}%` },
          attrs: {
            title: `${intervals[at]?.slice(0, 10) || ""}: ${value}`,
            "aria-label": `${intervals[at]?.slice(0, 10) || ""}: ${value}`,
          },
        })
      )
    )
  );
}

/**
 * The name, and only the name.
 *
 * GlitchTip's update endpoint takes exactly one field. Open membership —
 * whether anybody here may join any team — is on the model and not on that
 * schema, so a control for it would have been a checkbox that saves nothing
 * and reports success. It is shown as what it is instead.
 *
 * The slug is not editable for the same reason a project's is not: it is in
 * every link into GlitchTip and every address this app builds.
 */
function generalSection(organisation, { org, signal }) {
  // Not "org-name": the sidebar's own organisation label already owns that id,
  // and a duplicate id means whichever comes first in the document wins.
  const name = field({ label: "Name", id: "organisation-name", value: organisation.name || "" });

  const saved = h("span", { className: "muted" });
  saved.hidden = true;
  const error = h("p", { className: "error" });
  error.hidden = true;
  const submit = h("button", { type: "submit", text: "Save" });

  return section(
    "Settings",
    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          saved.hidden = true;
          submit.disabled = true;
          try {
            await glitchtip.put(
              `/organizations/${encodeURIComponent(org)}/`,
              {
                name: name.input.value.trim() || organisation.name,
                slug: organisation.slug,
              },
              { signal }
            );
            saved.hidden = false;
            saved.textContent = "Saved.";
          } catch (failure) {
            error.hidden = false;
            error.textContent = failure?.message || `Couldn't save that (${failure?.status ?? 0}).`;
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
      name.node,
      h("div", { className: "form-actions" }, submit, saved)
    ),
    h("p", { className: "muted mono", text: organisation.slug }),
    h("p", { className: "muted",
      text: organisation.openMembership
        ? "Anybody in this organisation may join any team. Changing that is in GlitchTip — its API does not expose the setting."
        : "People are added to teams individually. Changing that is in GlitchTip — its API does not expose the setting." }),
    error
  );
}

/**
 * Single sign-on, as far as it can honestly go from here.
 *
 * A provider's client id and secret are configured in GlitchTip, and this
 * lists what exists and can remove one. Adding one is deliberately not here:
 * it means pasting a secret into a form, and a secret typed into the wrong
 * of two apps that look like one app is a bad way to find out they are two.
 * The link goes where the real form is.
 */
function environmentsSection(environments) {
  const rows = environmentRows(environments);
  return section(
    "Environments",
    rows.length
      ? h("ul", { className: "origin-list" }, rows.map((environment) =>
          h("li", {}, h("span", { text: environment.name }))))
      : h("p", { className: "muted", text: "No project has reported an environment yet." }),
    h("p", { className: "muted", text: "Environments are created by incoming events. Show or hide one for a project from that project's screen." })
  );
}

function socialSection(apps, { org, signal }) {
  let list = Array.isArray(apps) ? apps : [];
  const error = h("p", { className: "error" });
  error.hidden = true;
  const body = h("div");

  const explain = (failure, fallback) => {
    error.hidden = false;
    error.textContent = failure?.message || `${fallback} (${failure?.status ?? 0}).`;
  };

  const refresh = async () => {
    list = await glitchtip.get(`/organizations/${encodeURIComponent(org)}/social-apps/`, { signal });
    render();
  };

  const edit = async (app = null) => {
    const editing = Boolean(app);
    const name = field({ label: "Name", id: "sso-name", value: app?.name || "" });
    const provider = h("select", { id: "sso-provider" },
      h("option", { value: "openid_connect", text: "OpenID Connect" }),
      h("option", { value: "google", text: "Google" }));
    provider.value = app?.brand === "google" ? "google" : "openid_connect";
    provider.disabled = editing;
    const clientId = field({ label: "Client ID", id: "sso-client-id", value: app?.clientID || app?.clientId || "" });
    const secret = field({ label: editing ? "New client secret (leave blank to keep it)" : "Client secret", id: "sso-client-secret", type: "password" });
    const server = field({ label: "Issuer URL", id: "sso-server-url", value: app?.serverUrl || "", placeholder: "https://identity.example.com" });
    const fields = h("div", {},
      name.node,
      h("label", { className: "field" }, h("span", { className: "field-label", text: "Provider" }), provider),
      clientId.node, secret.node, server.node);
    const sure = await confirmAction({
      title: editing ? `Edit ${app.name}` : "Add sign-on provider",
      body: fields,
      confirm: editing ? "Save provider" : "Add provider",
      signal,
    });
    if (!sure) return;
    const payload = socialAppPayload({
      name: name.input.value,
      provider: provider.value,
      clientId: clientId.input.value,
      clientSecret: secret.input.value,
      serverUrl: server.input.value,
    }, { editing });
    try {
      if (editing) {
        await glitchtip.put(`/organizations/${encodeURIComponent(org)}/social-apps/${encodeURIComponent(app.id)}/`, payload, { signal });
      } else {
        await glitchtip.post(`/organizations/${encodeURIComponent(org)}/social-apps/`, payload, { signal });
      }
      error.hidden = true;
      await refresh();
    } catch (failure) {
      explain(failure, editing ? "Couldn't save that provider" : "Couldn't add that provider");
    }
  };

  const remove = async (app) => {
    const sure = await confirmAction({
      title: `Stop letting people sign in with ${app.name || app.provider}?`,
      detail:
        "Anybody who signs in that way loses the route in. Accounts and their access are untouched; " +
        "the way they authenticate is what goes.",
      confirm: "Remove it",
      signal,
    });
    if (!sure) return;
    try {
      await glitchtip.del(
        `/organizations/${encodeURIComponent(org)}/social-apps/${encodeURIComponent(app.id)}/`,
        { signal }
      );
      await refresh();
    } catch (failure) {
      explain(failure, "Couldn't remove that");
    }
  };

  function render() {
    fill(body,
      list.length
        ? h("ul", { className: "origin-list" }, list.map((app) =>
            h("li", {},
              h("div", {},
                h("div", { text: app.name || app.provider }),
                h("div", { className: "muted", text: [app.brand || app.provider, app.serverUrl].filter(Boolean).join(" · ") })),
              h("span", { className: "row-actions" },
                h("button", { type: "button", className: "ghost", text: "Edit", on: { click: () => void edit(app) } }),
                h("button", { type: "button", className: "ghost danger", text: "Remove", on: { click: () => void remove(app) } })))) )
        : h("p", { className: "muted", text: "Everybody signs in with a password or a passkey. No other provider is configured." }),
      h("div", { className: "form-actions" }, h("button", { type: "button", text: "Add sign-on provider", on: { click: () => void edit() } })),
      error);
  }

  render();
  return section("Signing in", body);
}
