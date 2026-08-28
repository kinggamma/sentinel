/**
 * Releases: the list, and one release's own screen.
 *
 * Phase 8a, and the first of the remaining verticals. A release is the label
 * a build puts on the errors it produces — every event carries one — so this
 * screen answers "what did we ship, when, and what went into it" for the
 * organisation rather than for one project.
 *
 * Three things about GlitchTip's release API shape this screen.
 *
 * A release belongs to the organisation and lists the projects it touched,
 * so there is no per-project releases screen here even though the API offers
 * one. Two projects releasing the same version are one release with two
 * projects, and splitting the screen by project would show it twice.
 *
 * Its update is a replace, not a patch: the schema defaults `dateReleased` to
 * now and the handler writes back every field, so saving a `ref` with the
 * date left out silently marks the release as shipped this second. The form
 * is prefilled and always sends both (lib/releases.js).
 *
 * And every role can do all of it, delete included — project:releases sits in
 * the member scope set, and the endpoints ask for nothing more. The delete
 * button is gated on canManageReleases rather than on canRead so that the
 * day GlitchTip tightens that scope, one answer changes and the screen
 * follows.
 */

import { glitchtip } from "../lib/api.js";
import { h, fill, emptyState, field, confirmAction } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { href as routeHref, go, refresh as refreshRoute } from "../lib/router.js";
import { withOrg } from "../lib/org.js";
import { parseLinks, cursorOf } from "../lib/pagination.js";
import { since, at } from "../lib/time.js";
import {
  releaseUpdate,
  toLocalInput,
  fromLocalInput,
  fileSize,
  commitSubject,
  shortVersion,
} from "../lib/releases.js";

/** GlitchTip answers a scope failure the same way it answers a bad URL. */
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
 * A section that could not be read says so in place.
 *
 * Every sub-resource here is a separate request, and one of them failing is
 * not the page failing. A release with unreadable files is still a release
 * whose commits and deploys are worth showing.
 */
function unavailable(title, status, subject) {
  return section(title, h("p", { className: "muted", text: readFailure(status, subject) }));
}

const base = (org) => `/organizations/${encodeURIComponent(org)}/releases`;

/**
 * Versions go in the path, and people put all sorts of things in a version.
 * encodeURIComponent is not optional here: an unencoded slash in "v1.2/rc1"
 * would address a sub-resource that does not exist.
 */
const versionPath = (org, version) => `${base(org)}/${encodeURIComponent(version)}/`;

