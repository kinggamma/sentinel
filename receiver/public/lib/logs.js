/**
 * The contracts behind the logs screen.
 *
 * Levels are GlitchTip's own, in its own order — OpenTelemetry's severity
 * ladder from trace to fatal — and the order is the point: "at least warn" is
 * the filter people actually want, and it only means anything if the list is
 * ranked rather than alphabetical.
 */

/** Ranked, low to high, exactly as apps/logs/constants.py has them. */
export const LEVELS = Object.freeze(["trace", "debug", "info", "warn", "error", "fatal"]);

const LEVEL_SET = new Set(LEVELS);

/**
 * "warning" is accepted by GlitchTip and is not one of its own labels.
 *
 * Its LEVEL_MAP takes both spellings on the way in and its schema only ever
 * says "warn" on the way out, so a screen that stored what it was given would
 * have a filter that matches nothing on a row it just displayed.
 */
export function normaliseLevel(level) {
  const value = String(level || "").toLowerCase();
  if (value === "warning") return "warn";
  return LEVEL_SET.has(value) ? value : "";
}

/** Everything at or above a level, which is what a severity filter means. */
export function atLeast(level) {
  const from = LEVELS.indexOf(normaliseLevel(level));
  return from === -1 ? [] : LEVELS.slice(from);
}

/**
 * The filters, read from the address.
 *
 * `minLevel` rather than a set of levels: every real use of this is "show me
 * warnings and worse", and a screen offering six independent tick boxes makes
 * the common case six clicks and the pointless cases easy to reach.
 */
export function readFilters(query = {}) {
  return {
    minLevel: normaliseLevel(query.level),
    service: String(query.service || "").trim(),
    environment: String(query.environment || "").trim(),
    query: String(query.q || "").trim(),
    // Correlation rather than filtering: one request's worth of lines, which
    // is the only way to read a log that is one line of many.
    trace: String(query.trace || "").trim(),
    range: ["1h", "24h", "7d", "30d"].includes(query.range) ? query.range : "24h",
    cursor: query.cursor || "",
  };
}

/** This app's own address for those filters. */
export function search(filters, extra = {}) {
  const merged = { ...filters, ...extra };
  const params = new URLSearchParams();
  if (merged.minLevel) params.set("level", merged.minLevel);
  if (merged.service) params.set("service", merged.service);
  if (merged.environment) params.set("environment", merged.environment);
  if (merged.query) params.set("q", merged.query);
  if (merged.trace) params.set("trace", merged.trace);
  if (merged.range && merged.range !== "24h") params.set("range", merged.range);
  if (merged.cursor) params.set("cursor", merged.cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * And GlitchTip's, which takes one `level` parameter per level rather than a
 * minimum — so "warn and above" is three values, not one.
 */
export function apiSearch(filters) {
  const params = new URLSearchParams();
  for (const level of atLeast(filters.minLevel)) params.append("level", level);
  if (filters.service) params.set("service", filters.service);
  if (filters.environment) params.set("environment", filters.environment);
  if (filters.query) params.set("query", filters.query);
  // GlitchTip spells it traceId, and it is the one filter that should widen
  // the window rather than be narrowed by it: the rest of a trace is not
  // necessarily inside the window the line was found in.
  if (filters.trace) params.set("traceId", filters.trace);
  if (filters.range && !filters.trace) params.set("start", `now-${filters.range}`);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return params.toString();
}

/**
 * A log line, shortened to what fits a table row.
 *
 * The first line only, and never mid-word: a stack trace or a JSON blob in a
 * log body is thousands of characters, and a row that grows to hold one makes
 * every other row unreadable. The whole thing is on the log's own screen.
 */
export function summarise(body, limit = 160) {
  const first = String(body || "").split("\n").find((line) => line.trim()) || "";
  const line = first.trim();
  if (line.length <= limit) return line || "(empty)";
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether a log body has more to it than the row is showing. */
export const hasMore = (body, limit = 160) =>
  summarise(body, limit) !== String(body || "").trim();
