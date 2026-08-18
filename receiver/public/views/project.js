/**
 * Projects: the list, and one project's own screen.
 *
 * Phase 4, and the first place two backends stop being two screens. A
 * project is a GlitchTip thing — it has keys, alert rules, environments, and
 * a slug people paste into SDKs — and an app is a Sentinel thing, with
 * reports and a list of origins allowed to send them. They have always been
 * the same object seen from two sides, managed in two places, and this is
 * the one page that shows both.
 *
 * What can be done here depends on the role GlitchTip gave you, which is
 * answered by the server (auth/roles.js) rather than worked out here. It
 * matters more than the usual "hide what they cannot use": GlitchTip refuses
 * a write the role lacks the scope for by answering 404, exactly as it
 * answers a route that does not exist, so a button offered to a member
 * produces a failure nobody can explain.
 */

import { sentinel, glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go } from "../lib/router.js";
import { withOrg } from "../lib/org.js";

/** GlitchTip answers a scope failure the same way it answers a bad URL. */
function readFailure(status, subject = "this") {
  if (status === 403) return `You don't have access to ${subject}.`;
  if (status === 404) return `${subject} isn't there, or your role can't reach it.`;
  if (status === 0) return "Couldn't reach the server.";
  return `Couldn't load ${subject} (${status}).`;
}

/** Swallow nothing; each section says what happened to it. */
const settle = (promise) =>
  promise.then((data) => ({ data }), (error) => ({ failed: error?.status ?? 0 }));

function section(title, ...children) {
  return h("section", { className: "detail-section" }, h("h3", { text: title }), children);
}

function unavailable(title, status, subject) {
  return section(title, h("p", { className: "muted", text: readFailure(status, subject) }));
}

/**
 * Every project in the organisation, whether or not it has ever reported to
 * Sentinel.
 *
 * The landing grid answers a different question — which apps have sent
 * reports — and an app that reports to no project and a project no app
 * reports to are both normal. This is the GlitchTip side of that, so a
 * project created in GlitchTip is visible here the moment it exists.
 */
