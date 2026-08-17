#!/usr/bin/env node
/**
 * Which organisation you are looking at.
 *
 * This was `orgs[0]` for as long as every install had one organisation, and
 * the failure it caused for anyone with two is the quiet kind: the issue
 * list showed one organisation's errors, the sidebar named that organisation
 * as though it were the only one, and the other organisation's issues had no
 * address at all. Nothing errored. There was simply less data than there
 * should have been, presented as though it were all of it.
 *
 * The rule has three sources now and they are ordered, so the tests are
 * mostly about the order and about what happens when a source lies. A slug
 * in a URL is a request from whoever sent the link, not a fact — the list of
 * organisations the server reported is the only authority, and every source
 * is filtered through it.
 *
 *   node test/org.test.mjs
 */
import { activeOrg, withOrg, remember, remembered } from "../public/lib/org.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(got, wanted, message) {
  assert(got === wanted, `${message}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
}

/**
 * The module reaches for localStorage and copes when it is missing, which is
 * a real case — Safari's private mode throws on access rather than returning
 * null. Both are worth having here, so the store is installed and removed
 * around the tests that need it.
 */
function withStore(value) {
  const store = new Map(value === undefined ? [] : [["sentinel-org", value]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, next) => store.set(key, String(next)),
      removeItem: (key) => store.delete(key),
    },
  });
  return store;
}

function withoutStore() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage is disabled");
    },
  });
}

process.stdout.write("\nActive organisation\n");

// ------------------------------------------------------------- the ordering

test("with one organisation, that is the answer", () => {
  withStore();
  same(activeOrg({ orgs: ["only"] }), "only", "single organisation");
});

test("the URL wins, because a link has to open the same list for everyone", () => {
  withStore("remembered-one");
  same(
    activeOrg({ orgs: ["remembered-one", "asked-for"], query: { org: "asked-for" } }),
    "asked-for",
    "explicit request"
  );
});

test("without a URL, this browser's last choice wins", () => {
  withStore("second");
  same(activeOrg({ orgs: ["first", "second"] }), "second", "remembered choice");
});

test("with neither, the first organisation", () => {
  withStore();
  same(activeOrg({ orgs: ["first", "second"] }), "first", "no preference");
});

// -------------------------------------------------------- what it refuses

test("a URL naming an organisation you are not in is ignored, not obeyed", () => {
  withStore();
  same(activeOrg({ orgs: ["mine"], query: { org: "someone-elses" } }), "mine", "unknown slug");
});

test("an organisation you have been removed from stops being remembered", () => {
  withStore("used-to-be-in-this");
  same(activeOrg({ orgs: ["still-in-this"] }), "still-in-this", "stale memory");
});

test("belonging to nothing is null, not an invented organisation", () => {
  withStore("something");
  same(activeOrg({ orgs: [] }), null, "no organisations");
  same(activeOrg({}), null, "nothing said at all");
});

test("storage that throws on read is not a broken screen", () => {
  withoutStore();
  same(activeOrg({ orgs: ["first", "second"] }), "first", "storage unavailable");
  same(remembered(), null, "reading through a throwing store");
  remember("second"); // must not throw
  withStore();
});

// ------------------------------------------------------------- writing links

test("a link keeps its organisation when there is a choice to express", () => {
  same(withOrg("/issues", "second", { orgs: ["first", "second"] }), "/issues?org=second", "bare path");
});

test("a link says nothing when there is only one organisation", () => {
  same(withOrg("/issues", "only", { orgs: ["only"] }), "/issues", "single organisation");
  same(withOrg("/issues", "only", {}), "/issues", "orgs not supplied");
});

test("the organisation joins the query rather than replacing it", () => {
  same(
    withOrg("/issues?q=is:unresolved&range=14d", "second", { orgs: ["first", "second"] }),
    "/issues?q=is%3Aunresolved&range=14d&org=second",
    "existing filters"
  );
});

test("switching organisation replaces the one already in the address", () => {
  same(
    withOrg("/issues?org=first", "second", { orgs: ["first", "second"] }),
    "/issues?org=second",
    "already carried one"
  );
});

test("a fragment stays at the end, where it has to be", () => {
  same(
    withOrg("/issues/4#stack", "second", { orgs: ["first", "second"] }),
    "/issues/4?org=second#stack",
    "path with a fragment"
  );
});

test("no organisation to name leaves the link alone", () => {
  same(withOrg("/issues", null, { orgs: ["first", "second"] }), "/issues", "nothing chosen");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
