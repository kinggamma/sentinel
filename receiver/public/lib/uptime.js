/**
 * The contracts behind the uptime screens.
 *
 * A monitor's shape depends on what kind it is, and GlitchTip enforces that
 * on the way in with messages worth not provoking: a GET with no expected
 * status is a 422, and so is an HTTP monitor with no URL. The rules are
 * mirrored here so the form asks for what this kind of monitor needs and
 * nothing else, rather than showing every field and letting the server sort
 * it out.
 */

/** GlitchTip's own values, which are what the API stores. */
export const MONITOR_TYPES = Object.freeze([
  { value: "Ping", label: "Ping", hint: "A request that only has to arrive." },
  { value: "GET", label: "GET", hint: "A page that has to answer, with the status you expect." },
  { value: "POST", label: "POST", hint: "The same, sent as a POST." },
  { value: "TCP Port", label: "TCP port", hint: "A host and port that has to accept a connection." },
  { value: "SSL", label: "SSL certificate", hint: "A certificate that has to still be valid." },
  { value: "Heartbeat", label: "Heartbeat", hint: "Something that has to call in, rather than be called." },
]);

const TYPE_VALUES = new Set(MONITOR_TYPES.map((one) => one.value));

export const knownType = (type) => (TYPE_VALUES.has(type) ? type : "GET");

/** Everything except a heartbeat is something we go and look at. */
export const needsUrl = (type) => knownType(type) !== "Heartbeat";

/** Only the two that read a response can be told what response to expect. */
export const needsExpectedStatus = (type) => ["GET", "POST"].includes(knownType(type));

export const needsExpectedBody = (type) => ["GET", "POST"].includes(knownType(type));

/** A port monitor's URL is a host and a port, not a URL. */
export const urlLabel = (type) =>
  knownType(type) === "TCP Port" ? "Host and port" : "URL";

export const urlHint = (type) =>
  knownType(type) === "TCP Port" ? "example.com:5432" : "https://example.com/health";

/**
 * The whole monitor, every time.
 *
 * GlitchTip's update handler assigns every field of the payload onto the
 * monitor, so a PUT is a replace and there is no partial edit — leaving
 * `timeout` out of an edit does not keep the old timeout, it sets it to
 * null. The form is prefilled and this always sends the full set.
 *
 * The one exception is `expectedStatus`, which must be absent rather than
 * null for the kinds that have no status to expect: GlitchTip requires it for
 * GET and POST and ignores it otherwise, and sending null for a Ping is
 * accepted today only because nothing reads it.
 */
export function monitorPayload(values) {
  const monitorType = knownType(values.monitorType);
  const number = (value, fallback = null) => {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    name: String(values.name || "").trim(),
    monitorType,
    url: needsUrl(monitorType) ? String(values.url || "").trim() : "",
    expectedStatus: needsExpectedStatus(monitorType) ? number(values.expectedStatus, 200) : null,
    expectedBody: needsExpectedBody(monitorType) ? String(values.expectedBody || "") : "",
    interval: number(values.interval, 60),
    timeout: number(values.timeout, null),
    confirmationThreshold: number(values.confirmationThreshold, 1),
    project: values.project ? String(values.project) : null,
  };
}

/**
 * What GlitchTip will refuse, said before it refuses it.
 *
 * Not a substitute for its validation — it is the authority and runs anyway —
 * but its 422 arrives as "Invalid Url" with no indication of which field, and
 * a form that can say so itself is a better place to find out.
 */
export function whatIsMissing(payload) {
  const problems = [];
  if (!payload.name) problems.push("Give it a name.");
  if (needsUrl(payload.monitorType) && !payload.url) {
    problems.push(`A ${payload.monitorType} monitor needs somewhere to look.`);
  }
  if (payload.monitorType === "TCP Port" && payload.url && !/^[^\s:]+:\d+$/.test(payload.url)) {
    problems.push("A port monitor wants a host and a port, like example.com:5432.");
  }
  if (!(payload.interval >= 1 && payload.interval <= 86400)) {
    problems.push("Check between once a second and once a day.");
  }
  if (payload.timeout !== null && !(payload.timeout >= 1 && payload.timeout <= 60)) {
    problems.push("A timeout is between 1 and 60 seconds, or blank.");
  }
  if (!(payload.confirmationThreshold >= 1 && payload.confirmationThreshold <= 100)) {
    problems.push("Confirm a failure between 1 and 100 times before believing it.");
  }
  return problems;
}

/** Seconds, as somebody would say them. */
export function every(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 1) return "—";
  if (value < 60) return `every ${value}s`;
  if (value < 3600) {
    const minutes = value / 60;
    return `every ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  if (value < 86400) {
    const hours = value / 3600;
    return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  return "every day";
}

/** Why a check failed, as apps/uptime/constants.py numbers them. */
const REASONS = ["Unknown", "Timed out", "Wrong status code", "Expected response not found",
  "SSL error", "Network error"];

export function checkReason(reason) {
  if (reason === null || reason === undefined || reason === "") return "";
  return REASONS[Number(reason)] || "Unknown";
}

/** Milliseconds, or nothing when the check never got an answer. */
export function responseTime(ms) {
  if (ms === null || ms === undefined || ms === "") return "—";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
