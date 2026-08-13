/**
 * The issue stream, and one issue.
 *
 * Errors live in GlitchTip's database and are read straight from its API —
 * no proxy, no stored credential. That works because Sentinel is served on
 * the same origin, so the browser sends the GlitchTip session it already
 * has, and sees exactly the issues GlitchTip would show it.
 *
 * Laid out like GlitchTip's own issue list on purpose. The point isn't to
 * redesign a screen people already know; it's to stop it being a second
 * application.
 *
 * What changed in moving here: the filters and the page cursor are in the
 * address now. They were module state, so a filtered list couldn't be sent to
 * anyone, page two was gone on reload, and opening an issue and coming back
 * put you at the top of an unfiltered list. GlitchTip's own screens have
 * always been addressable; this one now is too.
 */
import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState } from "../lib/dom.js";
import { since } from "../lib/time.js";
import { parseLinks } from "../lib/pagination.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go, refresh as refreshRoute } from "../lib/router.js";

/** GlitchTip's own sort keys, so the URL means the same thing in both. */
const SORTS = [
  ["-last_seen", "Last Seen"],
  ["-first_seen", "First Seen"],
  ["-count", "Events"],
  ["-priority", "Priority"],
];

const RANGES = [
  ["24h", "24h"],
  ["14d", "14d"],
];

const DEFAULT_QUERY = "is:unresolved";
const DEFAULT_SORT = SORTS[0][0];
const DEFAULT_RANGE = RANGES[0][0];

/**
 * GlitchTip has no cheap "list the environments" endpoint, so they're learned
 * from the issues that come back. Kept across renders because a filtered page
 * only mentions its own environment, and the option to switch back to another
 * one has to survive using it.
 */
const knownEnvironments = new Set();

/**
 * GlitchTip's answer to an unauthenticated read is a 401, and it means
 * something quite different here from everywhere else in the app: not "your
 * Sentinel session has gone" but "this browser has no GlitchTip session."
 * Handing that to the central 401 handler would sign someone out of Sentinel
 * for the crime of opening a tab — so this screen reads the status itself.
 */
const NO_REDIRECT = { signalUnauthorized: false };

// ------------------------------------------------------------- the address

function readFilters(query = {}) {
  return {
    query: query.q ?? DEFAULT_QUERY,
    sort: query.sort || DEFAULT_SORT,
    range: query.range || DEFAULT_RANGE,
    environment: query.env || "",
    cursor: query.cursor || "",
  };
}

