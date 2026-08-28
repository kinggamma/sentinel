/**
 * The contracts behind the performance screens.
 *
 * Durations arrive as floats in milliseconds, counts as integers, and the
 * error rate already as a percentage — GlitchTip does that arithmetic, and
 * redoing it here would be a second opinion nobody asked for. What is left is
 * turning those numbers into something readable at a glance and keeping the
 * filters in the address bar rather than in a variable.
 */

/**
 * A duration, in the unit that makes it readable.
 *
 * Milliseconds all the way up means comparing 45 to 45000 by counting digits,
 * which is exactly the comparison this column exists to make easy. Below a
 * millisecond stays in microseconds rather than rounding to "0 ms", because
 * a fast span and a missing measurement should not look the same.
 */
export function duration(ms) {
  // Explicitly, before Number() turns null into a perfectly plausible zero —
  // which is how "we never measured this" renders as "0 ms", the one answer
  // it must not be confused with.
  if (ms === null || ms === undefined || ms === "") return "—";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 ms";
  if (value < 1) return `${Math.round(value * 1000)} µs`;
  if (value < 1000) return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Requests per minute, as GlitchTip computes it, or nothing if it could not. */
export function throughput(perMinute) {
  const value = Number(perMinute);
  if (perMinute === null || perMinute === undefined || !Number.isFinite(value)) return "—";
  if (value >= 100) return `${Math.round(value)}/min`;
  if (value >= 1) return `${value.toFixed(1)}/min`;
  // Under one a minute is better said per hour than as "0.0/min".
  return `${(value * 60).toFixed(1)}/hr`;
}

/**
 * A count, grouped.
 *
 * These columns are read by comparing them down the page, and 98000 beside
 * 14000 is compared by counting digits — the same reason durations change
 * unit rather than staying in milliseconds.
 */
export function count(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString();
}

/** A percentage that is already a percentage. Zero is a real answer, not "—". */
export function errorRate(percent) {
  // Same trap as duration(): Number(null) is 0, and "no errors" and "we do
  // not know" are opposite answers.
  if (percent === null || percent === undefined || percent === "") return "—";
  const value = Number(percent);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** The sorts GlitchTip's own filter schema accepts, and nothing else. */
export const SORTS = Object.freeze([
  { value: "-avg_duration", label: "Slowest" },
  { value: "avg_duration", label: "Fastest" },
  { value: "-count", label: "Most traffic" },
  { value: "count", label: "Least traffic" },
  { value: "-created", label: "Newest" },
  { value: "created", label: "Oldest" },
]);

const SORT_VALUES = new Set(SORTS.map((one) => one.value));

/**
 * How far back to look.
 *
 * All time is spelled "all" rather than left empty. An empty value is
 * indistinguishable from an absent one, so ?range= would have had to mean
 * something different from no ?range at all — and it wrote a trailing
 * "?range=" into every link to it.
 */
export const RANGES = Object.freeze([
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
]);

const RANGE_VALUES = new Set(RANGES.map((one) => one.value));

/**
 * The filters, read from the address rather than kept beside it.
 *
 * Anything unrecognised falls back to the default rather than being passed
 * through: these go into a query string GlitchTip validates with a Literal,
 * and a hand-edited sort would come back 422 with nothing on screen to
 * explain it.
 */
export function readFilters(query = {}) {
  const sort = SORT_VALUES.has(query.sort) ? query.sort : "-avg_duration";
  const range = RANGE_VALUES.has(query.range) ? query.range : "24h";
  return { sort, range, query: String(query.q || "").trim(), cursor: query.cursor || "" };
}

/** The same filters, as this app's own address. */
export function search(filters, { extra = {} } = {}) {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.sort && filters.sort !== "-avg_duration") params.set("sort", filters.sort);
  if (filters.range !== "24h") params.set("range", filters.range);
  if (filters.cursor) params.set("cursor", filters.cursor);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** And as GlitchTip's, which names them differently and wants a start time. */
export function apiSearch(filters) {
  const params = new URLSearchParams();
  params.set("sort", filters.sort || "-avg_duration");
  if (filters.query) params.set("query", filters.query);
  // All time is the absence of a bound, not a bound of "now-all".
  if (filters.range && filters.range !== "all") params.set("start", `now-${filters.range}`);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return params.toString();
}

/** The same window, for the endpoints that take it on its own. */
export function windowQuery(filters) {
  return filters.range && filters.range !== "all" ? `?start=now-${filters.range}` : "";
}
