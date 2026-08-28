/** Phase 8a contracts: the release update trap, and the small formatters. */
import {
  releaseUpdate,
  toLocalInput,
  fromLocalInput,
  fileSize,
  commitSubject,
  shortVersion,
} from "../public/lib/releases.js";

let passed = 0;
const failures = [];
function assert(value, message) { if (!value) throw new Error(message); }
const same = (got, want, what) => assert(Object.is(got, want), `${what}: ${got} !== ${want}`);
async function test(name, run) {
  try { await run(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}

process.stdout.write("\nReleases\n");

await test("an update always carries both fields, because omitting one rewrites it", () => {
  /**
   * GlitchTip's ReleaseUpdate defaults dateReleased to now and its handler
   * writes back every field the payload produced. A payload missing the date
   * therefore marks the release as shipped this second — so the one thing
   * this helper must never do is leave a key out.
   */
  const payload = releaseUpdate({ ref: "abc123", dateReleased: "2026-01-02T03:04:05.000Z" });
  same(Object.keys(payload).sort().join(","), "dateReleased,ref", "keys");
  same(payload.ref, "abc123", "ref");
  same(payload.dateReleased, "2026-01-02T03:04:05.000Z", "dateReleased");

  const empty = releaseUpdate();
  same(Object.keys(empty).sort().join(","), "dateReleased,ref", "keys with nothing given");
  same(empty.ref, null, "an absent ref is null, not missing");
  same(empty.dateReleased, null, "an absent date is null, which is how 'not released' is said");
});

await test("whitespace is not a ref", () => {
  same(releaseUpdate({ ref: "   " }).ref, null, "blank ref");
  same(releaseUpdate({ ref: "  v2  " }).ref, "v2", "trimmed ref");
});

await test("a date survives the round trip through the browser's own input", () => {
  const iso = new Date(2026, 0, 2, 3, 4, 0).toISOString();
  const local = toLocalInput(iso);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local), `shape: ${local}`);
  // Back to the same minute. Seconds are not in the input, so that is the
  // resolution the round trip can promise.
  same(new Date(fromLocalInput(local)).getTime(), new Date(iso).setSeconds(0, 0), "round trip");
});

await test("nothing unparseable reaches the screen as 'Invalid Date'", () => {
  same(toLocalInput(""), "", "empty");
  same(toLocalInput(null), "", "null");
  same(toLocalInput("not a date"), "", "nonsense");
  same(fromLocalInput(""), "", "empty back");
  same(fromLocalInput("nonsense"), "", "nonsense back");
});

await test("sizes read as sizes", () => {
  same(fileSize(0), "0 B", "zero");
  same(fileSize(900), "900 B", "under a kilobyte stays bytes");
  same(fileSize(1024), "1.0 kB", "exactly a kilobyte");
  same(fileSize(1536), "1.5 kB", "one and a half");
  same(fileSize(1024 * 1024 * 20), "20 MB", "past ten, no decimal");
  same(fileSize(undefined), "—", "nothing known");
  same(fileSize(-1), "—", "impossible");
});

await test("a commit shows its subject, whatever the message looks like", () => {
  same(commitSubject("Fix the thing\n\nA longer body"), "Fix the thing", "subject line");
  same(commitSubject("\n\n  Indented subject  \n"), "Indented subject", "leading blank lines");
  same(commitSubject(""), "(no message)", "no message");
  same(commitSubject(null), "(no message)", "null message");
});

await test("only something that is obviously a SHA gets shortened", () => {
  const sha = "a".repeat(40);
  same(shortVersion(sha), "a".repeat(12), "a git SHA");
  // The version is how somebody identifies their own release. Truncating
  // "2026.08.26-nightly-build-4471" would hide the part that differs.
  same(shortVersion("2026.08.26-nightly-build-4471"), "2026.08.26-nightly-build-4471", "a real version");
  same(shortVersion(""), "", "nothing");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
