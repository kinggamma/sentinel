/**
 * The app picker — one card per app that has ever reported, each showing
 * its report counts, its DSN if Sentinel provisioned it, and where it's
 * allowed to run.
 *
 * The home screen, so it owns "/". It renders into the router's outlet and
 * fetches its own data on every mount, same as any other view — opening an
 * app is now a navigation to /reports/:app rather than a mode change, so
 * nothing here hides anything.
 */
import { sentinel } from "../lib/api.js";
import { h, fill, emptyState } from "../lib/dom.js";
import { since } from "../lib/time.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref } from "../lib/router.js";

/** Twelve hues chosen to stay tellable apart at chip size, in both themes. */
const PROJECT_HUES = [210, 340, 150, 35, 275, 190, 15, 120, 300, 60, 240, 95];

function projectCard(project, hue, onOpenReports) {
  const stats = h("dl", { className: "card-stats" });
  for (const [label, value] of [
    ["Reports", project.total],
    ["Staff", project.staffReports],
    ["Auto", project.autoErrors],
    ["Replays", project.withReplay],
  ]) {
    stats.append(h("dt", { text: label }), h("dd", { text: String(value ?? 0) }));
  }

  const actions = h("div", { className: "card-actions" });

  const open = h("button", {
    type: "button",
    text: "Open reports",
    on: { click: () => onOpenReports(project.appName) },
  });
  actions.append(open);

  if (project.glitchtipUrl) {
    actions.append(
      h("a", {
        className: "button-link",
        href: project.glitchtipUrl,
        target: "_blank",
        attrs: { rel: "noreferrer noopener" },
        text: "GlitchTip ↗",
        // The whole card is clickable; the link is the one thing that isn't.
        on: { click: (event) => event.stopPropagation() },
      })
    );
  }

  // Shown only for projects Sentinel created, which is exactly when the app
  // still needs its DSN pasting into a config somewhere.
  let dsnTimer = null;
  if (project.dsn) {
    const dsn = h("button", {
      type: "button",
      className: "ghost dsn",
      text: "Copy DSN",
      attrs: { title: project.dsn },
      on: {
        click: async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(project.dsn);
            dsn.textContent = "Copied";
          } catch {
            // Clipboard blocked (insecure origin, denied permission) — show
            // it instead so it can be selected by hand.
            dsn.textContent = project.dsn;
          }
          clearTimeout(dsnTimer);
          dsnTimer = setTimeout(() => (dsn.textContent = "Copy DSN"), 2500);
        },
      },
    });
    actions.append(dsn);
  }

  // Where this app runs. Kept on the card because that's where you are when
  // you notice an app has moved, or that a new one can't report yet.
  actions.append(
    h("a", {
      href: routeHref(`/settings/apps/${encodeURIComponent(project.appName)}`),
      className: "button-link",
      text: project.origins?.length
        ? `Runs at ${project.origins.length === 1 ? project.origins[0] : `${project.origins.length} addresses`}`
        : "Set where it runs",
    })
  );

  const article = h(
    "article",
    {
      className: "project-card",
      style: { "--project-hue": String(hue) },
      on: {
        click: (event) => {
          if (event.target.closest("a")) return;
          onOpenReports(project.appName);
        },
      },
    },
    h("h2", { text: project.appName }),
    stats,
    h("p", { className: "card-foot muted", text: `Last report ${since(project.lastReportAt)}` }),
    actions
  );

  return { node: article, cleanup: () => clearTimeout(dsnTimer) };
}

/**
 * @param {object} deps
 * @param {(appName: string) => void} deps.onOpenReports - navigates to that
 *   app's reports. A function rather than an href because the card itself is
 *   clickable, not just the link inside it.
 * @param {(appName: string) => number} [deps.hueFor] - app.js's own
 *   appHue(), keyed off every app that has ever reported or been
 *   provisioned — not just the ones with a project record. Without it, an
 *   app that has reports but no project would get a different colour here
 *   than it does on that report's own project chip. Falls back to a
 *   projects-only version so this view still works on its own.
 */
export async function projectsView(
  { outlet, signal },
  { onOpenReports, hueFor, org = null, orgs = [] }
) {
  let body;
  try {
    body = await sentinel.get("/projects", { signal });
  } catch (err) {
    throwIfAborted(signal);
    fill(outlet, h("p", { className: "error", text: err.message || "Could not load projects." }));
    return;
  }
  throwIfAborted(signal);

  const all = body.projects || [];

  /**
   * One organisation at a time, once there is more than one.
   *
   * The sidebar names an organisation and everything else on screen obeys
   * it, so a grid quietly showing every app you can reach anywhere
   * contradicts the thing above it — you switch organisation, the issue list
   * changes, and these cards do not. Apps that report to no project yet
   * belong to no organisation, so they stay: hiding them would make an app
   * unreachable at the exact moment somebody is setting it up, which is when
   * this screen matters most.
   *
   * With one organisation nothing is filtered and nothing is said, because
   * there is no other scope for this to be mistaken for.
   */
  const scoped = orgs.length > 1 && org;
  const projects = scoped ? all.filter((p) => !p.org || p.org === org) : all;
  const elsewhere = all.length - projects.length;

  if (!projects.length) {
    fill(
      outlet,
      emptyState(
        elsewhere
          ? `No app in ${org} has reported yet. ${elsewhere} ${
              elsewhere === 1 ? "app reports" : "apps report"
            } to your other organisations.`
          : "No app has reported yet."
      )
    );
    return;
  }

  if (!hueFor) {
    const appNames = [...projects.map((p) => p.appName)].sort();
    hueFor = (name) => PROJECT_HUES[Math.max(0, appNames.indexOf(name)) % PROJECT_HUES.length];
  }

  const cards = projects.map((project) => projectCard(project, hueFor(project.appName), onOpenReports));
  // The grid lives on a wrapper this view owns, not on the outlet: every
  // screen renders into that same outlet, and a layout class left on it
  // would apply to whichever one came next.
  fill(
    outlet,
    h("div", { className: "projects" }, cards.map((c) => c.node)),
    // Said, rather than left to be inferred from a grid that is quietly
    // shorter than it was. Somebody who cannot find an app they know exists
    // needs to be told where it went, not left to wonder.
    elsewhere
      ? h("p", {
          className: "muted",
          text: `${elsewhere} more ${
            elsewhere === 1 ? "app reports" : "apps report"
          } to your other organisations. Switch organisation to see ${
            elsewhere === 1 ? "it" : "them"
          }.`,
        })
      : null
  );

  return () => cards.forEach((c) => c.cleanup());
}