/** Only what differs from the default, so a plain list has a plain URL. */
function search(filters, { cursor = filters.cursor } = {}) {
  const params = new URLSearchParams();
  if (filters.query !== DEFAULT_QUERY) params.set("q", filters.query);
  if (filters.sort !== DEFAULT_SORT) params.set("sort", filters.sort);
  if (filters.range !== DEFAULT_RANGE) params.set("range", filters.range);
  if (filters.environment) params.set("env", filters.environment);
  if (cursor) params.set("cursor", cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function apiPath(org, filters) {
  const params = new URLSearchParams();
  params.set("query", filters.query);
  params.set("sort", filters.sort);
  params.set("limit", "50");
  if (filters.range) params.set("start", `now-${filters.range}`);
  if (filters.environment) params.set("environment", filters.environment);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return `/organizations/${encodeURIComponent(org)}/issues/?${params}`;
}

/**
 * The Link header hands back whole URLs. Only the cursor inside one is ours
 * to keep — the rest of that URL is the filters we already have, and storing
 * it whole would let a stale page's filters override the current ones.
 */
function cursorOf(link) {
  if (!link) return null;
  try {
    return new URL(link, location.origin).searchParams.get("cursor");
  } catch {
    return null;
  }
}

/** What went wrong, in terms of what to do about it. */
function readFailure(status) {
  if (status === 401 || status === 403) {
    return "GlitchTip wouldn't answer for this account. Sign in to GlitchTip in this browser.";
  }
  // Served on its own port, /api/0 belongs to the receiver and 404s. Worth
  // saying, because it looks like there are simply no errors.
  if (status === 404) {
    return "Issues need Sentinel served alongside GlitchTip on the same address.";
  }
  if (status === 0) return "Couldn't reach the error tracker.";
  return `The error tracker answered ${status}.`;
}

// ---------------------------------------------------------------- the list

/** A bar per hour, from the counts GlitchTip returns with each issue. */
function trend(stats) {
  const series = stats?.["24h"] || [];
  const wrap = h("div", { className: "trend" });
  if (!series.length) return wrap;

  const peak = Math.max(...series.map((point) => point[1] || 0), 1);
  for (const [, value] of series) {
    wrap.append(
      h("span", {
        className: value ? "" : "empty",
        style: { height: `${Math.max(2, Math.round(((value || 0) / peak) * 22))}px` },
      })
    );
  }
  return wrap;
}

function issueRow(issue, { filters, selected, onPick }) {
  const box = h("input", {
    type: "checkbox",
    checked: selected.has(issue.id),
    attrs: { "aria-label": `Select ${issue.title || issue.id}` },
    on: {
      change: () => {
        if (box.checked) selected.add(issue.id);
        else selected.delete(issue.id);
        onPick();
      },
    },
  });

  const culprit = issue.culprit || issue.metadata?.filename || "";
  const subtitle = [issue.project?.slug, culprit, `${since(issue.lastSeen, { suffix: false })} old`]
    .filter(Boolean)
    .join(" — ");

  return h(
    "tr",
    { className: issue.status === "unresolved" ? "" : "resolved", attrs: { "data-id": issue.id } },
    h("td", {}, box),
    h(
      "td",
      {},
      // A link, not a button: an issue has an address, and the filters travel
      // with it so coming back lands on the list that was actually open.
      h("a", {
        className: "issue-title",
        href: routeHref(`/issues/${encodeURIComponent(issue.id)}${search(filters)}`),
        text: issue.title || issue.metadata?.value || "(no title)",
      }),
      h("div", { className: "issue-sub muted", text: subtitle })
    ),
    h("td", {}, trend(issue.stats)),
    h("td", { className: "issue-count", text: String(issue.count ?? "0") })
  );
}

function toolbar(filters, navigate) {
  const environments = [...new Set([...knownEnvironments, filters.environment])]
    .filter(Boolean)
    .sort();

  const environment = h(
    "select",
    {
      attrs: { "aria-label": "Environment" },
      on: { change: () => navigate({ ...filters, environment: environment.value, cursor: "" }) },
    },
    h("option", { value: "", text: "All environments" }),
    environments.map((name) => h("option", { value: name, text: name }))
  );
  environment.value = filters.environment;

  const query = h("input", {
    type: "search",
    className: "issue-search",
    value: filters.query,
    attrs: { "aria-label": "Search issues", placeholder: DEFAULT_QUERY },
    on: {
      keydown: (event) => {
        // Enter, not every keystroke: each search is a navigation, and one
        // per character would fill the history and steal focus mid-word.
        if (event.key === "Enter") navigate({ ...filters, query: query.value.trim(), cursor: "" });
      },
    },
  });

  const range = h(
    "div",
    { className: "issue-range", attrs: { role: "group", "aria-label": "Time range" } },
    RANGES.map(([value, label]) =>
      h("button", {
        type: "button",
        className: value === filters.range ? "selected" : "",
        text: label,
        attrs: { "data-range": value },
        on: { click: () => navigate({ ...filters, range: value, cursor: "" }) },
      })
    )
  );

  const sort = h(
    "select",
    {
      attrs: { "aria-label": "Sort by" },
      on: { change: () => navigate({ ...filters, sort: sort.value, cursor: "" }) },
    },
    SORTS.map(([value, label]) => h("option", { value, text: label }))
  );
  sort.value = filters.sort;

  return h(
    "div",
    { className: "issues-toolbar" },
    environment,
    query,
    range,
    sort,
    h("button", {
      type: "button",
      className: "ghost",
      text: "Refresh",
      on: { click: () => void refreshRoute() },
    })
  );
}

export async function issuesListView({ outlet, query, signal, onCleanup }, { org } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to browse errors under."));
    return;
  }

  let gone = false;
  // A status change re-renders the screen when it lands. Navigate away while
  // one is in flight and that re-render would hit whatever screen replaced
  // this one, refetching someone else's data under them.
  onCleanup(() => {
    gone = true;
  });

  const filters = readFilters(query);
  const navigate = (next) => go(`/issues${search(next)}`);

  const rows = h("tbody", { attrs: { id: "issue-rows" } });
  const table = h(
    "table",
    { className: "issues-table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { className: "pick" }),
        h("th", { text: "Issue" }),
        h("th", { className: "trend-col", text: "Trend" }),
        h("th", { className: "count-col", text: "Events" })
      )
    ),
    rows
  );

  const failed = (message) => fill(rows, h("tr", {}, h("td", { className: "empty", colSpan: 4, text: message })));

  let response;
  try {
    response = await glitchtip.raw(apiPath(org, filters), { signal, raw: true, ...NO_REDIRECT });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" }, toolbar(filters, navigate), table));
    failed(readFailure(error?.status ?? 0));
    return;
  }
  throwIfAborted(signal);

  let issues = [];
  if (response.ok) {
    issues = await response.json();
    throwIfAborted(signal);
    for (const issue of issues) {
      if (issue.metadata?.environment) knownEnvironments.add(issue.metadata.environment);
    }
  }

  const links = parseLinks(response.headers.get("link"));
  const selected = new Set();

  const selectAll = h("input", {
    type: "checkbox",
    attrs: { "aria-label": "Select all" },
    on: {
      change: () => {
        selected.clear();
        if (selectAll.checked) issues.forEach((issue) => selected.add(issue.id));
        paintRows();
        paintBulk();
      },
    },
  });

  const act = async (status) => {
    if (!selected.size) return;
    const params = new URLSearchParams();
    for (const id of selected) params.append("id", id);
    const path = `/organizations/${encodeURIComponent(org)}/issues/?${params}`;

    try {
      if (status === "delete") await glitchtip.del(path, { signal, ...NO_REDIRECT });
      else await glitchtip.put(path, { status }, { signal, ...NO_REDIRECT });
    } catch (error) {
      failed(
        error?.status === 403
          ? "That was refused. Reload the page and try again — your session may have expired."
          : `Couldn't update those (${error?.status ?? 0}).`
      );
      return;
    }
    if (!gone) void refreshRoute();
  };

  const bulkButtons = [
    ["resolved", "Mark resolved"],
    ["unresolved", "Mark unresolved"],
    ["ignored", "Mark ignored"],
  ].map(([status, label]) =>
    h("button", {
      type: "button",
      text: label,
      disabled: true,
      attrs: { "data-status": status },
      on: { click: () => void act(status) },
    })
  );
  const deleteButton = h("button", {
    type: "button",
    className: "ghost danger",
    text: "Delete",
    disabled: true,
    on: { click: () => void act("delete") },
  });

  const pageLink = (cursor, label, ariaLabel) =>
    h("a", {
      className: `ghost button-link${cursor ? "" : " disabled"}`,
      text: label,
      attrs: {
        "aria-label": ariaLabel,
        "aria-disabled": cursor ? null : "true",
        // Nowhere to go is a link with no href, which is also how a browser
        // and a screen reader are told it isn't clickable.
        href: cursor ? routeHref(`/issues${search(filters, { cursor })}`) : null,
      },
    });

  const paintBulk = () => {
    const any = selected.size > 0;
    for (const button of [...bulkButtons, deleteButton]) button.disabled = !any;
    selectAll.checked = any && selected.size === issues.length;
  };

  const paintRows = () => {
    if (!response.ok) return failed(readFailure(response.status));
    if (!issues.length) {
      return failed("No issues match. Errors appear here as apps report them.");
    }
    fill(
      rows,
      issues.map((issue) => issueRow(issue, { filters, selected, onPick: paintBulk }))
    );
  };

  paintRows();
  paintBulk();

  fill(
    outlet,
    h(
      "div",
      { className: "issues-view" },
      toolbar(filters, navigate),
      h(
      "div",
      { className: "issue-bulk" },
      selectAll,
      bulkButtons,
      deleteButton,
      h("span", { className: "bulk-spacer" }),
      pageLink(cursorOf(links.previous), "‹", "Previous page"),
      pageLink(cursorOf(links.next), "›", "Next page")
      ),
      table
    )
  );
}

