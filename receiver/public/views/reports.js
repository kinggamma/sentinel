/**
 * One app's bug reports: the list, and whichever one is open.
 *
 * Both are in the URL — /reports/:app and /reports/:app/:id — so a report
 * can be linked to, which is the whole point of somebody filing one. It used
 * to be a mode of a single address, reachable only by clicking.
 *
 * Selecting a report re-mounts this view, which re-fetches the list. That is
 * one small request for a list of a few dozen rows, and it buys an address
 * that always describes what is on screen. A cache here would have to know
 * when a report was deleted, when retention swept, and when another tab
 * filed one.
 */
import { sentinel } from "../lib/api.js";
import { h, fill, emptyState } from "../lib/dom.js";
import { at, breadcrumbTime } from "../lib/time.js";
import { throwIfAborted } from "../lib/abort.js";
import { go, href as routeHref } from "../lib/router.js";

/** What visual evidence a report carries — replay now, screenshots on older ones. */
function evidenceLabel(report) {
  if (report.hasReplay) {
    const meta = report.replayMeta || {};
    if (meta.startedAt && meta.endedAt) {
      return `${Math.round((meta.endedAt - meta.startedAt) / 1000)}s replay`;
    }
    return "replay";
  }
  const shots = (report.screenshots || []).length;
  if (shots) return `${shots} shot${shots > 1 ? "s" : ""}`;
  return "no replay";
}

function matches(report, { q, source }) {
  if (source && report.source !== source) return false;
  if (!q) return true;
  return [report.note, report.url, report.reporterEmail, report.appName, report.id]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(q));
}

/**
 * Frames are oldest-first and the last one is the moment the report was
 * filed, so they're labelled by how far back they look.
 */
function frameLabel(index, total, timestamp, filedAt) {
  const position = index === total - 1 ? "latest" : `frame ${index + 1}`;
  if (!timestamp || !filedAt) return position;
  const secondsBack = Math.round((filedAt - timestamp) / 1000);
  if (secondsBack <= 0) return `${position} · at report`;
  return `${position} · −${secondsBack}s`;
}

/**
 * Full-screen screenshot viewer. Built here and appended to the body rather
 * than living in the shell's markup, so it belongs to the screen that opens
 * it and goes away with it.
 */
function lightbox(frames) {
  let index = 0;
  let node = null;

  const paint = () => {
    const frame = frames[index];
    if (!frame || !node) return;
    node.querySelector("img").src = frame.url;
    node.querySelector(".lightbox-caption").textContent =
      `${frame.label} — ${index + 1} of ${frames.length}`;
  };

  const step = (delta) => {
    const next = index + delta;
    if (next < 0 || next >= frames.length) return;
    index = next;
    paint();
  };

  const close = () => {
    node?.remove();
    node = null;
  };

  const onKey = (event) => {
    if (!node) return;
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  };
  document.addEventListener("keydown", onKey);

  const open = (at_) => {
    if (!frames[at_]) return;
    index = at_;
    node = h(
      "div",
      { className: "lightbox", on: { click: (event) => event.target === node && close() } },
      h("button", {
        className: "lightbox-close",
        type: "button",
        text: "✕",
        attrs: { "aria-label": "Close" },
        on: { click: close },
      }),
      h("button", {
        className: "lightbox-nav prev",
        type: "button",
        text: "‹",
        attrs: { "aria-label": "Previous frame" },
        on: { click: () => step(-1) },
      }),
      h("img", { alt: "" }),
      h("button", {
        className: "lightbox-nav next",
        type: "button",
        text: "›",
        attrs: { "aria-label": "Next frame" },
        on: { click: () => step(1) },
      }),
      h("p", { className: "lightbox-caption" })
    );
    document.body.append(node);
    paint();
  };

  return { open, cleanup: () => (close(), document.removeEventListener("keydown", onKey)) };
}

// ------------------------------------------------------------- one report