export async function projectsListView({ outlet, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show projects for."));
    return;
  }

  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;

  const [projects, apps] = await Promise.all([
    settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/projects/`, { signal })),
    // Which of them Sentinel knows as an app, so a project can say whether
    // reports are coming in as well as errors.
    settle(sentinel.get("/projects", { signal })),
  ]);
  throwIfAborted(signal);

  if (projects.failed !== undefined) {
    fill(
      outlet,
      h("div", { className: "issues-view" },
        h("p", { className: "error", text: readFailure(projects.failed, "projects") }))
    );
    return;
  }

  /**
   * Keyed by slug, but only for apps in the organisation on screen. A slug
   * identifies a project inside its organisation and nowhere else, so two
   * organisations may each have an "admin" — and matching on slug alone put
   * one organisation's report counts and origins on the other's project.
   */
  const reporting = new Map(
    (apps.data?.projects || [])
      .filter((app) => app.glitchtipProject && app.org === org)
      .map((app) => [app.glitchtipProject, app])
  );

  const rows = (projects.data || []).map((project) => {
    const app = reporting.get(project.slug);
    return h(
      "tr",
      {},
      h("td", {},
        h("a", {
          className: "issue-title",
          href: routeHref(withOrg(`/projects/${encodeURIComponent(project.slug)}`, linkOrg, { orgs })),
          text: project.name || project.slug,
        }),
        h("div", { className: "issue-sub muted", text: project.slug })
      ),
      h("td", { text: project.platform || "—" }),
      h("td", {},
        app
          ? h("a", {
              className: "linky",
              href: routeHref(withOrg(`/reports/${encodeURIComponent(app.appName)}`, linkOrg, { orgs })),
              text: `${app.total} report${app.total === 1 ? "" : "s"}`,
            })
          : h("span", { className: "muted", text: "not reporting" })
      )
    );
  });

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("header", { className: "detail-head" },
        h("h2", { text: "Projects" }),
        can.canManageProjects
          ? h("button", {
              type: "button",
              text: "New project",
              on: { click: () => go(withOrg("/projects/new", linkOrg, { orgs })) },
            })
          : null
      ),
      rows.length
        ? h("table", { className: "issues-table" },
            h("thead", {}, h("tr", {},
              h("th", { text: "Project" }),
              h("th", { text: "Platform" }),
              h("th", { text: "Reports" })
            )),
            h("tbody", {}, rows)
          )
        : emptyState("No projects in this organisation yet.")
    )
  );
}

/**
 * One project, from both sides.
 *
 * Existence is established from the project itself, which 404s properly for
 * a slug that is not there. Its sub-resources do not — keys, alerts and
 * environments all answer 200 with an empty list for a project that does not
 * exist — so trusting those would render a convincing, entirely empty page
 * for a typo.
 */
export async function projectDetailView({ outlet, params, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this project under."));
    return;
  }

  const slug = params.slug;
  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;
  const base = `/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug)}`;

  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/projects", linkOrg, { orgs })),
    text: "← All projects",
  });

  let project;
  try {
    project = await glitchtip.get(`${base}/`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(
      outlet,
      h("div", { className: "issues-view" }, back,
        h("p", { className: "error", text: readFailure(error?.status ?? 0, `"${slug}"`) }))
    );
    return;
  }
  throwIfAborted(signal);

  const [keys, alerts, environments, apps] = await Promise.all([
    settle(glitchtip.get(`${base}/keys/`, { signal })),
    settle(glitchtip.get(`${base}/alerts/`, { signal })),
    settle(glitchtip.get(`${base}/environments/`, { signal })),
    settle(sentinel.get("/projects", { signal })),
  ]);
  throwIfAborted(signal);

  // Organisation as well as slug: see the list view above — the same slug in
  // two organisations is two different projects.
  const app =
    (apps.data?.projects || []).find(
      (one) => one.glitchtipProject === slug && one.org === org
    ) || null;

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("section", { className: "issue-detail" },
        back,
        h("header", { className: "detail-head" },
          h("h2", { text: project.name || slug }),
          h("span", { className: "muted", text: project.platform || "" })
        ),

        can.canManageProjects
          ? generalSection(project, { base, signal })
          : null,

        keys.failed !== undefined
          ? unavailable("Where this project's errors come from", keys.failed, "its keys")
          : keysSection(keys.data, { base, can, signal }),

        app
          ? sentinelSection(app, { linkOrg, orgs, can, signal })
          : section(
              "Reports",
              h("p", { className: "muted",
                text: "No app reports to this project yet. An app starts reporting once its SDK is pointed at the DSN above." })
            ),

        environments.failed !== undefined
          ? unavailable("Environments", environments.failed, "its environments")
          : environmentsSection(environments.data),

        alerts.failed !== undefined
          ? unavailable("Alerts", alerts.failed, "its alert rules")
          : alertsSection(alerts.data, { can })
      )
    )
  );
}

/**
 * Renaming a project, and saying what it is written in.
 *
 * The slug is deliberately not editable. It is in every SDK's DSN and in
 * every link into GlitchTip, and changing it here would break reporting for
 * a running app with no warning worth the risk — GlitchTip's own settings
 * screen is one click away for anyone who genuinely means to.
 */
function generalSection(project, { base, signal }) {
  const name = field({ label: "Name", id: "project-name", value: project.name || "" });
  const platform = field({
    label: "Platform",
    id: "project-platform",
    value: project.platform || "",
    placeholder: "javascript, php, python…",
  });
  const saved = h("span", { className: "muted" });
  saved.hidden = true;
  const error = h("p", { className: "error" });
  error.hidden = true;

  const submit = h("button", { type: "submit", text: "Save" });

  const form = h(
    "form",
    {
      className: "project-general",
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          saved.hidden = true;
          submit.disabled = true;
          try {
            await glitchtip.put(
              `${base}/`,
              {
                name: name.input.value.trim() || project.name,
                slug: project.slug,
                platform: platform.input.value.trim() || null,
              },
              { signal }
            );
            saved.hidden = false;
            saved.textContent = "Saved.";
          } catch (failure) {
            error.hidden = false;
            error.textContent = `Couldn't save that (${failure?.status ?? 0}).`;
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
    name.node,
    platform.node,
    h("div", { className: "form-actions" }, submit, saved)
  );

  return section("Settings", form, h("p", { className: "muted mono", text: project.slug }), error);
}

/**
 * The DSN, which is the one thing on this page somebody is usually here to
 * copy.
 *
 * Sentinel showed this on its own settings screen and GlitchTip shows it on
 * its project page; it is the same string, and this is now the only place it
 * needs to be looked for.
 */
