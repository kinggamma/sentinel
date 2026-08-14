import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { saveReport, getReport, listReports, deleteReport, reportDir } from "../storage.js";
import { notifyNewReport } from "../notify.js";
import { retentionPolicy } from "../retention.js";
import {
  glitchtipLink,
  glitchtipInfo,
  createProjectForApp,
  provisioningReady,
} from "../glitchtip.js";
import {
  slugForApp,
  isKnown,
  remember,
  all as allMappings,
  orgForProject,
} from "../project-map.js";
import { registeredApps, originsForApp } from "../settings.js";
import path from "node:path";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);
// Screenshots are legacy — apps now send an rrweb replay instead — but old
// clients and any app that hasn't been rebuilt still upload frames.
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FRAMES + 1 },
}).fields([
  { name: "screenshots", maxCount: MAX_FRAMES },
  { name: "replay", maxCount: 1 },
]);

export const reportRouter = Router();

/**
 * What this viewer may see.
 *
 * Exactly one thing sees everything: the shared staff token. It is an app
 * rather than a person — how SDKs post and how the embedded viewer reads its
 * own app's reports — and it is checked by name here rather than falling out
 * of some absent value, because "we could not work out what you may see" and
 * "you may see all of it" must never be the same branch.
 *
 * They used to be. A person's project list fell back to null whenever
 * GlitchTip refused or failed to answer, and null meant unrestricted — so a
 * momentary fault handed one organisation's reports to another's for as long
 * as it lasted. Now a person always has a list, a refusal makes it empty,
 * and a fault refuses the request upstream rather than reaching here.
 *
 * An app whose GlitchTip project is unknown is no longer shown to everyone.
 * It cannot be attributed to an organisation, and something unattributable
 * is precisely what must not be handed out by default. It stays visible to
 * the staff token, which is how anyone notices it exists.
 */
async function visibleTo(viewer, appName) {
  if (viewer?.source === "staff-token") return true;

  const allowed = viewer?.projects;
  if (!Array.isArray(allowed)) return false;

  const projectSlug = await slugForApp(appName);
  if (!projectSlug) return false;
  return allowed.includes(projectSlug);
}


/**
 * An app that has never reported before doesn't have a GlitchTip project
 * yet, and asking someone to go and make one by hand is the step everybody
 * forgets — so the first report from a new app creates it.
 *
 * Deliberately not awaited by the request that triggered it: the report is
 * already saved, and an app filing a bug shouldn't get a 500 because
 * GlitchTip was slow or down. Failures are logged and retried by the next
 * report from that app, since nothing gets recorded until one succeeds.
 */
const provisioning = new Set();

function provisionInBackground(appName) {
  if (!provisioningReady() || provisioning.has(appName)) return;

  provisioning.add(appName);
  void (async () => {
    try {
      if (await isKnown(appName)) return;
      const project = await createProjectForApp(appName);
      if (!project) return;
      await remember(appName, project);
      console.log(
        `created GlitchTip project "${project.slug}" for ${appName}` +
          (project.dsn ? " (DSN available in the viewer)" : " (no DSN readable)")
      );
    } catch (err) {
      console.warn(`couldn't create a GlitchTip project for ${appName}: ${err.message}`);
    } finally {
      provisioning.delete(appName);
    }
  })();
}


/**
 * Load a report only if this viewer is allowed to see it. Anything else
 * answers 404 rather than 403: whether an id exists is itself information.
 */
async function readableReport(req, id) {
  const report = await getReport(id);
  return (await visibleTo(req.viewer, report.appName)) ? report : null;
}

