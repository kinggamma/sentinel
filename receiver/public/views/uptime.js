/**
 * Uptime: what is being watched, whether it is answering, and what happened
 * the last time it stopped.
 *
 * Phase 8d, and the first of the remaining verticals that writes. Monitors
 * are created, edited and deleted here, and their check history is read.
 *
 * Two things about GlitchTip's API decide how this screen behaves.
 *
 * None of the monitor endpoints declare a permission. Not "member and above"
 * — none at all: create, update and delete are gated on organisation
 * membership and nothing else, so anybody in the organisation can point a
 * monitor anywhere and delete anybody else's. That is looser than releases,
 * which at least name a scope. The screen offers the controls to everyone
 * because hiding them would take away something GlitchTip permits, and the
 * role table records the answer rather than leaving each screen to guess.
 *
 * And its update is a replace: the handler assigns every field of the payload
 * onto the monitor, so an edit that omits the timeout does not keep the old
 * one, it clears it. The form is prefilled and always sends the whole
 * monitor (lib/uptime.js).
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go, refresh as refreshRoute } from "../lib/router.js";
import { withOrg } from "../lib/org.js";
import { since, at } from "../lib/time.js";
import {
  MONITOR_TYPES,
  knownType,
  needsUrl,
  needsExpectedStatus,
  needsExpectedBody,
  urlLabel,
  urlHint,
  monitorPayload,
  whatIsMissing,
  every,
  checkReason,
  responseTime,
} from "../lib/uptime.js";

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

const base = (org) => `/organizations/${encodeURIComponent(org)}/monitors`;

/**
 * Up, down, or not yet asked.
 *
 * The third is a real state and not a variety of down: a monitor created a
 * moment ago has no checks, and colouring it red would announce an outage
 * that has not happened.
 */
function statusChip(isUp) {
  if (isUp === true) return h("span", { className: "log-level up-yes", text: "Up" });
  if (isUp === false) return h("span", { className: "log-level up-no", text: "Down" });
  return h("span", { className: "log-level", text: "Not checked yet" });
}

export async function monitorsListView({ outlet, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show monitors for."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const monitors = await settle(glitchtip.get(`${base(org)}/`, { signal }));
  throwIfAborted(signal);

  if (monitors.failed !== undefined) {
    fill(outlet, h("div", { className: "issues-view" },
      h("p", { className: "error", text: readFailure(monitors.failed, "monitors") })));
    return;
  }

  const rows = (monitors.data || []).map((monitor) =>
    h("tr", {},
      h("td", {}, statusChip(monitor.isUp)),
      h("td", {},
        h("a", {
          className: "issue-title",
          href: routeHref(withOrg(`/uptime/${monitor.id}`, linkOrg, { orgs })),
          text: monitor.name || "(unnamed)",
        }),
        h("div", { className: "issue-sub muted", text: monitor.url || "calls in on its own" })
      ),
      h("td", { text: monitor.monitorType || "—" }),
      h("td", { text: every(monitor.interval) }),
      h("td", { text: monitor.lastChange ? since(monitor.lastChange) : "no change recorded" })
    )
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("header", { className: "detail-head row" },
        h("h2", { text: "Uptime" }),
        h("button", {
          type: "button",
          text: "New monitor",
          on: { click: () => go(withOrg("/uptime/new", linkOrg, { orgs })) },
        })),
      rows.length
        ? h("table", { className: "issues-table" },
            h("thead", {}, h("tr", {},
              h("th", { className: "log-level-col", text: "Status" }),
              h("th", { text: "Monitor" }),
              h("th", { text: "Kind" }),
              h("th", { text: "Checked" }),
              h("th", { text: "Last change" })
            )),
            h("tbody", {}, rows)
          )
        : emptyState("Nothing is being watched yet.")
    )
  );
}

export async function monitorNewView({ outlet, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to make a monitor in."));
    return;
  }
  const linkOrg = orgs.length > 1 ? org : null;
  const projects = await settle(
    glitchtip.get(`/organizations/${encodeURIComponent(org)}/projects/`, { signal })
  );
  throwIfAborted(signal);

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("a", {
        className: "linky",
        href: routeHref(withOrg("/uptime", linkOrg, { orgs })),
        text: "← All monitors",
      }),
      h("header", { className: "detail-head" }, h("h2", { text: "New monitor" })),
      monitorForm({
        org, orgs, linkOrg, signal,
        projects: projects.data || [],
        monitor: null,
        onSaved: (made) => go(withOrg(`/uptime/${made.id}`, linkOrg, { orgs }), { replace: true }),
      })
    )
  );
}