export async function releasesListView({ outlet, query, signal }, { org, orgs = [] } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show releases for."));
    return;
  }

  const linkOrg = orgs.length > 1 ? org : null;
  const params = new URLSearchParams();
  if (query?.cursor) params.set("cursor", query.cursor);
  const search = params.toString();

  let response;
  try {
    response = await glitchtip.raw(`${base(org)}/${search ? `?${search}` : ""}`, { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" },
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "releases") })));
    return;
  }
  throwIfAborted(signal);

  if (!response.ok) {
    fill(outlet, h("div", { className: "issues-view" },
      h("p", { className: "error", text: readFailure(response.status, "releases") })));
    return;
  }

  const releases = await response.json();
  throwIfAborted(signal);
  const links = parseLinks(response.headers.get("link"));

  const pageLink = (cursor, label, ariaLabel) =>
    h("a", {
      className: `ghost button-link${cursor ? "" : " disabled"}`,
      text: label,
      attrs: {
        "aria-label": ariaLabel,
        "aria-disabled": cursor ? null : "true",
        href: cursor
          ? routeHref(withOrg(`/releases?cursor=${encodeURIComponent(cursor)}`, linkOrg, { orgs }))
          : null,
      },
    });

  const rows = (releases || []).map((release) =>
    h("tr", {},
      h("td", {},
        h("a", {
          className: "issue-title mono release-version",
          href: routeHref(
            withOrg(`/releases/${encodeURIComponent(release.version)}`, linkOrg, { orgs })
          ),
          text: shortVersion(release.version),
        }),
        release.ref ? h("div", { className: "issue-sub muted", text: release.ref }) : null
      ),
      h("td", { text: (release.projects || []).map((one) => one.name || one.slug).join(", ") || "—" }),
      // Created is when GlitchTip first saw the version; released is when
      // somebody said it shipped. They are rarely the same and the difference
      // is the whole point of the column.
      h("td", { text: since(release.dateCreated) }),
      h("td", { text: release.dateReleased ? since(release.dateReleased) : "not marked" }),
      h("td", { className: "num", text: String(release.commitCount ?? 0) }),
      h("td", { className: "num", text: String(release.deployCount ?? 0) })
    )
  );

  fill(
    outlet,
    h("div", { className: "issues-view" },
      h("header", { className: "detail-head" }, h("h2", { text: "Releases" })),
      rows.length
        ? h("table", { className: "issues-table" },
            h("thead", {}, h("tr", {},
              h("th", { text: "Version" }),
              h("th", { text: "Projects" }),
              h("th", { text: "First seen" }),
              h("th", { text: "Released" }),
              h("th", { className: "num", text: "Commits" }),
              h("th", { className: "num", text: "Deploys" })
            )),
            h("tbody", {}, rows)
          )
        : emptyState(
            "No releases yet. An SDK sends one by setting `release` on its " +
            "config, or a build does with sentry-cli."
          ),
      h("div", { className: "issue-bulk" },
        h("span", { className: "bulk-spacer" }),
        pageLink(cursorOf(links.previous), "‹", "Previous page"),
        pageLink(cursorOf(links.next), "›", "Next page"))
    )
  );
}

export async function releaseDetailView({ outlet, params, signal }, { org, orgs = [], me } = {}) {
  if (!org) {
    fill(outlet, emptyState("No organisation to show this release under."));
    return;
  }

  const version = params.version;
  const can = me?.orgRoles?.[org] || {};
  const linkOrg = orgs.length > 1 ? org : null;

  const back = h("a", {
    className: "linky",
    href: routeHref(withOrg("/releases", linkOrg, { orgs })),
    text: "← All releases",
  });

  /**
   * Existence is established from the release itself. Its sub-resources
   * answer 404 for a missing release too, but they also answer 200 with an
   * empty list for one that exists and has none — so asking them first
   * cannot tell a typo from an ordinary release with no commits.
   */
  let release;
  try {
    release = await glitchtip.get(versionPath(org, version), { signal });
  } catch (error) {
    throwIfAborted(signal);
    fill(outlet, h("div", { className: "issues-view" },
      back,
      h("p", { className: "error", text: readFailure(error?.status ?? 0, "this release") })));
    return;
  }
  throwIfAborted(signal);

  const [files, commits, deploys] = await Promise.all([
    settle(glitchtip.get(`${versionPath(org, version)}files/`, { signal })),
    settle(glitchtip.get(`${versionPath(org, version)}commits/`, { signal })),
    settle(glitchtip.get(`${versionPath(org, version)}deploys/`, { signal })),
  ]);
  throwIfAborted(signal);

  const status = h("p", { className: "muted", hidden: true });
  const say = (text, kind = "muted") => {
    status.hidden = !text;
    status.className = kind;
    status.textContent = text;
  };

  /**
   * Re-render this screen after a write, rather than navigate to it: go()
   * returns early when the URL it is handed is the one already showing, so
   * saving a release would have left the old values on screen and looked
   * like the save had not happened.
   */
  const reload = () => refreshRoute();

  fill(
    outlet,
    h("div", { className: "issues-view" },
      back,
      h("header", { className: "detail-head row" },
        h("h2", { className: "mono", text: release.version }),
        can.canManageReleases
          ? h("button", {
              type: "button",
              className: "ghost danger",
              text: "Delete release",
              on: {
                click: async () => {
                  const sure = await confirmAction({
                    title: `Delete ${shortVersion(release.version)}?`,
                    detail:
                      "The release and its files, commits and deploys go. Events that " +
                      "named it keep the name, and stop having anything to point at.",
                    confirm: "Delete it",
                    signal,
                  });
                  if (!sure) return;
                  try {
                    await glitchtip.del(versionPath(org, version), { signal });
                    go(withOrg("/releases", linkOrg, { orgs }), { replace: true });
                  } catch (failure) {
                    say(failure?.message || `Couldn't delete that (${failure?.status ?? 0}).`, "error");
                  }
                },
              },
            })
          : null
      ),
      status,
      detailsSection(release, { org, version, can, say, reload, signal }),
      section("Projects",
        (release.projects || []).length
          ? h("ul", { className: "origin-list" },
              (release.projects || []).map((project) =>
                h("li", {},
                  h("a", {
                    className: "linky",
                    href: routeHref(
                      withOrg(`/projects/${encodeURIComponent(project.slug)}`, linkOrg, { orgs })
                    ),
                    text: project.name || project.slug,
                  }))))
          : h("p", { className: "muted", text: "No projects are attached to this release." })),
      commits.failed !== undefined
        ? unavailable("Commits", commits.failed, "this release's commits")
        : commitsSection(commits.data),
      deploys.failed !== undefined
        ? unavailable("Deploys", deploys.failed, "this release's deploys")
        : deploysSection(deploys.data),
      files.failed !== undefined
        ? unavailable("Files", files.failed, "this release's files")
        : filesSection(files.data, { org, version, can, say, reload, signal })
    )
  );
}

