/**
 * Logs: what services said, ranked by how alarmed they were.
 *
 * Phase 8c. Unlike spans, this one answers from Postgres for anything recent
 * — GlitchTip keeps a hot window of logs in the database and only reaches for
 * cold storage beyond it — so the screen works in a default deployment and
 * quietly stops going as far back where cold storage is absent.
 *
 * Two things here are GlitchTip's shape rather than a choice.
 *
 * Levels are a ranked ladder, trace through fatal, so the filter is "this and
 * worse" rather than six independent tick boxes: the question people actually
 * have is "show me the warnings", and the API takes one `level` parameter per
 * level, which lib/logs.js expands.
 *
 * And a log has no separate timestamp column. Its id is a UUIDv7 and the time
 * is decoded from it, which is why the list is ordered by id and why a log's
 * address is that uuid.
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go } from "../lib/router.js";
import { withOrg } from "../lib/org.js";
import { parseLinks, cursorOf } from "../lib/pagination.js";
import { since, at } from "../lib/time.js";
import { LEVELS, readFilters, search, apiSearch, summarise, hasMore } from "../lib/logs.js";

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

const base = (org) => `/organizations/${encodeURIComponent(org)}/logs`;

const RANGES = [
  ["1h", "1h"],
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
];

/** The level, as a chip that is readable before it is read. */
const levelChip = (level) =>
  h("span", { className: `log-level log-${level || "unknown"}`, text: level || "—" });

/**
 * A picker built from what this organisation has actually logged.
 *
 * GlitchTip keeps the distinct service, environment and host names it has
 * seen, so the filters are the real values rather than a free-text box that
 * silently matches nothing on a typo. The current value is kept in the list
 * even when it is no longer among them — otherwise following a link to a
 * service that has gone quiet resets the filter without saying so.
 */
function resourcePicker({ id, label, values, current, onPick }) {
  const options = [...new Set([current, ...values].filter(Boolean))].sort();
  const select = h("select", { id, attrs: { "aria-label": label } },
    h("option", { value: "", text: label }),
    options.map((one) => h("option", { value: one, text: one })));
  select.value = current || "";
  select.addEventListener("change", () => onPick(select.value));
  return select;
}

export async function logsListView({ outlet, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show logs for."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const filters = readFilters(query);
  const navigate = (extra) => go(withOrg(`/logs${search(filters, { cursor: "", ...extra })}`, linkOrg, { orgs }));

  const [response, resources] = await Promise.all([
    glitchtip.raw(`${base(org)}/?${apiSearch(filters)}`, { signal }).catch((error) => ({
      ok: false,
      status: error?.status ?? 0,
      headers: new Headers(),
    })),
    settle(glitchtip.get(`${base(org)}/resources/`, { signal })),
  ]);
  throwIfAborted(signal);

  const logs = response.ok && response.json ? await response.json() : [];
  throwIfAborted(signal);
  const links = parseLinks(response.headers?.get("link"));

  const named = (type) =>
    (Array.isArray(resources.data) ? resources.data : [])
      .filter((one) => one.type === type)
      .map((one) => one.name)
      .filter(Boolean);

  const level = h("select", { id: "log-level", attrs: { "aria-label": "Level" } },
    h("option", { value: "", text: "Any level" }),
    LEVELS.map((one) => h("option", { value: one, text: `${one} and worse` })));
  level.value = filters.minLevel;
  level.addEventListener("change", () => navigate({ minLevel: level.value }));

  const find = h("input", {
    id: "log-query",
    type: "search",
    value: filters.query,
    attrs: { placeholder: "Message contains…", "aria-label": "Search log messages" },
  });

  const pageLink = (cursor, label, ariaLabel) =>
    h("a", {
      className: `ghost button-link${cursor ? "" : " disabled"}`,
      text: label,
      attrs: {
        "aria-label": ariaLabel,
        "aria-disabled": cursor ? null : "true",
        href: cursor ? routeHref(withOrg(`/logs${search(filters, { cursor })}`, linkOrg, { orgs })) : null,
      },
    });

  const rows = logs.map((log) =>
    h("tr", {},
      h("td", {}, levelChip(log.level)),
      h("td", {},
        h("a", {
          className: "issue-title log-body",
          href: routeHref(withOrg(`/logs/${encodeURIComponent(log.id)}`, linkOrg, { orgs })),
          text: summarise(log.body),
        }),
        hasMore(log.body) ? h("div", { className: "issue-sub muted", text: "more…" }) : null
      ),
      h("td", { text: log.service || "—" }),
      h("td", { text: log.environment || "—" }),
      h("td", { attrs: { title: at(log.timestamp) }, text: since(log.timestamp) })
    )
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("header", { className: "detail-head" }, h("h2", { text: "Logs" })),
      /**
       * A trace is a different question from a filter — "the rest of this
       * request" rather than "narrow what I am looking at" — so it is shown
       * as a state the screen is in, with the way out beside it, instead of
       * as one more control in the row below.
       */
      filters.trace
        ? h("p", { className: "log-trace" },
            h("span", { className: "muted", text: "Everything under trace " }),
            h("code", { className: "mono", text: filters.trace }),
            h("button", {
              type: "button", className: "ghost", text: "Show all logs",
              on: { click: () => navigate({ trace: "" }) },
            }))
        : null,
      h("div", { className: "perf-toolbar" },
        h("form", {
          className: "perf-find",
          on: {
            submit: (event) => {
              event.preventDefault();
              navigate({ query: find.value.trim() });
            },
          },
        }, find),
        level,
        resourcePicker({
          id: "log-service", label: "Any service", values: named("service"),
          current: filters.service, onPick: (value) => navigate({ service: value }),
        }),
        resourcePicker({
          id: "log-environment", label: "Any environment", values: named("environment"),
          current: filters.environment, onPick: (value) => navigate({ environment: value }),
        }),
        h("div", { className: "perf-ranges" },
          RANGES.map(([value, label]) =>
            h("button", {
              type: "button",
              className: `ghost${value === filters.range ? " current" : ""}`,
              text: label,
              on: { click: () => navigate({ range: value }) },
            })))
      ),
      !response.ok
        ? h("p", { className: "error", text: readFailure(response.status, "logs") })
        : rows.length
          ? h("table", { className: "issues-table" },
              h("thead", {}, h("tr", {},
                h("th", { className: "log-level-col", text: "Level" }),
                h("th", { text: "Message" }),
                h("th", { text: "Service" }),
                h("th", { text: "Environment" }),
                h("th", { text: "When" })
              )),
              h("tbody", {}, rows)
            )
          : emptyState(
              "No logs in this window. They arrive over OpenTelemetry — an SDK " +
              "sending only errors produces none."
            ),
      h("div", { className: "issue-bulk" },
        h("span", { className: "bulk-spacer" }),
        pageLink(cursorOf(links.previous), "‹", "Previous page"),
        pageLink(cursorOf(links.next), "›", "Next page"))
    )
  );
}