function detailRows(report) {
  const rows = h("dl", { className: "kv" });
  const add = (label, value) => rows.append(h("dt", { text: label }), value);

  add("App", h("dd", { text: report.appName }));
  add(
    "Source",
    h("dd", { text: report.source === "auto-error" ? "Auto-captured error" : "Staff report" })
  );
  add("Reported by", h("dd", { text: report.reporterEmail || "—" }));
  add(
    "Page",
    report.url
      ? h(
          "dd",
          {},
          h("a", {
            href: report.url,
            text: report.url,
            target: "_blank",
            attrs: { rel: "noreferrer noopener" },
          })
        )
      : h("dd", { text: "—" })
  );
  add("When", h("dd", { text: at(report.createdAt) }));
  add(
    "GlitchTip",
    report.glitchtipUrl
      ? h(
          "dd",
          {},
          // With an event id this lands on the error itself; without one, on
          // the project's issue stream, still the right next place to look.
          h("a", {
            href: report.glitchtipUrl,
            target: "_blank",
            attrs: { rel: "noreferrer noopener" },
            text: report.glitchtipEventId
              ? `${report.glitchtipEventId} ↗`
              : "Open this app's errors ↗",
          })
        )
      : h("dd", { text: report.glitchtipEventId || "— (staff reports aren't sent to GlitchTip)" })
  );

  return rows;
}

async function renderReplay(report, into, signal, { onPlayer }) {
  if (!report.hasReplay) return;

  into.append(h("h3", { text: "Session replay" }));

  const meta = report.replayMeta || {};
  if (meta.startedAt && meta.endedAt) {
    const seconds = Math.round((meta.endedAt - meta.startedAt) / 1000);
    into.append(
      h("p", {
        className: "muted",
        style: { margin: "0 0 10px" },
        text: `${seconds}s leading up to the report · ${meta.eventCount ?? "?"} events`,
      })
    );
  }

  const mount = h("div", { className: "replay" });
  into.append(mount);

  try {
    const events = await sentinel.get(`/reports/${encodeURIComponent(report.id)}/replay`, { signal });
    if (!Array.isArray(events) || events.length < 2) throw new Error("replay too short to play");

    // Resolved at runtime rather than written as a literal, and that is
    // deliberate: a literal specifier is something a bundler follows, and
    // following this one would pull half a megabyte of replay player into
    // the main bundle for every screen that never opens a replay. An
    // expression is left alone, and document.baseURI is the same <base> the
    // rest of the page's assets resolve against, so it lands on the right
    // root under /sentinel and standalone alike.
    const playerUrl = new URL("vendor/rrweb-player.js", document.baseURI).href;
    const { default: Player } = await import(playerUrl);
    throwIfAborted(signal);

    // The player is sized once, from a number, and never resizes itself — so
    // that number has to be the width this really ends up. Read straight
    // after the detail is built it isn't: on a cold load of a report's own
    // URL the grid column hasn't settled and it measured a third of the
    // width, which is exactly the case a linkable report creates. One frame
    // is enough for layout to be final.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    throwIfAborted(signal);
    const width = mount.clientWidth || 720;
    // Handed straight up rather than dropped on the floor. It's a Svelte
    // component with its own timers, rAF loop and iframe, and removing the
    // element it rendered into doesn't stop any of them — a replay left
    // playing kept ticking behind whatever screen came next.
    onPlayer(
      new Player({
        target: mount,
        props: {
          events,
          width,
          height: Math.round(width * 0.56),
          autoPlay: false,
          showController: true,
          // The recording is masked, but don't let a replayed page make
          // network requests of its own.
          UNSAFE_replayCanvas: false,
        },
      })
    );
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    fill(mount, h("p", { className: "empty", text: `Could not load replay: ${error.message}` }));
  }
}

function renderScreenshots(report, into, { onFrames, openFrame, track, signal }) {
  const files = report.screenshots || [];
  // Replay supersedes screenshots; only older reports have both or neither.
  if (!files.length && report.hasReplay) return;

  into.append(h("h3", { text: `Screenshots (${files.length})` }));
  if (!files.length) {
    into.append(emptyState("No screenshots or replay in this report."));
    return;
  }

  const wrap = h("div", { className: "shots" });
  into.append(wrap);

  const frames = [];
  const stamps = report.screenshotTimestamps || [];
  const filedAt = new Date(report.createdAt).getTime();

  files.forEach((filename, index) => {
    const img = h("img", { alt: `Frame ${index + 1}` });
    const label = h("div", {
      className: "shot-label",
      text: frameLabel(index, files.length, stamps[index], filedAt),
    });
    wrap.append(
      h("button", { type: "button", on: { click: () => openFrame(index) } }, img, label)
    );

    // These are the one set of requests that outlive the render that starts
    // them: a screenshot is a few hundred kilobytes and nobody awaits it. On
    // the signal, so a navigation cancels them — and checked again on the
    // way out, because a response already in flight when the signal fires
    // still arrives, and would mint an object URL nothing is left to revoke.
    sentinel
      .raw(`/reports/${encodeURIComponent(report.id)}/screenshots/${encodeURIComponent(filename)}`, {
        signal,
      })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (signal?.aborted) return;
        const url = URL.createObjectURL(blob);
        track(url);
        frames[index] = { url, label: label.textContent };
        img.src = url;
      })
      .catch((error) => {
        if (error?.name === "AbortError" || signal?.aborted) return;
        label.textContent = `frame ${index + 1} — failed to load`;
      });
  });

  onFrames(frames);
}

