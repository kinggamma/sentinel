/**
 * Teams: the list, and one team's own screen.
 *
 * The rest of Phase 5. A team is how GlitchTip decides who can see which
 * projects — membership of a team is what puts a project in front of
 * somebody — so it is not an organisational nicety here. It is the thing
 * that answers "why can't they see this app's errors", which until now had
 * no answer anywhere in Sentinel.
 *
 * A team has a slug and nothing else. No name, no description: GlitchTip's
 * update endpoint takes exactly one field, so this screen offers exactly one
 * rather than inventing a name that has nowhere to live.
 *
 * Everything that writes needs team:write, which is admin or above. The role
 * comes from the server (auth/roles.js) for the reason it always does: a
 * refusal here is a 404 that explains nothing.
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go } from "../lib/router.js";
import { withOrg } from "../lib/org.js";

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

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function teamsListView({ outlet, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show teams for."));
    return;
  }

  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;

  const teams = await settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/teams/`, { signal }));
  throwIfAborted(signal);

  if (teams.failed !== undefined) {
    fill(outlet, h("div", { className: "issues-view" },
      h("p", { className: "error", text: readFailure(teams.failed, "the teams") })));
    return;
  }

  const rows = (teams.data || []).map((team) =>
    h("tr", {},
      h("td", {},
        h("a", {
          className: "issue-title",
          href: routeHref(withOrg(`/teams/${encodeURIComponent(team.slug)}`, linkOrg, { orgs })),
          text: team.slug,
        }),
        team.isMember ? h("div", { className: "issue-sub muted", text: "you're in this one" }) : null
      ),
      h("td", { text: count(team.memberCount ?? 0, "member", "members") }),
      h("td", { text: count((team.projects || []).length, "project", "projects") })
    )
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("header", { className: "detail-head" },
        h("h2", { text: "Teams" }),
        can.canManageTeams
          ? h("button", {
              type: "button",
              text: "New team",
              on: { click: () => go(withOrg("/teams/new", linkOrg, { orgs })) },
            })
          : null
      ),
      h("p", { className: "muted",
        text: "A team is who can see which projects. Somebody who cannot find an app's errors is usually in no team that has it." }),
      rows.length
        ? h("table", { className: "issues-table" },
            h("thead", {}, h("tr", {},
              h("th", { text: "Team" }), h("th", { text: "Members" }), h("th", { text: "Projects" })
            )),
            h("tbody", {}, rows)
          )
        : emptyState("No teams yet.")
    )
  );
}

export async function teamNewView({ outlet, signal }, { org, orgs = [], me } = {}) {
  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;
  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/teams", linkOrg, { orgs })),
    text: "← All teams",
  });

  if (!org || !can.canManageTeams) {
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "muted",
        text: "Creating a team needs the admin role in this organisation. Ask an owner." })));
    return;
  }

  const slug = field({ label: "Name", id: "new-team-slug", placeholder: "platform" });
  const error = h("p", { className: "error" });
  error.hidden = true;
  const submit = h("button", { type: "submit", text: "Create team" });

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("section", { className: "issue-detail" },
        back,
        h("header", { className: "detail-head" }, h("h2", { text: "New team" })),
        h("p", { className: "muted",
          text: "Whoever creates a team is put in it, so you can start adding projects straight away." }),
        h("form", {
          on: {
            submit: async (event) => {
              event.preventDefault();
              error.hidden = true;
              const wanted = slug.input.value
                .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
              if (!wanted) {
                error.hidden = false;
                error.textContent = "Give it a name with some letters or numbers in it.";
                return;
              }
              submit.disabled = true;
              try {
                const created = await glitchtip.post(
                  `/organizations/${encodeURIComponent(org)}/teams/`,
                  { slug: wanted },
                  { signal }
                );
                go(withOrg(`/teams/${encodeURIComponent(created.slug || wanted)}`, linkOrg, { orgs }));
              } catch (failure) {
                error.hidden = false;
                error.textContent =
                  failure?.status === 400 || failure?.status === 409
                    ? `Something already uses "${wanted}".`
                    : failure?.message || `Couldn't create that (${failure?.status ?? 0}).`;
                submit.disabled = false;
              }
            },
          },
        }, slug.node, h("div", { className: "form-actions" }, submit)),
        error
      )
    )
  );
}

/**
 * One team: who is in it, and what it can reach.
 *
 * Both halves are lists with an add and a remove, because both are the same
 * question asked twice — a team is only the join between people and
 * projects, and the whole point of the screen is to see that join in one
 * place rather than infer it.
 */
