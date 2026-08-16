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
import { since, at } from "../lib/time.js";
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

/**
 * What went wrong, in terms of what to do about it.
 *
 * 404 means two entirely different things depending on who asked, and the
 * list's answer was being given to both. On the list it is almost always the
 * deployment: served on its own port, /api/0 belongs to the receiver and
 * 404s, which otherwise looks like an installation with no errors in it. On
 * one issue it is almost always that issue — deleted, merged away, or in a
 * project this account can't see — and telling someone to check how Sentinel
 * is deployed sends them a very long way from the truth.
 */
function readFailure(status, { subject = "list" } = {}) {
  if (status === 401 || status === 403) {
    return "GlitchTip wouldn't answer for this account. Sign in to GlitchTip in this browser.";
  }
  if (status === 404) {
    return subject === "issue"
      ? "That issue doesn't exist any more, or this account can't see it."
      : "Issues need Sentinel served alongside GlitchTip on the same address.";
  }
  if (status === 0) return "Couldn't reach the error tracker.";
  return `The error tracker answered ${status}.`;
}

/**
 * An action nobody awaits — a click handler's promise. A cancelled one is
 * not a failure and must not surface as an unhandled rejection, which is the
 * only reason this isn't a bare `void`.
 */
function run(promise) {
  promise.catch((error) => {
    if (error?.name !== "AbortError") console.error("issue action failed", error);
  });
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

  /**
   * What can be typed into the box.
   *
   * The search accepts a small query language and nothing on the screen said
   * so, which makes it look like a plain text filter that mysteriously
   * ignores what you type. These are GlitchTip's own terms.
   */
  const help = h(
    "details",
    { className: "search-help" },
    h("summary", { text: "Search help" }),
    h(
      "dl",
      {},
      [
        ["is:unresolved", "still open — the default"],
        ["is:resolved", "dealt with"],
        ["is:ignored", "deliberately set aside"],
        ["age:-24h", "first seen in the last day"],
        ["timesSeen:>10", "happened more than ten times"],
        ["project:my-app", "one project"],
        ["anything else", "matched against the title and culprit"],
      ].flatMap(([term, means]) => [
        h("dt", { className: "mono", text: term }),
        h("dd", { className: "muted", text: means }),
      ])
    )
  );

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
    help,
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

/**
 * No onCleanup here, and nothing to return: this screen holds no timer, no
 * listener on document and no object URL. What it does hold is requests, and
 * the router aborts their signal on teardown — so the signal already answers
 * "has this screen gone", and a second flag tracking the same fact could
 * only ever drift from it.
 */
export async function issuesListView({ outlet, query, signal }, { org } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to browse errors under."));
    return;
  }

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
      // First, because a navigation cancels this the same way it cancels a
      // read — and reporting "couldn't update those (0)" into a screen that
      // has already been replaced is a failure invented by leaving.
      throwIfAborted(signal);
      failed(
        error?.status === 403
          ? "That was refused. Reload the page and try again — your session may have expired."
          : `Couldn't update those (${error?.status ?? 0}).`
      );
      return;
    }
    throwIfAborted(signal);
    void refreshRoute();
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
      on: { click: () => run(act(status)) },
    })
  );
  const deleteButton = h("button", {
    type: "button",
    className: "ghost danger",
    text: "Delete",
    disabled: true,
    on: { click: () => run(act("delete")) },
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

// -------------------------------------------------- what else is known

/**
 * Which tag values this issue has been seen with.
 *
 * GlitchTip already computes it — top values per key, with counts — and it
 * is the fastest way to tell "everybody" from "one browser on one machine",
 * which is usually the first thing worth knowing about an error.
 */
function tagsSection(tags) {
  if (!tags?.length) return null;

  return detailSection(
    "Tags across all events",
    h(
      "div",
      { className: "tag-groups" },
      tags.map((tag) =>
        h(
          "div",
          { className: "tag-group" },
          h("h4", { text: tag.name || tag.key }),
          h(
            "ul",
            {},
            (tag.topValues || []).map((value) => {
              const share = tag.totalValues
                ? Math.round((value.count / tag.totalValues) * 100)
                : null;
              return h(
                "li",
                {},
                h("span", { className: "tag-value", text: value.value ?? value.name }),
                h("span", {
                  className: "muted",
                  text: share === null ? String(value.count) : `${share}% · ${value.count}`,
                })
              );
            })
          )
        )
      )
    )
  );
}

/**
 * What somebody typed into a crash dialog, if an app collects them.
 *
 * Rarely present, and worth a lot when it is — this is a person describing
 * what they were doing, next to the stack trace of it going wrong.
 */
function userReportsSection(reports) {
  if (!reports?.length) return null;

  return detailSection(
    `What people said (${reports.length})`,
    h(
      "div",
      { className: "user-reports" },
      reports.map((report) =>
        h(
          "article",
          {},
          h("p", { className: "report-comment", text: report.comments || "(no comment)" }),
          h("p", {
            className: "muted",
            text: [report.name, report.email, report.dateCreated ? at(report.dateCreated) : null]
              .filter(Boolean)
              .join(" · "),
          })
        )
      )
    )
  );
}

/**
 * Notes people leave each other on an issue.
 *
 * The one genuinely collaborative thing on this screen, and the only part of
 * it that writes: everything else here reports what happened, while this is
 * two people working out what to do about it.
 */
function commentsSection({ comments, onAdd, onDelete, me }) {
  const list = h("div", { className: "comments" });
  const error = h("p", { className: "error" });
  error.hidden = true;

  const paint = (items) => {
    if (!items.length) {
      fill(list, emptyState("No notes yet."));
      return;
    }
    fill(
      list,
      items.map((comment) =>
        h(
          "article",
          { className: "comment" },
          h("p", { text: comment.data?.text || "" }),
          h(
            "p",
            { className: "muted" },
            h("span", {
              text: [comment.user?.email, comment.dateCreated ? at(comment.dateCreated) : null]
                .filter(Boolean)
                .join(" · "),
            }),
            // Only your own: GlitchTip decides this too, but offering a
            // button that always fails is its own kind of rude.
            me && comment.user?.email === me
              ? h("button", {
                  type: "button",
                  className: "linky danger",
                  text: "Delete",
                  on: { click: () => run(remove(comment.id)) },
                })
              : null
          )
        )
      )
    );
  };

  const remove = async (commentId) => {
    error.hidden = true;
    try {
      paint(await onDelete(commentId));
    } catch (failure) {
      error.hidden = false;
      error.textContent = `Couldn't delete that note (${failure?.status ?? 0}).`;
    }
  };

  const text = h("textarea", {
    attrs: { rows: "2", placeholder: "Leave a note for whoever looks next", "aria-label": "New note" },
  });
  const submit = h("button", { type: "button", text: "Add note" });

  submit.addEventListener("click", () =>
    run(
      (async () => {
        const value = text.value.trim();
        if (!value) return;
        submit.disabled = true;
        error.hidden = true;
        try {
          paint(await onAdd(value));
          text.value = "";
        } catch (failure) {
          error.hidden = false;
          error.textContent = `Couldn't add that note (${failure?.status ?? 0}).`;
        } finally {
          submit.disabled = false;
        }
      })()
    )
  );

  paint(comments);
  return detailSection(
    "Notes",
    list,
    h("div", { className: "comment-form" }, text, submit),
    error
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
    // Named against the aggregate below it, which carries the same word and
    // a different meaning: these are what *this* event was tagged with,
    // those are how the whole issue is distributed across values.
    parts.push(
      detailSection("Tags on this event", keyValues(event.tags.map((tag) => [tag.key, tag.value])))
    );
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

/** Same as the list above: the signal is the only teardown state it needs. */
export async function issueDetailView({ outlet, params, query, signal }, { org, me = null } = {}) {
  /**
   * Which event of this issue to show. An issue is a group of them, and the
   * newest is only the default — walking back through them is how you find
   * the first, or the one from the person who complained.
   *
   * In the query rather than the path, because it is a position within the
   * issue rather than a different thing: /issues/4?event=<id> is still
   * issue 4.
   */
  const eventId = query?.event || "latest";
  if (!org) {
    fill(outlet, emptyState("No organisation to browse errors under."));
    return;
  }

  const issueId = params.id;
  const id = issueId;
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
      h("div", { className: "issues-view" }, back, h("p", { className: "error", text: readFailure(error?.status ?? 0, { subject: "issue" }) }))
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
      throwIfAborted(signal);
      resolve.disabled = false;
      fill(body, h("p", { className: "error", text: `Couldn't update that (${error?.status ?? 0}).` }));
      return;
    }
    throwIfAborted(signal);
    resolve.disabled = false;
    paintStatus(next);
  };

  resolve.addEventListener("click", () => run(setStatus(resolve.dataset.next || "resolved")));
  const ignore = h("button", {
    type: "button",
    className: "ghost",
    text: "Mark ignored",
    on: { click: () => run(setStatus("ignored")) },
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
    event = await glitchtip.raw(`${base}/events/${encodeURIComponent(eventId)}/`, {
      signal,
      raw: true,
      ...NO_REDIRECT,
    });
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

  /**
   * Everything else this issue knows, fetched together and after the body,
   * because none of it is why somebody opened the screen. A failure in any
   * one of them leaves that section out rather than taking the page with
   * it — a missing note list is not a reason to hide a stack trace.
   */
  const filters = search(readFilters(query));
  const eventHref = (id) =>
    routeHref(
      `/issues/${encodeURIComponent(issueId)}${filters ? `${filters}&` : "?"}event=${encodeURIComponent(id)}`
    );

  const [tags, reports, comments] = await Promise.all([
    glitchtip.get(`${base}/tags/`, { signal, ...NO_REDIRECT }).catch(() => null),
    glitchtip.get(`${base}/user-reports/`, { signal, ...NO_REDIRECT }).catch(() => null),
    glitchtip.get(`${base}/comments/`, { signal, ...NO_REDIRECT }).catch(() => null),
  ]);
  throwIfAborted(signal);

  fill(
    body,
    /**
     * Which of this issue's events you are looking at, and how to move.
     *
     * GlitchTip puts previousEventID and nextEventID in the event itself, so
     * this costs nothing extra — and without it the screen quietly implies
     * an issue is one error rather than a group of them.
     */
    parsed.previousEventID || parsed.nextEventID
      ? h(
          "div",
          { className: "event-nav" },
          parsed.previousEventID
            ? h("a", { className: "button-link", href: eventHref(parsed.previousEventID), text: "← Earlier" })
            : h("span", { className: "button-link disabled", attrs: { "aria-disabled": "true" }, text: "← Earlier" }),
          h("span", {
            className: "muted",
            text: parsed.dateCreated ? `This one: ${at(parsed.dateCreated)}` : "",
          }),
          parsed.nextEventID
            ? h("a", { className: "button-link", href: eventHref(parsed.nextEventID), text: "Later →" })
            : h("span", { className: "button-link disabled", attrs: { "aria-disabled": "true" }, text: "Later →" })
        )
      : null,

    eventBody(parsed),
    tagsSection(tags),
    userReportsSection(reports),

    comments
      ? commentsSection({
          comments,
          me,
          onAdd: async (text) => {
            await glitchtip.post(`${base}/comments/`, { data: { text } }, { signal, ...NO_REDIRECT });
            return glitchtip.get(`${base}/comments/`, { signal, ...NO_REDIRECT });
          },
          onDelete: async (commentId) => {
            await glitchtip.del(`${base}/comments/${encodeURIComponent(commentId)}/`, {
              signal,
              ...NO_REDIRECT,
            });
            return glitchtip.get(`${base}/comments/`, { signal, ...NO_REDIRECT });
          },
        })
      : null
  );
}
