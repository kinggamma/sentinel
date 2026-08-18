/**
 * Who is in this organisation, and who has asked to be.
 *
 * Phase 5, and the second place two ideas become one screen. GlitchTip has
 * members: an email, a role, and whether they have accepted their invitation.
 * Sentinel has a queue of people who found the sign-in page, had no account,
 * and asked. Those were separate screens answering the same question — who
 * may see this — and answering it in a different order each time.
 *
 * They are one list now, pending requests first, because a person waiting on
 * somebody is more urgent than a person who already has what they need.
 *
 * The two halves are not performed the same way, and the difference is real
 * rather than cosmetic. Approving a request goes through Sentinel's own
 * service token, so GlitchTip never checks the approver's role and any
 * member may do it. Inviting somebody directly, changing a role, or removing
 * a member goes through this person's own session, so GlitchTip enforces
 * their role — manager or above. One screen, two authorities, and each
 * control appears only when the thing behind it would actually work.
 */

import { sentinel, glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref } from "../lib/router.js";
import { withOrg } from "../lib/org.js";

const ROLES = ["member", "admin", "manager", "owner"];

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

function when(value) {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString();
}

export async function peopleView({ outlet, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show people for."));
    return;
  }

  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;

  /**
   * The queue is only fetched by somebody who may act on it.
   *
   * It contains the email address and words of a person asking to be let in,
   * and the server now refuses it to anyone below manager. Asking anyway
   * would put a 403 on the screen for an ordinary member on a screen that is
   * otherwise entirely theirs to look at.
   */
  const [members, queue] = await Promise.all([
    settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/members/`, { signal })),
    can.canManageMembers
      ? settle(sentinel.get("/access/requests", { signal }))
      : Promise.resolve({ data: { requests: [] } }),
  ]);
  throwIfAborted(signal);

  if (members.failed !== undefined) {
    fill(
      outlet,
      h("div", { className: "issues-view" },
        h("p", { className: "error", text: readFailure(members.failed, "the member list") }))
    );
    return;
  }

  const view = h("div", { className: "issues-view" });

  /**
   * What went wrong, held here rather than in the section that raised it.
   *
   * Every handler repaints the list after acting, and a repaint rebuilds
   * those sections — so a message written into one of them was erased a
   * moment later by the very refresh meant to show its consequences. This
   * outlives the repaint, and is cleared by the next action rather than by
   * redrawing.
   */
  let notice = "";
  const say = (message) => {
    notice = message || "";
  };

  // Returns the promise: callers await it, and one of them attaches a
  // catch. `void render()` gave them undefined to attach it to.
  const repaint = () => render();

  async function render() {
    const [fresh, freshQueue] = await Promise.all([
      settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/members/`, { signal })),
      settle(sentinel.get("/access/requests", { signal })),
    ]);
    throwIfAborted(signal);
    paint(fresh.data || [], freshQueue);
  }

  function paint(rows, requests) {
    const banner = h("p", { className: "error", text: notice });
    banner.hidden = !notice;

    const waiting = (requests.data?.requests || []).filter((one) => one.status === "pending");

    fill(
      view,
      h("section", { className: "issue-detail" },
        h("header", { className: "detail-head" }, h("h2", { text: "People" })),
        banner,

        // Asked and waiting, first: somebody is on the other end of these.
        requests.failed !== undefined
          ? section("Waiting to be let in",
              h("p", { className: "muted", text: readFailure(requests.failed, "the request queue") }))
          : waiting.length
            ? section("Waiting to be let in", requestList(waiting, { org, repaint, signal }))
            : null,

        section("Members", memberList(rows, { org, can, me, repaint, say, signal })),

        can.canManageMembers ? inviteForm({ org, repaint, signal }) : null,

        can.canManageTeams
          ? h("p", {},
              h("a", {
                className: "linky",
                href: routeHref(withOrg("/teams", linkOrg, { orgs })),
                text: "Teams →",
              }))
          : null
      )
    );
  }

  paint(members.data || [], queue);
  fill(outlet, view);
}

/**
 * People who asked, and are still waiting.
 *
 * Approving needs an organisation to approve them into, which is only a
 * question when the approver belongs to more than one. With one it is not
 * asked, because the only possible answer is not a decision.
 */
function requestList(requests, { org, repaint, signal }) {
  const error = h("p", { className: "error" });
  error.hidden = true;

  const act = async (id, path, body) => {
    error.hidden = true;
    try {
      await sentinel.post(`/access/requests/${encodeURIComponent(id)}/${path}`, body, { signal });
      await repaint();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure?.message || `Couldn't do that (${failure?.status ?? 0}).`;
    }
  };

  return h("div", {},
    h("ul", { className: "origin-list" },
      requests.map((request) =>
        h("li", {},
          h("div", {},
            h("div", { text: request.email }),
            h("div", { className: "muted",
              text: [request.note, when(request.createdAt)].filter(Boolean).join(" · ") })
          ),
          h("div", { className: "row-actions" },
            h("button", {
              type: "button",
              text: "Approve",
              on: { click: () => void act(request.id, "approve", { organisation: org }) },
            }),
            h("button", {
              type: "button",
              className: "ghost danger",
              text: "Decline",
              on: { click: () => void act(request.id, "decline", {}) },
            })
          )
        )
      )
    ),
    error
  );
}