function renderBreadcrumbs(report, into) {
  const crumbs = report.breadcrumbs || [];
  into.append(h("h3", { text: `Breadcrumbs (${crumbs.length})` }));

  if (!crumbs.length) {
    into.append(emptyState("No breadcrumbs recorded."));
    return;
  }

  const box = h("div", { className: "crumbs" });
  for (const crumb of crumbs) {
    box.append(
      h(
        "div",
        { className: "crumb" },
        h("span", { className: "t mono", text: breadcrumbTime(crumb.timestamp) }),
        h("span", { className: "c", text: crumb.category || crumb.type || "—" }),
        h("span", {
          className: "m",
          text: crumb.message || (crumb.data ? JSON.stringify(crumb.data) : "") || "—",
        })
      )
    );
  }
  into.append(box);
}

/** Two clicks, because a report is the only copy of what someone saw. */
function renderDangerZone(report, into, { onDeleted, track }) {
  const button = h("button", {
    type: "button",
    className: "ghost danger",
    text: "Delete this report",
  });

  let confirming = false;
  let timer = null;
  button.addEventListener("click", async () => {
    if (!confirming) {
      confirming = true;
      button.textContent = "Really delete? Click again";
      clearTimeout(timer);
      timer = setTimeout(() => {
        confirming = false;
        button.textContent = "Delete this report";
      }, 4000);
      track(timer);
      return;
    }

    button.disabled = true;
    try {
      await sentinel.del(`/reports/${encodeURIComponent(report.id)}`);
    } catch (error) {
      button.disabled = false;
      button.textContent = `Delete failed (${error.message})`;
      return;
    }
    onDeleted(report);
  });

  into.append(h("div", { className: "danger-zone" }, button));
}

// ------------------------------------------------------------- the screen

/**
 * @param {object} deps
 * @param {(appName: string) => number} deps.hueFor - app.js's appHue, so a
 *   report's chip matches its card on the landing screen.
 * @param {() => void} [deps.onChanged] - something was deleted; the landing
 *   counts and the app's own state are stale.
 * @param {string} [deps.lockedTo] - the one app a scoped or embedded session
 *   may see. Set, this view will not send anyone to a different app's report
 *   however the address asks it to.
 */
