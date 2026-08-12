import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const REPORTS_DIR = path.join(DATA_DIR, "reports");

async function ensureReportsDir() {
  await mkdir(REPORTS_DIR, { recursive: true });
}

/**
 * Persist an incident/feedback bundle to disk.
 * Layout: /data/reports/<id>/meta.json, screenshot-0.png, screenshot-1.png, ...
 */
export async function saveReport(id, meta, screenshotBuffers = []) {
  await ensureReportsDir();
  const dir = path.join(REPORTS_DIR, id);
  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  const screenshotPaths = [];
  for (let i = 0; i < screenshotBuffers.length; i++) {
    const filename = `screenshot-${i}.png`;
    await writeFile(path.join(dir, filename), screenshotBuffers[i]);
    screenshotPaths.push(filename);
  }

  return { dir, screenshotPaths };
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

export function reportDir(id) {
  return path.join(REPORTS_DIR, id);
}
