/**
 * One relative-time function.
 *
 * There were two, disagreeing: one said "3 minutes ago" and stopped at days,
 * the other said "3 minutes" and went on to years. Screens want both forms,
 * so the suffix is an option rather than a second function.
 */
const STEPS = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
  [2592000, 86400, "day"],
  [31536000, 2592000, "month"],
];

export function since(iso, { suffix = true } = {}) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "never";

  for (const [limit, divisor, unit] of STEPS) {
    if (seconds < limit) {
      const value = Math.max(1, Math.floor(seconds / divisor));
      return `${value} ${unit}${value === 1 ? "" : "s"}${suffix ? " ago" : ""}`;
    }
  }
  const years = Math.floor(seconds / 31536000);
  return `${years} year${years === 1 ? "" : "s"}${suffix ? " ago" : ""}`;
}

/** An absolute timestamp, for when "2 days ago" isn't precise enough. */
export function at(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Sentry breadcrumb timestamps are seconds since epoch, sometimes float. */
export function breadcrumbTime(ts) {
  if (!ts) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