/**
 * One log line, whole.
 *
 * The body is put in a <pre> rather than a paragraph: a log line is very
 * often a stack trace or a formatted block, and reflowing it destroys the one
 * thing that made it readable.
 */
export async function logDetailView({ outlet, params, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this log under."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/logs", linkOrg, { orgs })),
    text: "← All logs",
  });

  let log;
  try {
    log = await glitchtip.get(`${base(org)}/${encodeURIComponent(params.id)}/`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "this log") })));
    return;
  }
  throwIfAborted(signal);

  const attributes = Object.entries(log.data || {});

  fill(
    outlet,
    h("div", { className: "issues-view" },
      back,
      h("header", { className: "detail-head" },
        h("h2", { text: "Log" }),
        levelChip(log.level)),
      h("pre", { className: "mono log-full", text: log.body || "(empty)" }),
      h("dl", { className: "release-facts" },
        h("dt", { text: "When" }), h("dd", { text: at(log.timestamp) }),
        h("dt", { text: "Service" }), h("dd", { text: log.service || "—" }),
        h("dt", { text: "Environment" }), h("dd", { text: log.environment || "—" }),
        h("dt", { text: "Host" }), h("dd", { text: log.host || "—" }),
        h("dt", { text: "Severity" }),
        h("dd", { text: log.severityNumber === null || log.severityNumber === undefined
          ? "—" : String(log.severityNumber) })
      ),
      /**
       * A trace id is the one field on this screen that leads somewhere: it
       * is what ties this line to the rest of a request. There is no trace
       * screen yet, so it is shown as a filter back into this list rather
       * than as a link to nothing.
       */
      log.traceID
        ? section("Trace",
            h("p", { className: "muted", text: "Everything logged under the same trace." }),
            h("a", {
              className: "linky mono",
              href: routeHref(withOrg(`/logs?trace=${encodeURIComponent(log.traceID)}`, linkOrg, { orgs })),
              text: log.traceID,
            }),
            log.spanID ? h("p", { className: "muted mono", text: `span ${log.spanID}` }) : null)
        : null,
      attributes.length
        ? section("Attributes",
            h("table", { className: "issues-table" },
              h("thead", {}, h("tr", {}, h("th", { text: "Name" }), h("th", { text: "Value" }))),
              h("tbody", {}, attributes.map(([key, value]) =>
                h("tr", {},
                  h("td", { className: "mono", text: key }),
                  h("td", { className: "mono span-description",
                    text: typeof value === "string" ? value : JSON.stringify(value) }))))))
        : section("Attributes",
            h("p", { className: "muted", text: "None. Attributes are whatever the SDK attached." }))
    )
  );
}