function keysSection(keys, { base, can, signal }) {
  const list = Array.isArray(keys) ? keys : [];
  const error = h("p", { className: "error" });
  error.hidden = true;

  const rows = list.map((key) =>
    h("div", { className: "dsn-row" },
      h("div", {},
        h("div", { text: key.name || "unnamed key" }),
        h("code", { className: "mono dsn", text: key.dsn?.public || "" })
      ),
      can.canManageProjects && list.length > 1
        ? h("button", {
            type: "button",
            className: "linky danger",
            text: "Revoke",
            on: {
              click: async () => {
                const sure = await confirmAction({
                  title: "Revoke this key?",
                  detail:
                    "Anything still reporting with this DSN stops being able to, immediately and " +
                    "without an error anybody will see. A revoked key cannot be restored.",
                  confirm: "Revoke it",
                });
                if (!sure) return;

                error.hidden = true;
                try {
                  await glitchtip.del(`${base}/keys/${encodeURIComponent(key.id)}/`, { signal });
                  location.reload();
                } catch (failure) {
                  error.hidden = false;
                  error.textContent = `Couldn't revoke that key (${failure?.status ?? 0}).`;
                }
              },
            },
          })
        : null
    )
  );

  const add = can.canManageProjects
    ? h("button", {
        type: "button",
        className: "ghost",
        text: "Add a key",
        on: {
          click: async () => {
            error.hidden = true;
            try {
              await glitchtip.post(`${base}/keys/`, { name: "" }, { signal });
              location.reload();
            } catch (failure) {
              error.hidden = false;
              error.textContent = `Couldn't add a key (${failure?.status ?? 0}).`;
            }
          },
        },
      })
    : null;

  return section(
    "Where this project's errors come from",
    list.length
      ? h("div", {}, rows)
      : h("p", { className: "muted", text: "This project has no key, so nothing can report to it yet." }),
    // The last key is not revocable: removing it silently stops every app
    // reporting to this project, and there would be nothing left to point
    // them at.
    add,
    error
  );
}

/**
 * Sentinel's half: the app, its reports, and where its browser code may
 * report from.
 *
 * The origins list used to be its own screen under Settings, reached from a
 * project card, and it was the clearest case of one thing managed in two
 * places — a project's DSN was here in GlitchTip while the list of addresses
 * allowed to use that DSN was over there. Same object, same page now.
 *
 * Note what an empty list means, because it is not "nothing may report":
 * server-side reporting needs no entry at all, and only pages running in a
 * browser are checked against this.
 */
function sentinelSection(app, { linkOrg, orgs, can, signal }) {
  const error = h("p", { className: "error" });
  error.hidden = true;
  const list = h("ul", { className: "origin-list" });

  const paint = (origins) => {
    if (!origins.length) {
      fill(list, h("li", { className: "muted",
        text: "No addresses yet. An app reporting from its own server does not need one." }));
      return;
    }
    fill(
      list,
      origins.map((origin) =>
        h("li", {},
          h("span", { className: "mono", text: origin }),
          can.canManageProjects
            ? h("button", {
                type: "button",
                className: "ghost danger",
                text: "Remove",
                on: { click: () => void save(origins.filter((one) => one !== origin)) },
              })
            : null
        )
      )
    );
  };

  const save = async (next) => {
    error.hidden = true;
    try {
      const body = await sentinel.put(
        `/settings/apps/${encodeURIComponent(app.appName)}`,
        { origins: next },
        { signal }
      );
      const updated = (body?.apps || []).find((one) => one.appName === app.appName);
      paint(updated?.origins || next);
      return true;
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure?.message || "Couldn't save that.";
      return false;
    }
  };

  const input = h("input", {
    type: "text",
    attrs: { placeholder: "https://app.example.org", "aria-label": "Address this app reports from" },
  });

  const form = can.canManageProjects
    ? h("form", {
        className: "origin-add",
        on: {
          submit: async (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (!value) return;
            const current = [...list.querySelectorAll(".mono")].map((node) => node.textContent);
            if (await save([...current, value])) input.value = "";
          },
        },
      }, input, h("button", { type: "submit", text: "Add" }))
    : null;

  paint(app.origins || []);

  return section(
    "Reports",
    h("p", {},
      h("a", {
        className: "linky",
        href: routeHref(withOrg(`/reports/${encodeURIComponent(app.appName)}`, linkOrg, { orgs })),
        text: `${app.total} report${app.total === 1 ? "" : "s"} from ${app.appName} →`,
      })
    ),
    h("h4", { text: "Where its browser code may report from" }),
    list,
    form,
    error
  );
}

