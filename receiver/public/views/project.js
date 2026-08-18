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
import { h, fill, emptyState, field } from "../lib/dom.js";
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

  const reporting = new Map(
    (apps.data?.projects || [])
      .filter((app) => app.glitchtipProject)
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
              on: { click: () => go(routeHref(withOrg("/projects/new", linkOrg, { orgs }))) },
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

  const app = (apps.data?.projects || []).find((one) => one.glitchtipProject === slug) || null;

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("section", { className: "issue-detail" },
        back,
        h("header", { className: "detail-head" },
          h("h2", { text: project.name || slug }),
          h("span", { className: "muted", text: project.platform || "" })
        ),

        keys.failed !== undefined
          ? unavailable("Where this project's errors come from", keys.failed, "its keys")
          : keysSection(keys.data, { base, can, signal }),

        app
          ? sentinelSection(app, { linkOrg, orgs })
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

  return section(
    "Where this project's errors come from",
    list.length
      ? h("div", {}, rows)
      : h("p", { className: "muted", text: "This project has no key, so nothing can report to it yet." }),
    error
  );
}

/** Sentinel's half: the app, its reports, and where it may report from. */
function sentinelSection(app, { linkOrg, orgs }) {
  return section(
    "Reports",
    h("p", {},
      h("a", {
        className: "linky",
        href: routeHref(withOrg(`/reports/${encodeURIComponent(app.appName)}`, linkOrg, { orgs })),
        text: `${app.total} report${app.total === 1 ? "" : "s"} from ${app.appName} →`,
      })
    ),
    h("p", { className: "muted",
      text: app.origins?.length
        ? `Reports accepted from: ${app.origins.join(", ")}`
        : "No origins are allowed to post reports for this app yet." })
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
