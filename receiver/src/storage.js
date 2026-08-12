import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const REPORTS_DIR = path.join(DATA_DIR, "reports");

async function ensureReportsDir() {
  await mkdir(REPORTS_DIR, { recursive: true });
}

/**
 * Persist an incident/feedback bundle to disk.
 * Layout: /data/reports/<id>/meta.json, replay.json, screenshot-00.jpg, ...
 *
 * Reports created before the switch to session replay still carry
 * screenshots; both shapes stay readable.
 */
export async function saveReport(id, meta, screenshotBuffers = [], replayBuffer = null) {
  await ensureReportsDir();
  const dir = path.join(REPORTS_DIR, id);
  await mkdir(dir, { recursive: true });

  const screenshotPaths = [];
  for (let i = 0; i < screenshotBuffers.length; i++) {
    // Frames arrive as JPEG — the buffer is lossy on purpose, and JPEG is a
    // third the size of PNG for a screenshot of a UI.
    const filename = `screenshot-${String(i).padStart(2, "0")}.jpg`;
    await writeFile(path.join(dir, filename), screenshotBuffers[i]);
    screenshotPaths.push(filename);
  }

  let hasReplay = false;
  if (replayBuffer?.length) {
    await writeFile(path.join(dir, "replay.json"), replayBuffer);
    hasReplay = true;
  }

  // Written last, and with the screenshot list included — otherwise the
  // stored meta.json (and therefore every GET /reports response) claims
  // the report has no screenshots even when it does.
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ ...meta, screenshots: screenshotPaths, hasReplay }, null, 2)
  );

  return { dir, screenshotPaths, hasReplay };
}

export async function getReport(id) {
  const dir = path.join(REPORTS_DIR, id);
  const metaRaw = await readFile(path.join(dir, "meta.json"), "utf-8");
  return JSON.parse(metaRaw);
}

export async function listReports() {
  await ensureReportsDir();
  const entries = await readdir(REPORTS_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const reports = await Promise.all(
    ids.map(async (id) => {
      try {
        return await getReport(id);
      } catch {
        return null;
      }
    })
  );
  return reports.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteReport(id) {
  const dir = path.join(REPORTS_DIR, id);
  // Fail loudly if it isn't there, so the API can answer 404 honestly.
  await stat(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Bytes on disk for one report, screenshots and replay included. */
export async function reportSize(id) {
  const dir = path.join(REPORTS_DIR, id);
  let total = 0;
  for (const entry of await readdir(dir)) {
    try {
      total += (await stat(path.join(dir, entry))).size;
    } catch {
      // Raced with a delete; ignore.
    }
  }
  return total;
}

export function reportDir(id) {
  return path.join(REPORTS_DIR, id);
}

export { REPORTS_DIR };