// ----------------------------------------------------------- one issue

function detailSection(title, ...children) {
  return h("section", { className: "detail-section" }, h("h3", { text: title }), children);
}

/**
 * The stack, innermost call first — which is the order these arrive in and
 * the opposite of what you want to read, so it's reversed here the way every
 * error tracker does.
 */
function stacktrace(frames) {
  return h(
    "ol",
    { className: "frames" },
    [...frames].reverse().map((frame) => {
      // file:line:column, the form every editor and stack trace already uses.
      const position = [frame.lineNo, frame.colNo].filter((n) => n != null).join(":");
      const where = h(
        "div",
        { className: "frame-where" },
        h("span", { className: "frame-fn", text: frame.function || "?" }),
        h("span", {
          className: "frame-file mono",
          text: [frame.filename || frame.absPath || "?", position].filter(Boolean).join(":"),
        })
      );

      // Source context only exists when the app uploaded source maps; without
      // it a frame is still worth showing, just shorter.
      const context =
        Array.isArray(frame.context) && frame.context.length
          ? h(
              "pre",
              { className: "frame-context mono" },
              frame.context.map(([lineNo, code]) =>
                h("div", {
                  className: lineNo === frame.lineNo ? "current" : "",
                  text: `${String(lineNo).padStart(5)}  ${code}`,
                })
              )
            )
          : null;

      return h("li", {}, where, context);
    })
  );
}