// Accepts multipart/form-data:
//   appName, url, note, reporterEmail, source ("staff-report" | "auto-error"),
//   breadcrumbs (JSON string), glitchtipEventId (optional),
//   replay (rrweb event stream, JSON) + replayMeta,
//   screenshots (legacy image frames) + screenshotTimestamps
reportRouter.post("/reports", upload, async (req, res) => {
  try {
    const { appName, url, note, reporterEmail, source, glitchtipEventId } = req.body;

    if (!appName) {
      return res.status(400).json({ error: "appName is required" });
    }

    let breadcrumbs = [];
    if (req.body.breadcrumbs) {
      try {
        breadcrumbs = JSON.parse(req.body.breadcrumbs);
      } catch {
        return res.status(400).json({ error: "breadcrumbs must be valid JSON" });
      }
    }

    let screenshotTimestamps = [];
    if (req.body.screenshotTimestamps) {
      try {
        screenshotTimestamps = JSON.parse(req.body.screenshotTimestamps);
      } catch {
        return res.status(400).json({ error: "screenshotTimestamps must be valid JSON" });
      }
    }

    let replayMeta = null;
    if (req.body.replayMeta) {
      try {
        replayMeta = JSON.parse(req.body.replayMeta);
      } catch {
        return res.status(400).json({ error: "replayMeta must be valid JSON" });
      }
    }

    const id = nanoid(12);
    const meta = {
      id,
      appName,
      url: url || null,
      note: note || null,
      reporterEmail: reporterEmail || null,
      source: source === "auto-error" ? "auto-error" : "staff-report",
      glitchtipEventId: glitchtipEventId || null,
      breadcrumbs,
      screenshotTimestamps,
      replayMeta,
      createdAt: new Date().toISOString(),
    };

    const screenshotBuffers = (req.files?.screenshots || []).map((f) => f.buffer);
    const replayBuffer = req.files?.replay?.[0]?.buffer || null;
    const { screenshotPaths, hasReplay } = await saveReport(
      id,
      meta,
      screenshotBuffers,
      replayBuffer
    );
    meta.screenshots = screenshotPaths;
    meta.hasReplay = hasReplay;

    await notifyNewReport(meta);
    provisionInBackground(appName);

    res.status(201).json({ id, screenshots: screenshotPaths, hasReplay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save report" });
  }
});

reportRouter.get("/reports", async (req, res) => {
  const reports = await listReports();
  const visible = [];
  for (const report of reports) {
    if (await visibleTo(req.viewer, report.appName)) visible.push(report);
  }
  res.json(visible);
});

/** So the viewer can tell staff how long reports stick around. */
reportRouter.get("/retention", (_req, res) => res.json(retentionPolicy));

/**
 * The projects-first landing page: one card per app that has ever reported,
 * with enough to decide where to look, and a link across to the same
 * project's errors in GlitchTip.
 */
reportRouter.get("/projects", async (req, res) => {
  const reports = await listReports();
  const byApp = new Map();

  for (const report of reports) {
    const entry = byApp.get(report.appName) || {
      appName: report.appName,
      total: 0,
      staffReports: 0,
      autoErrors: 0,
      withReplay: 0,
      lastReportAt: null,
    };

    entry.total += 1;
    if (report.source === "auto-error") entry.autoErrors += 1;
    else entry.staffReports += 1;
    if (report.hasReplay) entry.withReplay += 1;
    // listReports() is newest-first, so the first one wins.
    entry.lastReportAt = entry.lastReportAt || report.createdAt;

    byApp.set(report.appName, entry);
  }

  // An app registered but not yet reporting still gets a card: that's where
  // its address is set, and it can't report from a browser until that's
  // done. A card reading "no reports yet" is the point.
  for (const { appName } of registeredApps()) {
    if (byApp.has(appName)) continue;
    byApp.set(appName, {
      appName,
      total: 0,
      staffReports: 0,
      autoErrors: 0,
      withReplay: 0,
      lastReportAt: null,
    });
  }

  const mappings = await allMappings();
  const projects = [];
  for (const entry of byApp.values()) {
    if (!(await visibleTo(req.viewer, entry.appName))) continue;

    const mapping = mappings[entry.appName] || {};
    const projectSlug = mapping.slug || null;
    const org = projectSlug ? await orgForProject(projectSlug) : null;
    projects.push({
      ...entry,
      glitchtipProject: projectSlug,
      // Only when we know which project this app reports to, and which
      // organisation owns it. Without both, the link would either cover
      // every project's errors or point into somebody else's organisation.
      glitchtipUrl: projectSlug ? glitchtipLink({ projectSlug, org }) : null,
      // Present only for projects we created, which is exactly when
      // whoever is integrating the app still needs it.
      dsn: mapping.dsn || null,
      // Where this app is allowed to report from, shown on its own card so
      // the answer sits next to the app it belongs to.
      origins: originsForApp(entry.appName),
    });
  }
  projects.sort((a, b) => String(b.lastReportAt).localeCompare(String(a.lastReportAt)));

  res.json({ projects, glitchtip: glitchtipInfo().url ? glitchtipLink({}) : null });
});

reportRouter.delete("/reports/:id", async (req, res) => {
  try {
    if (!(await readableReport(req, req.params.id))) {
      return res.status(404).json({ error: "not found" });
    }
    await deleteReport(req.params.id);
    res.status(204).end();
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

reportRouter.get("/reports/:id/replay", async (req, res) => {
  const { id } = req.params;
  if (id.includes("..") || id.includes("/")) return res.status(400).end();
  // A replay is a recording of somebody's session — the most sensitive thing
  // stored here, and the least excusable to serve to the wrong organisation.
  try {
    if (!(await readableReport(req, id))) return res.status(404).json({ error: "not found" });
  } catch {
    return res.status(404).json({ error: "not found" });
  }
  res.type("application/json");
  res.sendFile(path.join(reportDir(id), "replay.json"), (err) => {
    if (err) res.status(404).json({ error: "not found" });
  });
});

reportRouter.get("/reports/:id", async (req, res) => {
  try {
    const report = await getReport(req.params.id);
    // Link straight to the matching error in GlitchTip when this report was
    // raised by one, so the two halves of an incident are one click apart.
    if (!(await visibleTo(req.viewer, report.appName))) {
      // Same answer as a report that doesn't exist: knowing an id belongs to
      // another organisation's app is itself something to withhold.
      return res.status(404).json({ error: "not found" });
    }

    const projectSlug = await slugForApp(report.appName);
    const org = projectSlug ? await orgForProject(projectSlug) : null;
    if (report.glitchtipEventId) {
      report.glitchtipUrl = glitchtipLink({ projectSlug, org, eventId: report.glitchtipEventId });
    } else {
      // No event of its own, so the best we can offer is the project's
      // stream — and only if we know which project that is.
      report.glitchtipUrl = projectSlug ? glitchtipLink({ projectSlug, org }) : null;
    }
    res.json(report);
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

reportRouter.get("/reports/:id/screenshots/:filename", async (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes("..") || id.includes("..")) {
    return res.status(400).end();
  }
  try {
    if (!(await readableReport(req, id))) return res.status(404).json({ error: "not found" });
  } catch {
    return res.status(404).json({ error: "not found" });
  }
  res.sendFile(path.join(reportDir(id), filename), (err) => {
    if (err) res.status(404).json({ error: "not found" });
  });
});
