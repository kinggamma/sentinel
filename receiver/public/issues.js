/**
 * The issue stream.
 *
 * Errors live in GlitchTip's database and are read straight from its API —
 * no proxy, no stored credential. That works because Sentinel is served on
 * the same origin, so the browser sends the GlitchTip session it already
 * has, and sees exactly the issues GlitchTip would show it.
 *
 * Laid out like GlitchTip's own issue list on purpose. The point isn't to
 * redesign a screen people already know; it's to stop it being a second
 * application.
 */

const el = (id) => document.getElementById(id);

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

let org = null;
let cursorLinks = { previous: null, next: null };
let currentUrl = null;
let issues = [];
const selected = new Set();

/** How long ago, in the shape GlitchTip uses ("20 hours old"). */
function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const steps = [
    [60, 1, "second"],
    [3600, 60, "minute"],
    [86400, 3600, "hour"],
    [2592000, 86400, "day"],
    [31536000, 2592000, "month"],
  ];
  for (const [limit, divisor, unit] of steps) {
    if (seconds < limit) {
      const value = Math.max(1, Math.floor(seconds / divisor));
      return `${value} ${unit}${value === 1 ? "" : "s"}`;
    }
  }
  return `${Math.floor(seconds / 31536000)} years`;
}

/**
 * GlitchTip paginates with a Link header rather than a page number, so the
 * only way forward or back is to keep the URLs it hands out.
 */
function parseLinks(header) {
  const links = { previous: null, next: null };
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"(?:;\s*results="([^"]+)")?/);
    if (!match) continue;
    const [, url, rel, results] = match;
    // results="false" means the link exists but leads nowhere; treating it
    // as a page would show an empty list and look like data loss.
    links[rel] = results === "false" ? null : url;
  }
  return links;
}


/**
 * Django protects session-authenticated writes with CSRF, and a token-based
 * call is exempt — so reads work and the first write fails with a 403 that
 * says nothing about why. The token is in a cookie that is deliberately
 * readable; echoing it back is the whole protocol.
 */
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function issuesUrl() {
  const params = new URLSearchParams();
  params.set("query", el("issue-search").value.trim());
  params.set("sort", el("issue-sort").value);
  params.set("limit", "50");

  const range = document.querySelector(".issue-range .selected")?.dataset.range;
  if (range) params.set("start", `now-${range}`);

  const environment = el("issue-env").value;
  if (environment) params.set("environment", environment);

  return `/api/0/organizations/${encodeURIComponent(org)}/issues/?${params}`;
}

async function load(url) {
  const rows = el("issue-rows");
  rows.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
  selected.clear();
  el("issue-all").checked = false;

  let res;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch {
    return showIssueError("Couldn't reach the error tracker.");
  }

  if (res.status === 401 || res.status === 403) {
    return showIssueError(
      "GlitchTip wouldn't answer for this account. Sign in to GlitchTip in this browser."
    );
  }
  if (!res.ok) {
    // Served on its own port, /api/0 belongs to the receiver and 404s. Worth
    // saying, because it looks like there are simply no errors.
    return showIssueError(
      res.status === 404
        ? "Issues need Sentinel served alongside GlitchTip on the same address."
        : `The error tracker answered ${res.status}.`
    );
  }

  currentUrl = url;
  cursorLinks = parseLinks(res.headers.get("link"));
  issues = await res.json();
  renderIssues();
}

function showIssueError(message) {
  el("issue-rows").innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 4;
  td.className = "empty";
  td.textContent = message;
  tr.appendChild(td);
  el("issue-rows").appendChild(tr);
  paintPager();
}