export async function reportsView(
  { outlet, params, signal, onCleanup },
  { hueFor, onChanged, lockedTo } = {}
) {
  const appName = params.app || "";
  const openId = params.id || null;

  const objectUrls = [];
  const timers = [];
  let frames = { open: () => {}, cleanup: () => {} };
  let player = null;

  // Registered before the first fetch, not returned after the last one.
  // Everything below this line allocates something — object URLs, a keydown
  // listener, a replay player — and any of the awaits between here and the
  // end can throw, most often an AbortError from the navigation that
  // superseded this render. A returned cleanup is only reached when nothing
  // goes wrong, which is the case that didn't need it.
  onCleanup(() => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    timers.forEach((timer) => clearTimeout(timer));
    frames.cleanup();
    player?.$destroy?.();
  });

  let all;
  try {
    all = await sentinel.get("/reports", { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("p", { className: "error", text: error.message || "Could not load reports." }));
    return;
  }
  throwIfAborted(signal);

  const mine = (all || []).filter((report) => !appName || report.appName === appName);

  /**
   * The id is the authoritative half of this address; the app segment is
   * derivable from it, so the two can disagree — a hand-edited URL, a link
   * kept from before an app was renamed. Nothing about the screen noticed:
   * the breadcrumb, the title and the search placeholder all named the app
   * in the URL while the detail showed a report from somewhere else, and the
   * list had nothing highlighted because the report isn't in it.
   *
   * Answer to the id, and correct the address to match it. Replace rather
   * than push, so Back still goes where the reader came from rather than to
   * the wrong URL they just left.
   */
  const reconcile = (actualApp) => {
    if (!actualApp || !appName || actualApp === appName) return false;
    if (lockedTo) {
      // Scoped to one app by its host. Sending them to another app's report
      // is the one thing this session is not allowed to do.
      fill(
        detail,
        emptyState(`That report belongs to ${actualApp}, and this view only shows ${appName}.`)
      );
      return true;
    }
    void go(`/reports/${encodeURIComponent(actualApp)}/${encodeURIComponent(openId)}`, {
      replace: true,
    });
    return true;
  };

  // Filters live on the screen they filter, the way the issue list's do.
  const search = h("input", {
    type: "search",
    className: "reports-search",
    value: "",
    attrs: {
      placeholder: appName ? `Search ${appName} reports…` : "Search note, URL, reporter…",
      "aria-label": "Search reports",
    },
  });
  const source = h(
    "select",
    { attrs: { "aria-label": "Source" } },
    h("option", { value: "", text: "All sources" }),
    h("option", { value: "staff-report", text: "Staff reports" }),
    h("option", { value: "auto-error", text: "Auto-captured" })
  );

  const list = h("ul", { className: "list", attrs: { "aria-label": "Reports" } });
  const detail = h("section", { className: "detail" }, emptyState("Select a report."));

  const paintList = () => {
    const filters = { q: search.value.trim().toLowerCase(), source: source.value };
    const rows = mine.filter((report) => matches(report, filters));

    if (!rows.length) {
      fill(list, h("li", { className: "empty", text: mine.length ? "Nothing matches those filters." : "No reports yet." }));
      return;
    }

    fill(
      list,
      rows.map((report) =>
        h(
          "li",
          {},
          h(
            "a",
            {
              // A link, not a button: a report has an address now, so
              // middle-click and "copy link" do what they look like they do.
              href: routeHref(`/reports/${encodeURIComponent(appName)}/${encodeURIComponent(report.id)}`),
              className: "row",
              attrs: report.id === openId ? { "aria-current": "true" } : {},
            },
            h(
              "div",
              { className: "row-top" },
              h("span", { className: "row-note", text: report.note || "(no note)" }),
              h("span", {
                className: report.source === "auto-error" ? "tag auto" : "tag",
                text: report.source === "auto-error" ? "auto" : "staff",
              })
            ),
            h(
              "div",
              { className: "row-meta" },
              h("span", { text: at(report.createdAt) }),
              h("span", { text: evidenceLabel(report) })
            )
          )
        )
      )
    );
  };

  search.addEventListener("input", paintList);
  source.addEventListener("change", paintList);
  paintList();

  fill(
    outlet,
    h("div", { className: "reports-toolbar" }, search, source),
    h("div", { className: "layout" }, list, detail)
  );

  if (!openId) return;

  // ------------------------------------------------------------- detail
  // The list already knows which app this report belongs to, so a mismatch
  // is caught before spending a request on it.
  if (reconcile((all || []).find((report) => report.id === openId)?.appName)) return;

  fill(detail, emptyState("Loading…"));

  let report;
  try {
    report = await sentinel.get(`/reports/${encodeURIComponent(openId)}`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(detail, h("p", { className: "error", text: `Could not load report (${error.message}).` }));
    return;
  }
  throwIfAborted(signal);

  // Checked again against the report itself: the list is what this account
  // can see, and an id it didn't contain still resolves here.
  if (reconcile(report.appName)) return;

  const chip = h("span", { className: "tag project", text: report.appName });
  if (hueFor) chip.style.setProperty("--project-hue", String(hueFor(report.appName)));

  // The replay loads a player bundle, so it arrives after everything below
  // it. Its place in the page is claimed now, or it would appear under the
  // delete button rather than at the top where it belongs.
  const replaySlot = h("div", { className: "replay-slot" });

  fill(
    detail,
    h("h2", { text: report.note || "(no note)" }),
    h("p", { className: "detail-sub" }, chip, h("span", { className: "muted mono", text: report.id })),
    detailRows(report),
    replaySlot
  );

  renderScreenshots(report, detail, {
    onFrames: (list_) => (frames = { ...lightbox(list_), list: list_ }),
    openFrame: (index) => frames.open(index),
    track: (url) => objectUrls.push(url),
    signal,
  });
  renderBreadcrumbs(report, detail);
  renderDangerZone(report, detail, {
    track: (timer) => timers.push(timer),
    onDeleted: () => {
      onChanged?.();
      // Back to the list, which is now one shorter and re-fetched.
      void go(`/reports/${encodeURIComponent(appName)}`);
    },
  });

  // Awaited last so a navigation during the bundle load can cancel it, but
  // painted into the slot above.
  await renderReplay(report, replaySlot, signal, { onPlayer: (instance) => (player = instance) });
}
