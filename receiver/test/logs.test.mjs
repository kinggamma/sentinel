/** Phase 8c contracts: the level ladder, and two vocabularies for one filter. */
import {
  LEVELS,
  normaliseLevel,
  atLeast,
  readFilters,
  search,
  apiSearch,
  summarise,
  hasMore,
} from "../public/lib/logs.js";

let passed = 0;
const failures = [];
function assert(value, message) { if (!value) throw new Error(message); }
const same = (got, want, what) => assert(Object.is(got, want), `${what}: ${got} !== ${want}`);
async function test(name, run) {
  try { await run(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}

process.stdout.write("\nLogs\n");

await test("the levels are GlitchTip's, in GlitchTip's order", () => {
  // Ranked rather than alphabetical, because the whole filter depends on
  // "and worse" meaning something.
  same(LEVELS.join(","), "trace,debug,info,warn,error,fatal", "the ladder");
});

await test("'warning' is accepted going in and never comes back out", () => {
  /**
   * GlitchTip's LEVEL_MAP takes both spellings and its schema only ever emits
   * "warn". A screen that stored what it was handed would have a filter
   * matching nothing on a row it had just displayed.
   */
  same(normaliseLevel("warning"), "warn", "the long spelling");
  same(normaliseLevel("WARNING"), "warn", "shouted");
  same(normaliseLevel("Warn"), "warn", "capitalised");
  same(normaliseLevel("critical"), "", "not one of GlitchTip's");
  same(normaliseLevel(null), "", "nothing");
});

await test("a level filter means that level and everything worse", () => {
  same(atLeast("warn").join(","), "warn,error,fatal", "warn and worse");
  same(atLeast("warning").join(","), "warn,error,fatal", "the same, spelled the other way");
  same(atLeast("trace").join(","), LEVELS.join(","), "everything");
  same(atLeast("fatal").join(","), "fatal", "the top of the ladder");
  same(atLeast("").join(","), "", "no filter is not the same as trace and worse");
  same(atLeast("nonsense").join(","), "", "unrecognised filters nothing");
});

await test("GlitchTip is asked one parameter per level, not a minimum", () => {
  /**
   * Its filter schema takes `level: list[str]`. Sending "warn" alone would
   * hide the errors and fatals the person asked to see, which is the exact
   * opposite of what "warn and worse" means.
   */
  const asked = new URLSearchParams(apiSearch(readFilters({ level: "warn" })));
  same(asked.getAll("level").join(","), "warn,error,fatal", "three levels");
  same(new URLSearchParams(apiSearch(readFilters({}))).getAll("level").length, 0, "no level, no parameter");
});

await test("a trace lifts the time window rather than being trapped inside it", () => {
  /**
   * The rest of a request is not necessarily inside the window the one line
   * was found in — a slow trace can straddle it — so asking for a trace and
   * then bounding it to the last hour is how half a request goes missing.
   */
  const trace = new URLSearchParams(apiSearch(readFilters({ trace: "abc", range: "1h" })));
  same(trace.get("traceId"), "abc", "GlitchTip's own spelling");
  same(trace.get("start"), null, "no window while following a trace");

  const ordinary = new URLSearchParams(apiSearch(readFilters({ range: "1h" })));
  same(ordinary.get("start"), "now-1h", "the window otherwise");
});

await test("the address carries only what was chosen", () => {
  same(search(readFilters({})), "", "nothing chosen");
  same(search(readFilters({ range: "24h" })), "", "the default window is not written down");
  same(search(readFilters({ level: "error" })), "?level=error", "a level");
  same(search(readFilters({ level: "warning" })), "?level=warn", "normalised on the way in");
  same(search(readFilters({ range: "7d" })), "?range=7d", "a chosen window");
  same(search(readFilters({}), { cursor: "abc" }), "?cursor=abc", "a page");
});

await test("a row shows a first line, and never breaks a word to do it", () => {
  same(summarise("first line\nsecond line"), "first line", "one line only");
  same(summarise("\n\n  indented  \n"), "indented", "leading blank lines");
  same(summarise(""), "(empty)", "nothing logged");

  const long = `${"word ".repeat(60)}end`;
  const short = summarise(long);
  assert(short.length <= 161, `too long: ${short.length}`);
  assert(short.endsWith("…"), "no ellipsis");
  assert(!short.slice(0, -1).endsWith(" "), "trailing space before the ellipsis");
  // Cut at a space, so the last thing shown is a whole word.
  assert(long.startsWith(short.slice(0, -1)), "the summary is not a prefix of the body");
});

await test("and says when there is more than it showed", () => {
  assert(!hasMore("short one"), "a short line is complete");
  assert(hasMore("first line\nsecond line"), "a second line is more");
  assert(hasMore("x".repeat(400)), "a long line is more");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