function environmentsSection(environments) {
  const list = Array.isArray(environments) ? environments : [];
  return section(
    "Environments",
    list.length
      ? h("ul", { className: "tag-values" },
          list.map((environment) =>
            h("li", {},
              h("span", { className: "tag-value", text: environment.name }),
              environment.isHidden ? h("span", { className: "muted", text: "hidden" }) : null
            )
          )
        )
      : h("p", { className: "muted", text: "Nothing has reported an environment yet." })
  );
}

/**
 * Alert rules, read-only for now.
 *
 * Creating one needs recipients, which needs the members list — that is
 * Phase 5. Showing what exists is worth having before then: an issue nobody
 * is told about is the failure this whole pipeline exists to prevent, and
 * "no alerts configured" is the sentence that reveals it.
 */
function alertsSection(alerts, { can }) {
  const list = Array.isArray(alerts) ? alerts : [];
  return section(
    "Alerts",
    list.length
      ? h("ul", { className: "tag-values" },
          list.map((alert) =>
            h("li", {},
              h("span", { className: "tag-value", text: alert.name || `alert ${alert.id}` }),
              h("span", { className: "muted",
                text: `${alert.quantity} in ${alert.timespanMinutes} min` })
            )
          )
        )
      : h("p", { className: "muted",
          text: can.canManageProjects
            ? "No alert rules, so nobody is told when this project starts failing."
            : "No alert rules on this project." })
  );
}

/**
 * Making a project.
 *
 * GlitchTip creates projects under a team rather than under the
 * organisation, so this has to ask which — and a team is not something most
 * people here think about, so it picks the only one when there is only one
 * and explains itself when there is a choice.
 *
 * The slug is derived rather than asked for. It is what goes in the DSN and
 * in every link, it has to be URL-safe, and offering a second box that must
 * "usually match the first" is a way to get two names for one thing.
 */
export async function projectNewView({ outlet, signal }, { org, orgs = [], me } = {}) {
  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;
  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/projects", linkOrg, { orgs })),
    text: "← All projects",
  });

  if (!org || !can.canManageProjects) {
    /**
     * Reachable by typing the address, so it is refused here as well as
     * hidden on the list. GlitchTip would refuse it too, with a 404 that
     * explains nothing — this at least says which of the two it is.
     */
    fill(
      outlet,
      h("div", { className: "issues-view" }, back,
        h("p", { className: "muted",
          text: "Creating a project needs the admin role in this organisation. Ask an owner." }))
    );
    return;
  }

  const teams = await settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/teams/`, { signal }));
  throwIfAborted(signal);

  if (teams.failed !== undefined) {
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "error", text: readFailure(teams.failed, "the teams to create it under") })));
    return;
  }

  const available = teams.data || [];
  if (!available.length) {
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "muted",
        text: "There is no team to create a project under yet. GlitchTip keeps projects in teams; make one there first." })));
    return;
  }

  const name = field({ label: "Name", id: "new-project-name", placeholder: "Admin panel" });
  const team = h(
    "select",
    { id: "new-project-team" },
    available.map((one) => h("option", { value: one.slug, text: one.slug }))
  );
  const error = h("p", { className: "error" });
  error.hidden = true;
  const submit = h("button", { type: "submit", text: "Create project" });

  const slugify = (value) =>
    value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          const label = name.input.value.trim();
          const slug = slugify(label);
          if (!slug) {
            error.hidden = false;
            error.textContent = "Give it a name with some letters or numbers in it.";
            return;
          }

          submit.disabled = true;
          try {
            const created = await glitchtip.post(
              `/teams/${encodeURIComponent(org)}/${encodeURIComponent(team.value)}/projects/`,
              { name: label, slug, platform: null },
              { signal }
            );
            go(withOrg(`/projects/${encodeURIComponent(created.slug || slug)}`, linkOrg, { orgs }));
          } catch (failure) {
            error.hidden = false;
            error.textContent =
              failure?.status === 400
                ? `Something already uses "${slug}".`
                : `Couldn't create that (${failure?.status ?? 0}).`;
            submit.disabled = false;
          }
        },
      },
    },
    name.node,
    available.length > 1
      ? h("label", { className: "field" },
          h("span", { className: "field-label", text: "Team" }), team)
      : null,
    h("div", { className: "form-actions" }, submit)
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("section", { className: "issue-detail" },
        back,
        h("header", { className: "detail-head" }, h("h2", { text: "New project" })),
        h("p", { className: "muted",
          text: available.length === 1
            ? `It will be created in the ${available[0].slug} team.`
            : "GlitchTip keeps projects in teams; pick the one this belongs to." }),
        form,
        error
      )
    )
  );
}
