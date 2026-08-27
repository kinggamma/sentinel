/**
 * Performance: which transactions are slow, what they spend their time on,
 * and where the same query is being run in a loop.
 *
 * Phase 8b. The transaction list and one transaction's own numbers come from
 * Postgres and are always answerable. Everything below span level does not:
 * spans, the org-wide span groups, the N+1 patterns and the trend series are
 * all read from GlitchTip's cold storage, and when that is not configured —
 * as it is not in a default deployment — every one of those endpoints returns
 * an empty list rather than an error.
 *
 * That is the thing this screen has to handle honestly. An empty list means
 * either "nothing happened" or "this installation cannot answer", and the
 * response is identical in both cases, so nothing here can tell them apart.
 * The empty states therefore say both, rather than picking the flattering one
 * and leaving somebody to wonder why a busy service reports no spans.
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go } from "../lib/router.js";
import { withOrg } from "../lib/org.js";
import { parseLinks, cursorOf } from "../lib/pagination.js";
import { since, at } from "../lib/time.js";
import {
  duration,
  throughput,
  errorRate,
  count,
  readFilters,
  search,
  apiSearch,
  windowQuery,
  SORTS,
  RANGES,
} from "../lib/performance.js";

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

/**
 * Said wherever cold storage is what would have answered.
 *
 * One sentence, in the place the missing thing would have been, rather than a
 * banner at the top of the screen: the transaction list beside it is real, and
 * a warning over the whole page would put the wrong doubt on all of it.
 */
const coldStorage = (subject) =>
  `${subject} comes from GlitchTip's cold storage. Where that isn't configured ` +
  "this stays empty however much traffic there is.";

const base = (org) => `/organizations/${encodeURIComponent(org)}`;

/** The three org-wide performance screens, as one set of tabs. */
function tabs(current, { linkOrg, orgs }) {
  const entries = [
    ["", "Transactions"],
    ["/spans", "Spans"],
    ["/n-plus-one", "Repeated queries"],
  ];
  return h("nav", { className: "sub-tabs", attrs: { "aria-label": "Performance" } },
    entries.map(([suffix, label]) =>
      h("a", {
        className: `sub-tab${suffix === current ? " current" : ""}`,
        href: routeHref(withOrg(`/performance${suffix}`, linkOrg, { orgs })),
        text: label,
        attrs: { "aria-current": suffix === current ? "page" : null },
      }))
  );
}

/** A range picker, shared by the three screens that take one. */
function rangePicker(filters, navigate) {
  return h("div", { className: "perf-ranges" },
    RANGES.map((range) =>
      h("button", {
        type: "button",
        className: `ghost${range.value === filters.range ? " current" : ""}`,
        text: range.label,
        on: { click: () => navigate({ ...filters, range: range.value, cursor: "" }) },
      }))
  );
}

export async function performanceListView({ outlet, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show performance for."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const filters = readFilters(query);
  const navigate = (next) => go(withOrg(`/performance${search(next)}`, linkOrg, { orgs }));

  let response;
  try {
    response = await glitchtip.raw(`${base(org)}/transaction-groups/?${apiSearch(filters)}`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" },
      tabs("", { linkOrg, orgs }),
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "performance") })));
    return;
  }
  throwIfAborted(signal);

  const groups = response.ok ? await response.json() : [];
  throwIfAborted(signal);
  const links = parseLinks(response.headers.get("link"));

  const sort = h("select", { id: "perf-sort", attrs: { "aria-label": "Sort" } },
    SORTS.map((one) => h("option", { value: one.value, text: one.label })));
  sort.value = filters.sort;
  sort.addEventListener("change", () => navigate({ ...filters, sort: sort.value, cursor: "" }));

  const find = h("input", {
    id: "perf-query",
    type: "search",
    value: filters.query,
    attrs: { placeholder: "Transaction contains…", "aria-label": "Filter transactions" },
  });
  const form = h("form", {
    className: "perf-find",
    on: {
      submit: (event) => {
        event.preventDefault();
        navigate({ ...filters, query: find.value.trim(), cursor: "" });
      },
    },
  }, find);

  const pageLink = (cursor, label, ariaLabel) =>
    h("a", {
      className: `ghost button-link${cursor ? "" : " disabled"}`,
      text: label,
      attrs: {
        "aria-label": ariaLabel,
        "aria-disabled": cursor ? null : "true",
        href: cursor
          ? routeHref(withOrg(`/performance${search({ ...filters, cursor })}`, linkOrg, { orgs }))
          : null,
      },
    });

  const rows = groups.map((group) =>
    h("tr", {},
      h("td", {},
        h("a", {
          className: "issue-title",
          href: routeHref(withOrg(`/performance/${group.id}`, linkOrg, { orgs })),
          text: group.transaction || "(unnamed)",
        }),
        h("div", { className: "issue-sub muted",
          text: [group.method, group.op].filter(Boolean).join(" · ") || "—" })
      ),
      h("td", { className: "num", text: duration(group.avgDuration) }),
      h("td", { className: "num", text: duration(group.p95) }),
      h("td", { className: "num", text: count(group.count ?? 0) }),
      h("td", { className: "num", text: errorRate(group.errorRate) }),
      h("td", { text: since(group.lastSeen) })
    )
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      tabs("", { linkOrg, orgs }),
      h("div", { className: "perf-toolbar" }, form, sort, rangePicker(filters, navigate)),
      !response.ok
        ? h("p", { className: "error", text: readFailure(response.status, "performance") })
        : rows.length
          ? h("table", { className: "issues-table" },
              h("thead", {}, h("tr", {},
                h("th", { text: "Transaction" }),
                h("th", { className: "num", text: "Average" }),
                h("th", { className: "num", text: "p95" }),
                h("th", { className: "num", text: "Count" }),
                h("th", { className: "num", text: "Errors" }),
                h("th", { text: "Last seen" })
              )),
              h("tbody", {}, rows)
            )
          : emptyState(
              "No transactions in this window. They arrive from SDKs with tracing " +
              "switched on — an SDK sending only errors produces none."
            ),
      h("div", { className: "issue-bulk" },
        h("span", { className: "bulk-spacer" }),
        pageLink(cursorOf(links.previous), "‹", "Previous page"),
        pageLink(cursorOf(links.next), "›", "Next page"))
    )
  );
}