export async function monitorDetailView({ outlet, params, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this monitor under."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const id = params.id;
  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/uptime", linkOrg, { orgs })),
    text: "← All monitors",
  });

  let monitor;
  try {
    monitor = await glitchtip.get(`${base(org)}/${encodeURIComponent(id)}/`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "this monitor") })));
    return;
  }
  throwIfAborted(signal);

  const [checks, projects] = await Promise.all([
    settle(glitchtip.get(`${base(org)}/${encodeURIComponent(id)}/checks/`, { signal })),
    settle(glitchtip.get(`/organizations/${encodeURIComponent(org)}/projects/`, { signal })),
  ]);
  throwIfAborted(signal);

  const status = h("p", { className: "muted", hidden: true });
  const say = (text, kind = "muted") => {
    status.hidden = !text;
    status.className = kind;
    status.textContent = text;
  };

  const remove = async () => {
    const sure = await confirmAction({
      title: `Stop watching ${monitor.name || "this"}?`,
      detail: "The monitor and its whole history of checks go. Nothing is notified afterwards.",
      confirm: "Delete it",
      signal,
    });
    if (!sure) return;
    try {
      await glitchtip.del(`${base(org)}/${encodeURIComponent(id)}/`, { signal });
      go(withOrg("/uptime", linkOrg, { orgs }), { replace: true });
    } catch (failure) {
      say(failure?.message || `Couldn't delete that (${failure?.status ?? 0}).`, "error");
    }
  };

  fill(
    outlet,
    h("div", { className: "issues-view" },
      back,
      h("header", { className: "detail-head row" },
        h("h2", { text: monitor.name || "(unnamed)" }),
        statusChip(monitor.isUp),
        h("button", { type: "button", className: "ghost danger", text: "Delete monitor",
          on: { click: () => void remove() } })),
      status,
      h("dl", { className: "release-facts" },
        h("dt", { text: "Kind" }), h("dd", { text: monitor.monitorType || "—" }),
        h("dt", { text: needsUrl(monitor.monitorType) ? urlLabel(monitor.monitorType) : "Calls in" }),
        h("dd", { className: "mono", text: monitor.url || "yes — nothing is called out to" }),
        h("dt", { text: "Checked" }), h("dd", { text: every(monitor.interval) }),
        h("dt", { text: "Timeout" }),
        h("dd", { text: monitor.timeout ? `${monitor.timeout}s` : "none set" }),
        h("dt", { text: "Confirm failures" }),
        h("dd", { text: `${monitor.confirmationThreshold ?? 1} in a row` }),
        h("dt", { text: "Last change" }),
        h("dd", { text: monitor.lastChange ? at(monitor.lastChange) : "no change recorded" }),
        h("dt", { text: "Project" }),
        h("dd", { text: monitor.projectName || "not attached to one" })
      ),
      /**
       * A heartbeat monitor is the one kind that cannot be set up from this
       * screen alone: it needs an address pasting into whatever is supposed
       * to be calling in, and without it the monitor sits waiting forever.
       */
      monitor.heartbeatEndpoint
        ? section("Where to call in",
            h("p", { className: "muted",
              text: "Have the job POST here each time it finishes. Silence is what counts as down." }),
            h("code", { className: "mono dsn", text: monitor.heartbeatEndpoint }))
        : null,
      section("Settings",
        monitorForm({
          org, orgs, linkOrg, signal,
          projects: projects.data || [],
          monitor,
          onSaved: () => refreshRoute(),
        })),
      checks.failed !== undefined
        ? section("Checks", h("p", { className: "muted", text: readFailure(checks.failed, "its checks") }))
        : checksSection(checks.data)
    )
  );
}

function checksSection(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  return section("Checks",
    rows.length
      ? h("table", { className: "issues-table" },
          h("thead", {}, h("tr", {},
            h("th", { className: "log-level-col", text: "Result" }),
            h("th", { text: "When" }),
            h("th", { className: "num", text: "Took" }),
            h("th", { text: "Why" })
          )),
          h("tbody", {}, rows.map((check) =>
            h("tr", {},
              h("td", {}, statusChip(check.isUp)),
              h("td", { attrs: { title: at(check.startCheck) }, text: since(check.startCheck) }),
              h("td", { className: "num", text: responseTime(check.responseTime) }),
              h("td", { text: check.isUp ? "" : checkReason(check.reason) })
            )))
        )
      : h("p", { className: "muted",
          text: "No checks yet. The first one happens on the next interval." })
  );
}

