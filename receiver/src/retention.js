import { listReports, deleteReport, reportSize } from "./storage.js";

/**
 * Retention.
 *
 * Reports carry screenshots, replays, and staff notes about real people's
 * sessions — keeping them forever is both a storage problem and a privacy
 * one. Two independent caps, whichever bites first:
 *
 *   RETENTION_DAYS  delete anything older than this          (default 90)
 *   RETENTION_MAX_MB  when the store grows past this, delete
 *                     oldest-first until it fits             (default 5120)
 *
 * Set either to 0 to disable that cap.
 */
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);
const RETENTION_MAX_MB = Number(process.env.RETENTION_MAX_MB ?? 5120);
const SWEEP_INTERVAL_MS = Number(process.env.RETENTION_SWEEP_MINUTES ?? 360) * 60 * 1000;

export async function sweep() {
  const reports = await listReports(); // newest first
  const deleted = { byAge: [], bySize: [] };

  const survivors = [];
  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const report of reports) {
      if (new Date(report.createdAt).getTime() < cutoff) {
        await deleteReport(report.id).catch(() => {});
        deleted.byAge.push(report.id);
      } else {
        survivors.push(report);
      }
    }
  } else {
    survivors.push(...reports);
  }

  if (RETENTION_MAX_MB > 0) {
    const budget = RETENTION_MAX_MB * 1024 * 1024;
    const sized = [];
    let total = 0;
    for (const report of survivors) {
      const size = await reportSize(report.id).catch(() => 0);
      sized.push({ report, size });
      total += size;
    }

    // survivors is newest-first, so walk it backwards to drop oldest first.
    for (let i = sized.length - 1; i >= 0 && total > budget; i--) {
      await deleteReport(sized[i].report.id).catch(() => {});
      total -= sized[i].size;
      deleted.bySize.push(sized[i].report.id);
    }
  }

  const count = deleted.byAge.length + deleted.bySize.length;
  if (count) {
    console.log(
      `retention: deleted ${count} report(s) — ${deleted.byAge.length} past ${RETENTION_DAYS}d, ` +
        `${deleted.bySize.length} over ${RETENTION_MAX_MB}MB`
    );
  }
  return deleted;
}

export function startRetentionSweeps() {
  if (RETENTION_DAYS <= 0 && RETENTION_MAX_MB <= 0) {
    console.warn("retention: both caps disabled — reports are kept forever.");
    return;
  }
  console.log(
    `retention: keeping ${RETENTION_DAYS || "∞"} days / ${RETENTION_MAX_MB || "∞"} MB, ` +
      `sweeping every ${SWEEP_INTERVAL_MS / 60000} min`
  );
  void sweep().catch((err) => console.error("retention sweep failed", err));
  const timer = setInterval(
    () => void sweep().catch((err) => console.error("retention sweep failed", err)),
    SWEEP_INTERVAL_MS
  );
  timer.unref?.();
}

export const retentionPolicy = {
  days: RETENTION_DAYS,
  maxMb: RETENTION_MAX_MB,
};