export async function performanceDetailView({ outlet, params, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this transaction under."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const filters = readFilters(query);
  const id = params.id;
  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/performance", linkOrg, { orgs })),
    text: "← All transactions",
  });

  /**
   * Existence comes from the group itself, which 404s for an id that is not
   * there. Its spans and its trend answer 200 with an empty list for exactly
   * the same id, so asking either of those first would render a complete,
   * entirely empty screen for a typo.
   */
  let group;
  try {
    group = await glitchtip.get(`${base(org)}/transaction-groups/${encodeURIComponent(id)}/`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" }, back,
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "this transaction") })));
    return;
  }
  throwIfAborted(signal);

  const window_ = windowQuery(filters);
  const [spans, trend] = await Promise.all([
    settle(glitchtip.get(`${base(org)}/transaction-groups/${encodeURIComponent(id)}/spans/${window_}`, { signal })),
    settle(glitchtip.get(`${base(org)}/transaction-groups/${encodeURIComponent(id)}/trend/${window_}`, { signal })),
  ]);
  throwIfAborted(signal);

  const navigate = (next) =>
    go(withOrg(`/performance/${encodeURIComponent(id)}${search(next)}`, linkOrg, { orgs }));

  fill(
    outlet,
    h("div", { className: "issues-view" },
      back,
      h("header", { className: "detail-head" },
        h("h2", { text: group.transaction || "(unnamed)" })),
      h("p", { className: "muted",
        text: [group.method, group.op].filter(Boolean).join(" · ") || "no operation recorded" }),
      h("dl", { className: "release-facts" },
        h("dt", { text: "Average" }), h("dd", { text: duration(group.avgDuration) }),
        h("dt", { text: "p50" }), h("dd", { text: duration(group.p50) }),
        h("dt", { text: "p95" }), h("dd", { text: duration(group.p95) }),
        h("dt", { text: "Count" }), h("dd", { text: count(group.count ?? 0) }),
        h("dt", { text: "Errors" }),
        h("dd", { text: `${count(group.errorCount ?? 0)} (${errorRate(group.errorRate)})` }),
        h("dt", { text: "Throughput" }), h("dd", { text: throughput(group.throughput) }),
        h("dt", { text: "First seen" }), h("dd", { text: at(group.firstSeen) }),
        h("dt", { text: "Last seen" }), h("dd", { text: at(group.lastSeen) })
      ),
      h("div", { className: "perf-toolbar" }, rangePicker(filters, navigate)),
      trend.failed !== undefined
        ? section("Over time", h("p", { className: "muted", text: readFailure(trend.failed, "the trend") }))
        : trendSection(trend.data),
      spans.failed !== undefined
        ? section("Spans", h("p", { className: "muted", text: readFailure(spans.failed, "spans") }))
        : spansSection(spans.data)
    )
  );
}

/**
 * The trend, as a row of bars.
 *
 * Deliberately not a chart library: the question is "is this getting slower",
 * which a shape answers, and the numbers are already in the table above.
 * Reusing the sparkline the issue list already draws keeps one visual idiom
 * across the app rather than introducing a second.
 */
function trendSection(points) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length) {
    return section("Over time",
      h("p", { className: "muted", text: coldStorage("A trend over time") }));
  }

  const peak = Math.max(...rows.map((one) => Number(one.avgDuration) || 0), 1);
  return section("Over time",
    h("div", { className: "spark perf-trend" },
      rows.map((point) =>
        h("span", {
          className: "spark-bar",
          style: { height: `${Math.max(2, ((Number(point.avgDuration) || 0) / peak) * 100)}%` },
          attrs: {
            title: `${at(point.date)} — ${duration(point.avgDuration)} over ${point.count ?? 0}`,
          },
        }))),
    h("p", { className: "muted",
      text: `Average duration, ${rows.length} point${rows.length === 1 ? "" : "s"}, ` +
        `peaking at ${duration(peak)}.` })
  );
}

