/** Phase 8d contracts: a monitor's shape follows its kind, and a PUT replaces. */
import {
  MONITOR_TYPES,
  knownType,
  needsUrl,
  needsExpectedStatus,
  monitorPayload,
  whatIsMissing,
  every,
  checkReason,
  responseTime,
} from "../public/lib/uptime.js";

let passed = 0;
const failures = [];
function assert(value, message) { if (!value) throw new Error(message); }
const same = (got, want, what) => assert(Object.is(got, want), `${what}: ${got} !== ${want}`);
async function test(name, run) {
  try { await run(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}

process.stdout.write("\nUptime\n");

await test("the kinds are GlitchTip's own values, not our labels", () => {
  /**
   * These strings are stored, not displayed: MonitorType is a TextChoices
   * whose values are "Ping", "GET", "TCP Port" and so on. Sending a tidied
   * "tcp_port" would be refused by a schema that never says which field.
   */
  same(MONITOR_TYPES.map((one) => one.value).join(","), "Ping,GET,POST,TCP Port,SSL,Heartbeat", "values");
  same(knownType("Heartbeat"), "Heartbeat", "a real kind");
  same(knownType("heartbeat"), "GET", "case matters to GlitchTip, so it matters here");
  same(knownType("invented"), "GET", "unknown falls back rather than being forwarded");
});

await test("a heartbeat has nowhere to look, and the others do", () => {
  assert(!needsUrl("Heartbeat"), "a heartbeat calls in");
  for (const kind of ["Ping", "GET", "POST", "TCP Port", "SSL"]) {
    assert(needsUrl(kind), `${kind} needs somewhere to look`);
  }
  // Only the two that read a response can be told what response to expect.
  assert(needsExpectedStatus("GET") && needsExpectedStatus("POST"), "GET and POST expect a status");
  for (const kind of ["Ping", "TCP Port", "SSL", "Heartbeat"]) {
    assert(!needsExpectedStatus(kind), `${kind} has no status to expect`);
  }
});

await test("the payload carries every field, because the update replaces them all", () => {
  /**
   * GlitchTip's update handler assigns every key of the payload onto the
   * monitor. Leaving one out does not keep the old value, it writes the
   * schema's default over it — so an edit that only meant to rename a
   * monitor would clear its timeout.
   */
  const payload = monitorPayload({ name: "Checkout", monitorType: "GET", url: "https://example.com/",
    expectedStatus: "200", expectedBody: "ok", interval: "60", timeout: "10",
    confirmationThreshold: "2", project: "7" });
  same(Object.keys(payload).sort().join(","),
    "confirmationThreshold,expectedBody,expectedStatus,interval,monitorType,name,project,timeout,url",
    "every key, every time");
  same(payload.interval, 60, "numbers are numbers, not the strings an input gave us");
  same(payload.timeout, 10, "timeout");
  same(payload.confirmationThreshold, 2, "threshold");
  same(payload.project, "7", "project id");
});

await test("a heartbeat drops the fields it has no use for", () => {
  // Typed into the URL box before switching kind, and it must not be sent:
  // GlitchTip stores whatever it is given, and a heartbeat with a URL reads
  // like something that is being called out to.
  const payload = monitorPayload({ name: "Nightly", monitorType: "Heartbeat",
    url: "https://left-over.example.com/", expectedStatus: "500", interval: "86400" });
  same(payload.url, "", "no url");
  same(payload.expectedStatus, null, "no status");
  same(payload.expectedBody, "", "no body");
  same(payload.interval, 86400, "once a day");
});

await test("an empty timeout is none rather than zero", () => {
  // Zero would mean "give up immediately", which is not what a blank field
  // asks for — and GlitchTip's own bound starts at 1.
  same(monitorPayload({ name: "x", monitorType: "Ping", url: "https://example.com/", timeout: "" }).timeout,
    null, "blank");
  same(monitorPayload({ name: "x", monitorType: "Ping", url: "https://example.com/", timeout: "  " }).timeout,
    null, "spaces");
});

await test("what GlitchTip would refuse is said before it refuses it", () => {
  /**
   * Its 422 arrives as "Invalid Url" with no indication of which field it
   * meant, and for a form with nine of them that is not an answer.
   */
  const of = (values) => whatIsMissing(monitorPayload(values));
  same(of({ name: "", monitorType: "GET", url: "https://example.com/" }).length, 1, "a nameless monitor");
  same(of({ name: "x", monitorType: "GET", url: "" }).length, 1, "an http monitor with nowhere to look");
  same(of({ name: "x", monitorType: "Heartbeat" }).length, 0, "a heartbeat needs no url");
  same(of({ name: "x", monitorType: "TCP Port", url: "example.com" }).length, 1, "a port monitor with no port");
  same(of({ name: "x", monitorType: "TCP Port", url: "example.com:5432" }).length, 0, "with one");
  same(of({ name: "x", monitorType: "Ping", url: "https://example.com/", interval: "0" }).length, 1, "never");
  same(of({ name: "x", monitorType: "Ping", url: "https://example.com/", interval: "999999" }).length, 1, "too rare");
  same(of({ name: "x", monitorType: "Ping", url: "https://example.com/", timeout: "90" }).length, 1, "too patient");
  same(of({ name: "x", monitorType: "Ping", url: "https://example.com/", timeout: "" }).length, 0, "or none at all");
});

await test("an interval reads as a person would say it", () => {
  same(every(30), "every 30s", "seconds");
  same(every(300), "every 5m", "minutes");
  same(every(5400), "every 1.5h", "hours and a half");
  same(every(86400), "every day", "a day");
  same(every(0), "—", "impossible");
});

await test("a failed check says why, in GlitchTip's own numbering", () => {
  same(checkReason(1), "Timed out", "timeout");
  same(checkReason(2), "Wrong status code", "status");
  same(checkReason(3), "Expected response not found", "body");
  same(checkReason(0), "Unknown", "unknown is a reason it gives");
  same(checkReason(null), "", "no reason at all is not 'Unknown'");
  same(checkReason(99), "Unknown", "a reason from a newer GlitchTip");
});

await test("a check that never got an answer has no response time", () => {
  same(responseTime(240), "240 ms", "milliseconds");
  same(responseTime(1500), "1.50 s", "past a second");
  same(responseTime(null), "—", "never answered");
  same(responseTime(0), "0 ms", "answered instantly is not the same as never");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