/**
 * When it was first seen, when it shipped, and what it points at.
 *
 * Both editable fields are in one form on purpose: the endpoint replaces
 * both whatever is sent, so offering them as two independent saves would let
 * saving one quietly rewrite the other.
 */
function detailsSection(release, { org, version, can, say, reload, signal }) {
  /**
   * What cannot be changed from here. Ref and the release date are left out
   * deliberately: the form below is the whole of what this screen does with
   * them, and printing them above their own prefilled inputs is the same
   * value twice with nothing to say which one is current.
   */
  const facts = (...extra) => h("dl", { className: "release-facts" },
    extra,
    h("dt", { text: "First seen" }), h("dd", { text: at(release.dateCreated) }),
    h("dt", { text: "Commits" }), h("dd", { text: String(release.commitCount ?? 0) }),
    h("dt", { text: "Deploys" }), h("dd", { text: String(release.deployCount ?? 0) })
  );

  // No role at all: the same facts, with the two editable ones read out
  // rather than dropped, since there is no form to carry them.
  if (!can.canManageReleases) {
    return section("Release", facts(
      h("dt", { text: "Ref" }),
      h("dd", { className: release.ref ? "mono" : "muted", text: release.ref || "none" }),
      h("dt", { text: "Released" }),
      h("dd", { text: release.dateReleased ? at(release.dateReleased) : "not marked as released" })
    ));
  }

  const rows = facts();

  const ref = field({
    label: "Ref",
    id: "release-ref",
    value: release.ref || "",
    placeholder: "a commit SHA, or a tag",
  });
  const released = field({
    label: "Released",
    id: "release-date",
    type: "datetime-local",
    value: toLocalInput(release.dateReleased),
  });
  const save = h("button", { type: "submit", text: "Save release" });

  return section("Release",
    rows,
    h("form", {
      on: {
        submit: async (event) => {
          event.preventDefault();
          save.disabled = true;
          try {
            await glitchtip.put(
              `/organizations/${encodeURIComponent(org)}/releases/${encodeURIComponent(version)}/`,
              releaseUpdate({
                ref: ref.input.value,
                dateReleased: fromLocalInput(released.input.value),
              }),
              { signal }
            );
            say("Saved.");
            reload();
          } catch (failure) {
            say(failure?.message || `Couldn't save that (${failure?.status ?? 0}).`, "error");
          } finally {
            save.disabled = false;
          }
        },
      },
    },
      ref.node,
      released.node,
      // Said once, next to the control it is about, rather than discovered.
      h("p", { className: "muted",
        text: "Clearing the date marks the release as not yet shipped. Both fields save together." }),
      h("div", { className: "form-actions" }, save))
  );
}