function spanTable(rows, { withTransaction = false } = {}) {
  return h("table", { className: "issues-table" },
    h("thead", {}, h("tr", {},
      withTransaction ? h("th", { text: "Transaction" }) : null,
      h("th", { text: "Operation" }),
      h("th", { text: "Description" }),
      h("th", { className: "num", text: "Count" }),
      h("th", { className: "num", text: "Average" }),
      h("th", { className: "num", text: "p95" }),
      h("th", { className: "num", text: "Total" })
    )),
    h("tbody", {}, rows.map((span) =>
      h("tr", {},
        withTransaction ? h("td", { text: span.transactionName || "—" }) : null,
        h("td", { text: span.op || "—" }),
        h("td", { className: "span-description", text: span.description || "—" }),
        h("td", { className: "num", text: count(span.count ?? span.totalSpans ?? 0) }),
        h("td", { className: "num", text: duration(span.avgDuration) }),
        h("td", { className: "num", text: duration(span.p95Duration) }),
        h("td", { className: "num", text: duration(span.totalTime) })
      )))
  );
}

function spansSection(spans) {
  const rows = Array.isArray(spans) ? spans : [];
  return section("Spans",
    rows.length
      ? spanTable(rows)
      : h("p", { className: "muted", text: coldStorage("What a transaction spends its time on") })
  );
}

/** Every span in the organisation, grouped, rather than one transaction's. */
export async function spanGroupsView({ outlet, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show spans for."));
    return;
  }
  const linkOrg = orgs.length > 1 ? org : null;
  const filters = readFilters(query);
  const navigate = (next) => go(withOrg(`/performance/spans${search(next)}`, linkOrg, { orgs }));
  const window_ = windowQuery(filters);

  const spans = await settle(glitchtip.get(`${base(org)}/span-groups/${window_}`, { signal }));
  throwIfAborted(signal);
  const rows = Array.isArray(spans.data) ? spans.data : [];

  fill(outlet,
    h("div", { className: "issues-view" },
      tabs("/spans", { linkOrg, orgs }),
      h("div", { className: "perf-toolbar" }, rangePicker(filters, navigate)),
      spans.failed !== undefined
        ? h("p", { className: "error", text: readFailure(spans.failed, "spans") })
        : rows.length
          ? spanTable(rows)
          : h("p", { className: "muted", text: coldStorage("Span-level detail") })
    )
  );
}

/**
 * The same query, run once per row of a result set.
 *
 * GlitchTip calls the threshold "spans per transaction" and defaults it to
 * five, which is its judgement rather than ours, so it is left alone: a
 * screen that quietly used a different number would disagree with the same
 * page in GlitchTip for no reason anybody could see.
 */
export async function nPlusOneView({ outlet, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to look at."));
    return;
  }
  const linkOrg = orgs.length > 1 ? org : null;
  const filters = readFilters(query);
  const navigate = (next) => go(withOrg(`/performance/n-plus-one${search(next)}`, linkOrg, { orgs }));
  const window_ = windowQuery(filters);

  const patterns = await settle(glitchtip.get(`${base(org)}/n-plus-one/${window_}`, { signal }));
  throwIfAborted(signal);
  const rows = Array.isArray(patterns.data) ? patterns.data : [];

  fill(outlet,
    h("div", { className: "issues-view" },
      tabs("/n-plus-one", { linkOrg, orgs }),
      h("p", { className: "muted",
        text: "The same operation repeated within one transaction — five times or more, " +
          "which is GlitchTip's own threshold." }),
      h("div", { className: "perf-toolbar" }, rangePicker(filters, navigate)),
      patterns.failed !== undefined
        ? h("p", { className: "error", text: readFailure(patterns.failed, "repeated queries") })
        : rows.length
          ? h("table", { className: "issues-table" },
              h("thead", {}, h("tr", {},
                h("th", { text: "Transaction" }),
                h("th", { text: "Operation" }),
                h("th", { text: "Description" }),
                h("th", { className: "num", text: "Per call" }),
                h("th", { className: "num", text: "Calls" }),
                h("th", { className: "num", text: "Average" }),
                h("th", { className: "num", text: "Total" })
              )),
              h("tbody", {}, rows.map((one) =>
                h("tr", {},
                  h("td", { text: one.transactionName || "—" }),
                  h("td", { text: one.op || "—" }),
                  h("td", { className: "span-description", text: one.description || "—" }),
                  h("td", { className: "num", text: (Number(one.spansPerTxn) || 0).toFixed(1) }),
                  h("td", { className: "num", text: count(one.transactionCount ?? 0) }),
                  h("td", { className: "num", text: duration(one.avgDuration) }),
                  h("td", { className: "num", text: duration(one.totalTime) })
                )))
            )
          : h("p", { className: "muted", text: coldStorage("Repeated-query detection") })
    )
  );
}