/** A bar per hour, from the counts GlitchTip returns with each issue. */
function trend(stats) {
  const series = stats?.["24h"] || [];
  const wrap = document.createElement("div");
  wrap.className = "trend";
  if (!series.length) return wrap;

  const peak = Math.max(...series.map((point) => point[1] || 0), 1);
  for (const [, value] of series) {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(2, Math.round(((value || 0) / peak) * 22))}px`;
    if (!value) bar.classList.add("empty");
    wrap.appendChild(bar);
  }
  return wrap;
}

function renderIssues() {
  const rows = el("issue-rows");
  rows.innerHTML = "";

  if (!issues.length) {
    return showIssueError("No issues match. Errors appear here as apps report them.");
  }

  for (const issue of issues) {
    const tr = document.createElement("tr");
    tr.dataset.id = issue.id;
    if (issue.status !== "unresolved") tr.classList.add("resolved");

    const pick = document.createElement("td");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selected.has(issue.id);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(issue.id);
      else selected.delete(issue.id);
      paintBulk();
    });
    pick.appendChild(box);

    const main = document.createElement("td");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "issue-title";
    title.textContent = issue.title || issue.metadata?.value || "(no title)";
    // Until the detail screen exists, GlitchTip's own page is the answer —
    // better than a dead link on every row.
    title.addEventListener("click", () => window.open(issue.permalink, "_blank", "noopener"));

    const sub = document.createElement("div");
    sub.className = "issue-sub muted";
    const culprit = issue.culprit || issue.metadata?.filename || "";
    sub.textContent = [issue.project?.slug, culprit, `${ago(issue.lastSeen)} old`]
      .filter(Boolean)
      .join(" — ");

    main.append(title, sub);

    const trendCell = document.createElement("td");
    trendCell.appendChild(trend(issue.stats));

    const events = document.createElement("td");
    events.className = "issue-count";
    events.textContent = issue.count ?? "0";

    tr.append(pick, main, trendCell, events);
    rows.appendChild(tr);
  }

  paintBulk();
  paintPager();
}

function paintBulk() {
  const any = selected.size > 0;
  for (const button of document.querySelectorAll(".issue-bulk [data-status], .issue-bulk .danger")) {
    button.disabled = !any;
  }
  el("issue-all").checked = any && selected.size === issues.length;
}

function paintPager() {
  el("issue-prev").disabled = !cursorLinks.previous;
  el("issue-next").disabled = !cursorLinks.next;
}

/**
 * Status changes go through GlitchTip, by id, so the answer is the same one
 * its own UI would give and nothing here has to track state.
 */
async function updateSelected(status) {
  if (!selected.size) return;
  const params = new URLSearchParams();
  for (const id of selected) params.append("id", id);

  const res = await fetch(
    `/api/0/organizations/${encodeURIComponent(org)}/issues/?${params}`,
    {
      method: status === "delete" ? "DELETE" : "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrftoken": csrfToken(),
      },
      body: status === "delete" ? undefined : JSON.stringify({ status }),
    }
  );

  if (!res.ok) {
    return showIssueError(
      res.status === 403
        ? "That was refused. Reload the page and try again — your session may have expired."
        : `Couldn't update those (${res.status}).`
    );
  }
  await load(currentUrl);
}

/** Environments come from the issues themselves; GlitchTip has no cheap list. */
function paintEnvironments() {
  const select = el("issue-env");
  const seen = new Set([...select.options].map((o) => o.value));
  for (const issue of issues) {
    const environment = issue.metadata?.environment;
    if (environment && !seen.has(environment)) {
      seen.add(environment);
      const option = document.createElement("option");
      option.value = environment;
      option.textContent = environment;
      select.appendChild(option);
    }
  }
}

export function initIssues({ organisation }) {
  org = organisation;

  const sort = el("issue-sort");
  if (!sort.options.length) {
    for (const [value, label] of SORTS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.appendChild(option);
    }
  }

  const range = document.querySelector(".issue-range");
  if (!range.children.length) {
    RANGES.forEach(([value, label], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.range = value;
      button.textContent = label;
      if (index === 0) button.classList.add("selected");
      button.addEventListener("click", () => {
        range.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
        button.classList.add("selected");
        void load(issuesUrl());
      });
      range.appendChild(button);
    });
  }

  sort.onchange = () => void load(issuesUrl());
  el("issue-env").onchange = () => void load(issuesUrl());
  el("issue-search").onkeydown = (event) => {
    if (event.key === "Enter") void load(issuesUrl());
  };
  el("issue-refresh").onclick = () => void load(issuesUrl());

  el("issue-all").onchange = (event) => {
    selected.clear();
    if (event.target.checked) issues.forEach((issue) => selected.add(issue.id));
    renderIssues();
  };

  for (const button of document.querySelectorAll(".issue-bulk [data-status]")) {
    button.onclick = () => void updateSelected(button.dataset.status);
  }
  el("issue-delete").onclick = () => void updateSelected("delete");

  el("issue-prev").onclick = () => cursorLinks.previous && load(cursorLinks.previous);
  el("issue-next").onclick = () => cursorLinks.next && load(cursorLinks.next);
}

export async function showIssues() {
  await load(issuesUrl());
  paintEnvironments();
}
