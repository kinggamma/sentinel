import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { saveReport, getReport, listReports, reportDir } from "../storage.js";
import { notifyNewReport } from "../notify.js";
import path from "node:path";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 5 },
});

export const reportRouter = Router();

// Accepts multipart/form-data:
//   appName, url, note, reporterEmail, source ("staff-report" | "auto-error"),
//   breadcrumbs (JSON string), glitchtipEventId (optional),
//   screenshots (0-5 image files)
reportRouter.post("/reports", upload.array("screenshots", 5), async (req, res) => {
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
      createdAt: new Date().toISOString(),
    };

    const screenshotBuffers = (req.files || []).map((f) => f.buffer);
    const { screenshotPaths } = await saveReport(id, meta, screenshotBuffers);
    meta.screenshots = screenshotPaths;

    await notifyNewReport(meta);

    res.status(201).json({ id, screenshots: screenshotPaths });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save report" });
  }
});

reportRouter.get("/reports", async (_req, res) => {
  const reports = await listReports();
  res.json(reports);
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