/**
 * The members themselves.
 *
 * A role is a select rather than a screen of its own: it is one field with
 * four values, and making somebody navigate to change it would be the two
 * screens this phase exists to collapse.
 *
 * Nobody can change or remove their own row. GlitchTip stops the last owner
 * from demoting themselves and it is right to, but the useful version of
 * that rule is not offering the control that strands you.
 */
function memberList(rows, { org, can, me, repaint, say, signal }) {

  const mine = (row) => row.email && me?.email && row.email.toLowerCase() === me.email.toLowerCase();

  /**
   * GlitchTip explains this one properly — "Organization must have at least
   * one owner" for the last owner — so its sentence is shown rather than
   * replaced with a status code. The rule is its rule, and it knows more
   * about why than a mirror here would.
   *
   * The list is repainted whether it worked or not: a select left showing
   * the value the server refused is a screen quietly disagreeing with the
   * thing it is displaying.
   */
  const change = async (row, role) => {
    try {
      /**
       * Role only. `teamRoles: []` was also being sent, which this endpoint
       * ignores — it sets the role and never reads the field — but sending
       * an empty list of somebody's teams while changing their role is a
       * sentence waiting to be taken literally. The field is optional, so
       * the safe version is not to say it.
       */
      await glitchtip.put(
        `/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(row.id)}/`,
        { orgRole: role },
        { signal }
      );
      say("");
      await repaint();
    } catch (failure) {
      say(failure?.message || `Couldn't change that role (${failure?.status ?? 0}).`);
      // Repainted either way: a select still showing the value the server
      // refused is the screen disagreeing with what it is displaying.
      await repaint().catch(() => {});
    }
  };

  const remove = async (row) => {
    const sure = await confirmAction({
      title: `Remove ${row.email}?`,
      detail:
        "They lose access to this organisation's projects and everything Sentinel shows for them. " +
        "Their reports and notes stay. You can invite them back, but they will have to accept again.",
      confirm: "Remove them",
    });
    if (!sure) return;

    try {
      await glitchtip.del(
        `/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(row.id)}/`,
        { signal }
      );
      say("");
      await repaint();
    } catch (failure) {
      say(failure?.message || `Couldn't remove them (${failure?.status ?? 0}).`);
      await repaint().catch(() => {});
    }
  };

  if (!rows.length) return emptyState("Nobody is in this organisation yet.");

  return h("div", {},
    h("table", { className: "issues-table" },
      h("thead", {}, h("tr", {},
        h("th", { text: "Member" }),
        h("th", { text: "Role" }),
        h("th", { text: "" })
      )),
      h("tbody", {},
        rows.map((row) => {
          const editable = can.canManageMembers && !mine(row);

          const select = h(
            "select",
            {
              attrs: { "aria-label": `Role for ${row.email}` },
              on: { change: (event) => void change(row, event.target.value) },
            },
            ROLES.map((role) =>
              h("option", { value: role, text: role, selected: role === row.role })
            )
          );

          return h("tr", {},
            h("td", {},
              h("div", { text: row.email }),
              h("div", { className: "issue-sub muted",
                text: [
                  mine(row) ? "you" : null,
                  row.pending ? "invited, not accepted yet" : null,
                  when(row.dateCreated),
                ].filter(Boolean).join(" · ") })
            ),
            h("td", {}, editable ? select : h("span", { className: "muted", text: row.roleName || row.role })),
            h("td", {},
              editable
                ? h("button", {
                    type: "button",
                    className: "linky danger",
                    text: "Remove",
                    on: { click: () => void remove(row) },
                  })
                : null
            )
          );
        })
      )
    )
  );
}

/** Inviting somebody who has not asked. */
function inviteForm({ org, repaint, signal }) {
  const email = field({ label: "Email", id: "invite-email", type: "email", placeholder: "them@example.org" });
  const role = h("select", { id: "invite-role" }, ROLES.map((one) => h("option", { value: one, text: one })));
  const error = h("p", { className: "error" });
  error.hidden = true;
  const note = h("p", { className: "muted" });
  note.hidden = true;
  const submit = h("button", { type: "submit", text: "Send invitation" });

  return section(
    "Invite somebody",
    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          note.hidden = true;
          const address = email.input.value.trim();
          if (!address) return;
          submit.disabled = true;
          try {
            const created = await glitchtip.post(
              `/organizations/${encodeURIComponent(org)}/members/`,
              { email: address, orgRole: role.value, teamRoles: [] },
              { signal }
            );
            email.input.value = "";
            note.hidden = false;
            // Shown rather than assumed sent: an installation with no mail
            // configured invites perfectly well and delivers nothing, and
            // this link is then the only way anybody gets in.
            note.textContent = created?.inviteLink
              ? `Invited. If no email arrives, send them this: ${created.inviteLink}`
              : "Invited.";
            await repaint();
          } catch (failure) {
            error.hidden = false;
            error.textContent =
              failure?.status === 409
                ? "They are already a member or already invited."
                : `Couldn't invite them (${failure?.status ?? 0}).`;
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
      email.node,
      h("label", { className: "field" }, h("span", { className: "field-label", text: "Role" }), role),
      h("div", { className: "form-actions" }, submit)
    ),
    note,
    error
  );
}
