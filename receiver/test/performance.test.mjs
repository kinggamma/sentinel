/** Phase 8b contracts: readable numbers, and filters that survive the URL. */
import {
  duration,
  throughput,
  errorRate,
  count,
  readFilters,
  search,
  apiSearch,
  SORTS,
  RANGES,
} from "../public/lib/performance.js";

let passed = 0;
const failures = [];
function assert(value, message) { if (!value) throw new Error(message); }
const same = (got, want, what) => assert(Object.is(got, want), `${what}: ${got} !== ${want}`);
async function test(name, run) {
  try { await run(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}

process.stdout.write("\nPerformance\n");

await test("a duration is shown in the unit that makes it comparable", () => {
  /**
   * The column exists so two transactions can be compared at a glance, and
   * "45" beside "45000" is compared by counting digits.
   */
  same(duration(45.2), "45 ms", "tens of milliseconds");
  same(duration(4.52), "4.5 ms", "under ten keeps a decimal");
  same(duration(1234), "1.23 s", "past a second");
  same(duration(12340), "12.3 s", "past ten seconds");
  same(duration(125000), "2m 5s", "past a minute");
});

await test("something faster than a millisecond is not rounded away to zero", () => {
  // A fast span and a missing measurement must not look the same.
  same(duration(0.4), "400 µs", "microseconds");
  same(duration(0), "0 ms", "a real zero");
  same(duration(null), "—", "nothing measured");
  same(duration(undefined), "—", "nothing at all");
  same(duration(-1), "—", "impossible");
  same(duration("nonsense"), "—", "not a number");
});

await test("throughput under one a minute is said per hour", () => {
  same(throughput(240), "240/min", "busy");
  same(throughput(2.5), "2.5/min", "steady");
  same(throughput(0.3), "18.0/hr", "quiet");
  // Null is GlitchTip's own answer for a group too new to have a rate.
  same(throughput(null), "—", "not computable");
});

await test("counts are grouped, because they are read by comparing them", () => {
  same(count(98000), (98000).toLocaleString(), "grouped");
  same(count(0), "0", "zero is a count");
  same(count(null), "—", "unknown");
  same(count(undefined), "—", "absent");
});

await test("an error rate of zero is an answer, not a blank", () => {
  same(errorRate(0), "0%", "no errors is a fact worth stating");
  same(errorRate(0.04), "<0.1%", "too small to round honestly");
  same(errorRate(3.42), "3.4%", "single figures keep a decimal");
  same(errorRate(42.7), "43%", "past ten does not");
  same(errorRate(null), "—", "unknown");
});

await test("a hand-edited sort falls back rather than reaching GlitchTip", () => {
  /**
   * That query parameter is validated against a Literal at the other end, so
   * anything it does not recognise comes back 422 with an empty screen and
   * nothing to explain it.
   */
  same(readFilters({ sort: "-avg_duration" }).sort, "-avg_duration", "a real sort");
  same(readFilters({ sort: "; drop table" }).sort, "-avg_duration", "nonsense");
  same(readFilters({ sort: "duration" }).sort, "-avg_duration", "near miss");
  same(readFilters({}).sort, "-avg_duration", "nothing given");
  for (const one of SORTS) same(readFilters({ sort: one.value }).sort, one.value, one.value);
});

await test("so does a range", () => {
  same(readFilters({ range: "24h" }).range, "24h", "the default");
  same(readFilters({ range: "7d" }).range, "7d", "a week");
  same(readFilters({ range: "all" }).range, "all", "all time is a word, not an empty string");
  same(readFilters({ range: "" }).range, "24h", "empty means unset");
  same(readFilters({ range: "9y" }).range, "24h", "invented");
  for (const one of RANGES) same(readFilters({ range: one.value }).range, one.value, one.value);
});

await test("the address carries only what differs from the default", () => {
  // Otherwise every link is a wall of parameters that all say "as usual".
  same(search(readFilters({})), "", "defaults produce a bare address");
  same(search(readFilters({ sort: "-count" })), "?sort=-count", "a chosen sort");
  same(search(readFilters({ q: "checkout" })), "?q=checkout", "a search");
  same(search(readFilters({ range: "7d" })), "?range=7d", "a chosen range");
  same(search(readFilters({ range: "all" })), "?range=all", "all time is written down");
  same(search(readFilters({ range: "" })), "", "an empty range is the default, not a filter");
});

await test("what GlitchTip is asked for is not what the address says", () => {
  /**
   * Two vocabularies, deliberately not shared: ours is ?q= and ?range=,
   * GlitchTip's is ?query= and a start time it parses itself. Sending it our
   * names would filter nothing and look like a screen with no traffic.
   */
  const asked = new URLSearchParams(apiSearch(readFilters({ q: "checkout", range: "7d" })));
  same(asked.get("query"), "checkout", "query");
  same(asked.get("start"), "now-7d", "start");
  same(asked.get("q"), null, "our own name is not sent");
  same(asked.get("range"), null, "nor our own range");
  same(asked.get("sort"), "-avg_duration", "the sort is always stated");

  // All time means no start bound at all rather than start=now-.
  const all = new URLSearchParams(apiSearch(readFilters({ range: "all" })));
  same(all.get("start"), null, "no start for all time");
  same(new URLSearchParams(apiSearch(readFilters({}))).get("start"), "now-24h", "the default window");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