export async function teamDetailView({ outlet, params, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this team under."));
    return;
  }

  const slug = params.slug;
  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;
  const base = `/teams/${encodeURIComponent(org)}/${encodeURIComponent(slug)}`;

  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/teams", linkOrg, { orgs })),
    text: "← All teams",
  });

  const view = h("div", { className: "issues-view" });
  let notice = "";
  const say = (message) => {
    notice = message || "";
  };

  async function load() {
    const [team, members, projects, everyone, allProjects] = await Promise.all([
      settle(glitchtip.get(`${base}/`, { signal })),
      settle(glitchtip.get(`${base}/members/`, { signal })),
      settle(glitchtip.get(`${base}/projects/`, { signal })),
      // Who could be added, and what could be added — both are the whole
      // organisation minus what is already here.
      settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/members/`, { signal })),
      settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/projects/`, { signal })),
    ]);
    throwIfAborted(signal);
    return { team, members, projects, everyone, allProjects };
  }

  const repaint = async () => paint(await load());

  function paint({ team, members, projects, everyone, allProjects }) {
    if (team.failed !== undefined) {
      fill(view, back, h("p", { className: "error", text: readFailure(team.failed, `"${slug}"`) }));
      return;
    }

    const banner = h("p", { className: "error", text: notice });
    banner.hidden = !notice;

    const inTeam = members.data || [];
    const hasProjects = projects.data || [];
    const inTeamIds = new Set(inTeam.map((one) => String(one.id)));
    const hasProjectSlugs = new Set(hasProjects.map((one) => one.slug));

    const addable = (everyone.data || []).filter((one) => !inTeamIds.has(String(one.id)));
    const attachable = (allProjects.data || []).filter((one) => !hasProjectSlugs.has(one.slug));

    fill(
      view,
      h("section", { className: "issue-detail" },
        back,
        h("header", { className: "detail-head" }, h("h2", { text: slug })),
        banner,

        members.failed !== undefined
          ? section("Who is in it", h("p", { className: "muted", text: readFailure(members.failed, "its members") }))
          : section("Who is in it",
              inTeam.length
                ? h("ul", { className: "origin-list" },
                    inTeam.map((member) =>
                      h("li", {},
                        h("span", { text: member.email }),
                        can.canManageTeams
                          ? h("button", {
                              type: "button",
                              className: "ghost danger",
                              text: "Remove",
                              on: { click: () => void detach(member) },
                            })
                          : null
                      )
                    )
                  )
                : h("p", { className: "muted", text: "Nobody is in this team, so it grants nothing." }),
              can.canManageTeams && addable.length ? adder(addable) : null
            ),

        projects.failed !== undefined
          ? section("What it can see", h("p", { className: "muted", text: readFailure(projects.failed, "its projects") }))
          : section("What it can see",
              hasProjects.length
                ? h("ul", { className: "origin-list" },
                    hasProjects.map((project) =>
                      h("li", {},
                        h("a", {
                          className: "linky",
                          href: routeHref(withOrg(`/projects/${encodeURIComponent(project.slug)}`, linkOrg, { orgs })),
                          text: project.name || project.slug,
                        }),
                        can.canLinkProjectsToTeams
                          ? h("button", {
                              type: "button",
                              className: "ghost danger",
                              text: "Remove",
                              on: { click: () => void unlink(project) },
                            })
                          : null
                      )
                    )
                  )
                : h("p", { className: "muted",
                    text: "This team reaches no projects, so being in it shows nobody anything." }),
              can.canManageTeams && !can.canLinkProjectsToTeams
                ? h("p", { className: "muted",
                    text: "Adding a project to a team needs the manager role — GlitchTip requires it here even though creating the team does not." })
                : null,
              can.canLinkProjectsToTeams && attachable.length ? linker(attachable) : null
            ),

        can.canManageTeams ? renameAndDelete() : null
      )
    );
  }

  const act = async (run, whatWentWrong) => {
    try {
      await run();
      say("");
    } catch (failure) {
      say(failure?.message || `${whatWentWrong} (${failure?.status ?? 0}).`);
    }
    await repaint().catch(() => {});
  };

  const attach = (member) =>
    act(
      () => glitchtip.post(
        `/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(member.id)}/teams/${encodeURIComponent(slug)}/`,
        {},
        { signal }
      ),
      "Couldn't add them"
    );

  const detach = async (member) => {
    const sure = await confirmAction({
      title: `Take ${member.email} out of ${slug}?`,
      detail:
        "They lose sight of every project this team reaches, unless another team they are in has it too.",
      confirm: "Remove them",
    });
    if (!sure) return;
    return act(
      () => glitchtip.del(
        `/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(member.id)}/teams/${encodeURIComponent(slug)}/`,
        { signal }
      ),
      "Couldn't remove them"
    );
  };

  const link = (project) =>
    act(
      () => glitchtip.post(
        `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project.slug)}/teams/${encodeURIComponent(slug)}/`,
        {},
        { signal }
      ),
      "Couldn't add that project"
    );

  const unlink = async (project) => {
    const sure = await confirmAction({
      title: `Take ${project.name || project.slug} out of ${slug}?`,
      detail:
        "Everybody in this team loses sight of that project's errors, unless another team they are in reaches it.",
      confirm: "Remove it",
    });
    if (!sure) return;
    return act(
      () => glitchtip.del(
        `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project.slug)}/teams/${encodeURIComponent(slug)}/`,
        { signal }
      ),
      "Couldn't remove that project"
    );
  };

  function adder(candidates) {
    const pick = h("select", { attrs: { "aria-label": "Somebody to add" } },
      candidates.map((one) => h("option", { value: String(one.id), text: one.email })));
    return h("form", {
      className: "origin-add",
      on: {
        submit: (event) => {
          event.preventDefault();
          const chosen = candidates.find((one) => String(one.id) === pick.value);
          if (chosen) void attach(chosen);
        },
      },
    }, pick, h("button", { type: "submit", text: "Add" }));
  }

  function linker(candidates) {
    const pick = h("select", { attrs: { "aria-label": "A project this team should reach" } },
      candidates.map((one) => h("option", { value: one.slug, text: one.name || one.slug })));
    return h("form", {
      className: "origin-add",
      on: {
        submit: (event) => {
          event.preventDefault();
          const chosen = candidates.find((one) => one.slug === pick.value);
          if (chosen) void link(chosen);
        },
      },
    }, pick, h("button", { type: "submit", text: "Add" }));
  }

  /**
   * A team's whole settings screen: its name, and getting rid of it.
   *
   * Renaming changes the slug, which is the only thing a team has, so the
   * two live together rather than pretending there is a settings page.
   */
  function renameAndDelete() {
    const next = field({ label: "Name", id: "team-slug", value: slug });
    const save = h("button", { type: "submit", text: "Rename" });

    return section(
      "Settings",
      h("form", {
        on: {
          submit: async (event) => {
            event.preventDefault();
            const wanted = next.input.value
              .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            if (!wanted || wanted === slug) return;
            save.disabled = true;
            try {
              await glitchtip.put(`${base}/`, { slug: wanted }, { signal });
              // The address contains the old name, so staying here would be
              // a screen about a team that no longer answers to it.
              go(withOrg(`/teams/${encodeURIComponent(wanted)}`, linkOrg, { orgs }));
            } catch (failure) {
              say(failure?.message || `Couldn't rename it (${failure?.status ?? 0}).`);
              save.disabled = false;
              await repaint().catch(() => {});
            }
          },
        },
      }, next.node, h("div", { className: "form-actions" }, save)),

      h("p", { className: "muted",
        text: "Deleting a team does not delete its projects. It takes away everyone's route to them, which for anybody not in another team with the same projects is the same thing." }),
      h("button", {
        type: "button",
        className: "ghost danger",
        text: "Delete this team",
        on: {
          click: async () => {
            const sure = await confirmAction({
              title: `Delete the ${slug} team?`,
              detail:
                "Its projects survive. What goes is everybody's route to them — for anyone not in " +
                "another team with the same projects, that is the same thing as losing them.",
              confirm: "Delete it",
            });
            if (!sure) return;

            try {
              await glitchtip.del(`${base}/`, { signal });
              go(withOrg("/teams", linkOrg, { orgs }));
            } catch (failure) {
              say(failure?.message || `Couldn't delete it (${failure?.status ?? 0}).`);
              await repaint().catch(() => {});
            }
          },
        },
      })
    );
  }

  paint(await load());
  fill(outlet, view);
}