/**
 * One form for making and for editing, because they are the same object and
 * the same replace-everything write.
 *
 * Which fields are shown follows the kind: a heartbeat has nowhere to look, a
 * ping has no status to expect. Showing them all and letting GlitchTip refuse
 * gets you "Invalid Url" with no indication of which field it meant.
 */
function monitorForm({ org, orgs, linkOrg, signal, projects, monitor, onSaved }) {
  const editing = Boolean(monitor);
  const problems = h("ul", { className: "form-problems", hidden: true });

  const name = field({ label: "Name", id: "monitor-name", value: monitor?.name || "" });

  const type = h("select", { id: "monitor-type" },
    MONITOR_TYPES.map((one) => h("option", { value: one.value, text: one.label })));
  type.value = knownType(monitor?.monitorType);
  const typeHint = h("p", { className: "muted" });

  const url = field({ label: "URL", id: "monitor-url", value: monitor?.url || "" });
  const expectedStatus = field({
    label: "Expected status", id: "monitor-status", type: "number",
    value: String(monitor?.expectedStatus ?? 200),
  });
  const expectedBody = field({
    label: "Expected in the body (optional)", id: "monitor-body",
    value: monitor?.expectedBody || "",
  });
  const interval = field({
    label: "Check every (seconds)", id: "monitor-interval", type: "number",
    value: String(monitor?.interval ?? 60),
  });
  const timeout = field({
    label: "Timeout (seconds, optional)", id: "monitor-timeout", type: "number",
    value: monitor?.timeout ? String(monitor.timeout) : "",
  });
  const threshold = field({
    label: "Failures before believing it", id: "monitor-threshold", type: "number",
    value: String(monitor?.confirmationThreshold ?? 1),
  });
  const project = h("select", { id: "monitor-project" },
    h("option", { value: "", text: "No project" }),
    (projects || []).map((one) => h("option", { value: String(one.id), text: one.name || one.slug })));
  project.value = monitor?.projectId ? String(monitor.projectId) : "";

  /** Fields appear and disappear with the kind, rather than being refused. */
  const paintForType = () => {
    const kind = knownType(type.value);
    typeHint.textContent = MONITOR_TYPES.find((one) => one.value === kind)?.hint || "";
    url.node.hidden = !needsUrl(kind);
    url.node.querySelector(".field-label").textContent = urlLabel(kind);
    url.input.setAttribute("placeholder", urlHint(kind));
    expectedStatus.node.hidden = !needsExpectedStatus(kind);
    expectedBody.node.hidden = !needsExpectedBody(kind);
  };
  type.addEventListener("change", paintForType);
  paintForType();

  const submit = h("button", { type: "submit", text: editing ? "Save monitor" : "Create monitor" });

  const form = h("form", {
    on: {
      submit: async (event) => {
        event.preventDefault();
        const payload = monitorPayload({
          name: name.input.value,
          monitorType: type.value,
          url: url.input.value,
          expectedStatus: expectedStatus.input.value,
          expectedBody: expectedBody.input.value,
          interval: interval.input.value,
          timeout: timeout.input.value,
          confirmationThreshold: threshold.input.value,
          project: project.value,
        });

        const missing = whatIsMissing(payload);
        problems.hidden = missing.length === 0;
        fill(problems, missing.map((one) => h("li", { text: one })));
        if (missing.length) return;

        submit.disabled = true;
        try {
          const saved = editing
            ? await glitchtip.put(`${base(org)}/${encodeURIComponent(monitor.id)}/`, payload, { signal })
            : await glitchtip.post(`${base(org)}/`, payload, { signal });
          onSaved(saved);
        } catch (failure) {
          problems.hidden = false;
          fill(problems, h("li", {
            text: failure?.message || `Couldn't save that (${failure?.status ?? 0}).`,
          }));
        } finally {
          submit.disabled = false;
        }
      },
    },
  },
    name.node,
    h("label", { className: "field" }, h("span", { className: "field-label", text: "Kind" }), type),
    typeHint,
    url.node,
    expectedStatus.node,
    expectedBody.node,
    interval.node,
    timeout.node,
    threshold.node,
    h("label", { className: "field" },
      h("span", { className: "field-label", text: "Project (optional)" }), project),
    problems,
    h("div", { className: "form-actions" }, submit)
  );

  return form;
}
