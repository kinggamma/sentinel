import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { saveReport, getReport, listReports, deleteReport, reportDir } from "../storage.js";
import { notifyNewReport } from "../notify.js";
import { retentionPolicy } from "../retention.js";
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

    res.status(201).json({ id, screenshots: screenshotPaths, hasReplay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save report" });
  }
});

reportRouter.get("/reports", async (_req, res) => {
  const reports = await listReports();
  res.json(reports);
});

/** So the viewer can tell staff how long reports stick around. */
reportRouter.get("/retention", (_req, res) => res.json(retentionPolicy));

reportRouter.delete("/reports/:id", async (req, res) => {
  try {
    await deleteReport(req.params.id);
    res.status(204).end();
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

reportRouter.get("/reports/:id/replay", async (req, res) => {
  const { id } = req.params;
  if (id.includes("..") || id.includes("/")) return res.status(400).end();
  res.type("application/json");
  res.sendFile(path.join(reportDir(id), "replay.json"), (err) => {
    if (err) res.status(404).json({ error: "not found" });
  });
});

reportRouter.get("/reports/:id", async (req, res) => {
  try {
    const report = await getReport(req.params.id);
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
  res.sendFile(path.join(reportDir(id), filename), (err) => {
    if (err) res.status(404).json({ error: "not found" });
  });
});