function keyValues(pairs) {
  return h(
    "dl",
    { className: "kv" },
    pairs
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .flatMap(([key, value]) => [
        h("dt", { text: key }),
        h("dd", {
          className: "mono",
          text: typeof value === "object" ? JSON.stringify(value) : String(value),
        }),
      ])
  );
}

function breadcrumbs(values) {
  return h(
    "div",
    { className: "crumbs" },
    values.map((crumb) =>
      h(
        "div",
        { className: "crumb" },
        h("span", {
          className: "t mono",
          text: crumb.timestamp ? new Date(crumb.timestamp).toLocaleTimeString() : "—",
        }),
        h("span", { className: "c", text: crumb.category || crumb.type || "—" }),
        h("span", {
          className: "m",
          text: crumb.message || (crumb.data ? JSON.stringify(crumb.data) : "") || "—",
        })
      )
    )
  );
}

function eventBody(event) {
  const parts = [];

  for (const entry of event.entries || []) {
    if (entry.type === "exception") {
      for (const value of entry.data?.values || []) {
        parts.push(
          detailSection(
            value.type || "Exception",
            h("p", { className: "exception-value", text: value.value || "" }),
            value.stacktrace?.frames?.length ? stacktrace(value.stacktrace.frames) : null
          )
        );
      }
    } else if (entry.type === "breadcrumbs") {
      const values = entry.data?.values || [];
      if (values.length) {
        parts.push(detailSection(`Breadcrumbs (${values.length})`, breadcrumbs(values)));
      }
    } else if (entry.type === "request") {
      const data = entry.data || {};
      parts.push(
        detailSection(
          "Request",
          keyValues([
            ["URL", data.url],
            ["Method", data.method],
            ["Query", data.query],
          ])
        )
      );
    } else if (entry.type === "message") {
      parts.push(
        detailSection(
          "Message",
          h("p", { text: entry.data?.formatted || entry.data?.message || "" })
        )
      );
    }
  }

  if (event.tags?.length) {
    parts.push(detailSection("Tags", keyValues(event.tags.map((tag) => [tag.key, tag.value]))));
  }

  parts.push(
    detailSection(
      "Event",
      keyValues([
        ["Event ID", event.eventID],
        ["Received", event.dateCreated ? new Date(event.dateCreated).toLocaleString() : null],
        ["Platform", event.platform],
        ["SDK", event.sdk ? `${event.sdk.name} ${event.sdk.version || ""}`.trim() : null],
        ["User", event.user ? event.user.email || event.user.username || event.user.id : null],
      ])
    )
  );

  return parts;
}