function commitsSection(commits) {
  const rows = Array.isArray(commits) ? commits : [];
  return section("Commits",
    rows.length
      ? h("table", { className: "issues-table" },
          h("thead", {}, h("tr", {},
            h("th", { text: "Commit" }),
            h("th", { text: "Message" }),
            h("th", { text: "Author" })
          )),
          h("tbody", {}, rows.map((commit) =>
            h("tr", {},
              h("td", { className: "mono", text: shortVersion(commit.id) }),
              h("td", { text: commitSubject(commit.message) }),
              h("td", { text: commit.authorName || commit.authorEmail || "—" }))))
        )
      : h("p", { className: "muted",
          text: "No commits. A build attaches them with sentry-cli releases set-commits." })
  );
}

function deploysSection(deploys) {
  const rows = Array.isArray(deploys) ? deploys : [];
  return section("Deploys",
    rows.length
      ? h("table", { className: "issues-table" },
          h("thead", {}, h("tr", {},
            h("th", { text: "Environment" }),
            h("th", { text: "Started" }),
            h("th", { text: "Finished" }),
            h("th", { text: "Where" })
          )),
          h("tbody", {}, rows.map((deploy) =>
            h("tr", {},
              h("td", { text: deploy.environment || "—" }),
              h("td", { text: deploy.dateStarted ? at(deploy.dateStarted) : "—" }),
              h("td", { text: deploy.dateFinished ? at(deploy.dateFinished) : "—" }),
              h("td", {},
                deploy.url
                  ? h("a", { className: "linky", href: deploy.url, text: deploy.url,
                      attrs: { target: "_blank", rel: "noreferrer noopener" } })
                  : h("span", { className: "muted", text: "—" })))))
        )
      : h("p", { className: "muted",
          text: "No deploys. A pipeline records one with sentry-cli releases deploys new." })
  );
}

/**
 * Source maps and debug files, which is what makes a stack trace readable.
 *
 * Uploading them is sentry-cli's job and deliberately not offered here — it
 * is a build step with chunked uploads and no screen in GlitchTip either.
 * Seeing what a release actually carries, and removing a file that should not
 * be there, are the halves that belong on a screen.
 */
function filesSection(files, { org, version, can, say, reload, signal }) {
  const rows = Array.isArray(files) ? files : [];
  if (!rows.length) {
    return section("Files",
      h("p", { className: "muted",
        text: "No files. Source maps are uploaded by sentry-cli as part of a build." }));
  }

  const remove = async (file) => {
    const sure = await confirmAction({
      title: `Delete ${file.name}?`,
      detail: "Stack traces that needed this file to be readable stop being readable.",
      confirm: "Delete it",
      signal,
    });
    if (!sure) return;
    try {
      await glitchtip.del(
        `/organizations/${encodeURIComponent(org)}/releases/${encodeURIComponent(version)}` +
          `/files/${encodeURIComponent(file.id)}/`,
        { signal }
      );
      reload();
    } catch (failure) {
      say(failure?.message || `Couldn't delete that (${failure?.status ?? 0}).`, "error");
    }
  };

  return section("Files",
    h("table", { className: "issues-table" },
      h("thead", {}, h("tr", {},
        h("th", { text: "Name" }),
        h("th", { className: "num", text: "Size" }),
        h("th", { text: "Uploaded" }),
        h("th", { text: "" })
      )),
      h("tbody", {}, rows.map((file) =>
        h("tr", {},
          h("td", { className: "mono", text: file.name }),
          h("td", { className: "num", text: fileSize(file.size) }),
          h("td", { text: since(file.dateCreated) }),
          h("td", {},
            can.canManageReleases
              ? h("button", { type: "button", className: "ghost danger", text: "Delete",
                  on: { click: () => void remove(file) } })
              : null))))
    )
  );
}