export async function issueDetailView({ outlet, params, query, signal, onCleanup }, { org } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to browse errors under."));
    return;
  }

  let gone = false;
  onCleanup(() => {
    gone = true;
  });

  const id = params.id;
  // The filters came along in the query, so "all issues" goes back to the
  // list that was open rather than to an unfiltered one.
  const back = h("a", {
    className: "linky",
    href: routeHref(`/issues${search(readFilters(query))}`),
    text: "← All issues",
  });

  const base = `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(id)}`;

  let issue;
  try {
    issue = await glitchtip.get(`${base}/`, { signal, ...NO_REDIRECT });
  } catch (error) {
    throwIfAborted(signal);
    fill(
      outlet,
      h("div", { className: "issues-view" }, back, h("p", { className: "error", text: readFailure(error?.status ?? 0) }))
    );
    return;
  }
  throwIfAborted(signal);

  const status = h("span", { className: "tag", text: issue.status });
  const resolve = h("button", { type: "button" });
  const body = h("div", {}, emptyState("Loading…"));

  const paintStatus = (value) => {
    status.textContent = value;
    // Offer the action that isn't already true.
    resolve.textContent = value === "resolved" ? "Mark unresolved" : "Mark resolved";
    resolve.dataset.next = value === "resolved" ? "unresolved" : "resolved";
  };
  paintStatus(issue.status);

  const setStatus = async (next) => {
    resolve.disabled = true;
    try {
      await glitchtip.put(
        `/organizations/${encodeURIComponent(org)}/issues/?id=${encodeURIComponent(id)}`,
        { status: next },
        { signal, ...NO_REDIRECT }
      );
    } catch (error) {
      resolve.disabled = false;
      fill(body, h("p", { className: "error", text: `Couldn't update that (${error?.status ?? 0}).` }));
      return;
    }
    if (gone) return;
    resolve.disabled = false;
    paintStatus(next);
  };

  resolve.addEventListener("click", () => void setStatus(resolve.dataset.next || "resolved"));
  const ignore = h("button", {
    type: "button",
    className: "ghost",
    text: "Mark ignored",
    on: { click: () => void setStatus("ignored") },
  });

  const count = Number(issue.count ?? 0);
  fill(
    outlet,
    h(
      "div",
      { className: "issues-view" },
      h(
      "section",
      { className: "issue-detail" },
      back,
      h(
        "header",
        { className: "detail-head" },
        h("h2", { text: issue.title || "(no title)" }),
        h("p", { className: "muted", text: issue.culprit || issue.metadata?.filename || "" }),
        h(
          "div",
          { className: "detail-meta" },
          h("span", { className: "tag", text: issue.project?.slug || "" }),
          status,
          h("span", {
            className: "muted",
            text: `${count} event${count === 1 ? "" : "s"} · first seen ${since(issue.firstSeen)} · last ${since(issue.lastSeen)}`,
          })
        ),
        h(
          "div",
          { className: "detail-actions" },
          resolve,
          ignore,
          issue.permalink
            ? h("a", {
                className: "button-link",
                href: issue.permalink,
                target: "_blank",
                attrs: { rel: "noreferrer noopener" },
                text: "Open in GlitchTip ↗",
              })
            : null
        )
      ),
      body
      )
    )
  );

  // Awaited after the header is on screen: the event body is the big fetch,
  // and everything above it is already known.
  let event;
  try {
    event = await glitchtip.raw(`${base}/events/latest/`, { signal, raw: true, ...NO_REDIRECT });
  } catch {
    throwIfAborted(signal);
    fill(body, emptyState("Couldn't load the event body."));
    return;
  }
  throwIfAborted(signal);

  if (!event.ok) {
    fill(body, emptyState("No event body stored for this issue."));
    return;
  }
  const parsed = await event.json();
  throwIfAborted(signal);
  fill(body, eventBody(parsed));
}
