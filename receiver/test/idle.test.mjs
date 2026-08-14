#!/usr/bin/env node
/**
 * The idle window, without waiting minutes for it.
 *
 * SESSION_IDLE_MINUTES is read once when the module loads, so each case here
 * sets it and then imports a fresh copy. Fractions of a minute are legal and
 * make the whole thing take milliseconds — 0.002 minutes is 120ms, which is
 * long enough to be a real elapsed window and short enough to test.
 */
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh copy of the module, with the environment it should read. */
let loaded = 0;
async function load(minutes) {
  process.env.SESSION_IDLE_MINUTES = String(minutes);
  loaded += 1;
  return import(`../src/auth/idle.js?copy=${loaded}`);
}

process.stdout.write("\nSigning out a session nobody is using\n");

await test("off unless somebody asks for it", async () => {
  const idle = await load(0);
  assert(!idle.idleEnabled, "it switched itself on");
  assert(!idle.isIdle("any-session"), "it expired a session with idling off");
  assert(idle.idleWindowMs() === 0, "it reported a window");
});

await test("a session it has never seen is not idle", async () => {
  // Otherwise every deploy signs out everybody who was signed in before it,
  // and every session that predates the setting being switched on.
  const idle = await load(10);
  assert(!idle.isIdle("brand-new-session"), "an unseen session was treated as idle");
});

await test("it goes idle only after the window, and touching resets it", async () => {
  const idle = await load(0.002); // 120ms
  idle.begin("s1");
  assert(!idle.isIdle("s1"), "idle immediately after being touched");

  await wait(70);
  idle.touch("s1");
  await wait(70);
  // 140ms since the first touch, but only 70ms since the last one.
  assert(!idle.isIdle("s1"), "a touched session went idle anyway");

  await wait(90);
  assert(idle.isIdle("s1"), "it never went idle");
});

await test("one session going idle says nothing about another", async () => {
  const idle = await load(0.002);
  idle.begin("busy");
  idle.begin("abandoned");
  await wait(80);
  idle.touch("busy");
  await wait(80);
  assert(!idle.isIdle("busy"), "the busy one was signed out");
  assert(idle.isIdle("abandoned"), "the abandoned one was not");
});

await test("coming back after the window does not restart the clock", async () => {
  /**
   * The bypass. Returning to a tab is activity, so the browser reports it —
   * and if that report is taken at face value, the report itself is what
   * saves the session that had already gone stale. Leave a tab open
   * overnight, glance at it in the morning, and the timeout has never once
   * fired.
   *
   * A session past the window stays past it. Only the next look at it can
   * end it; nothing a browser says may bring it back.
   */
  const idle = await load(0.002);
  idle.begin("returning");
  await wait(160);

  idle.touch("returning"); // "I'm back!"
  assert(idle.isIdle("returning"), "a touch after the window revived the session");
});

await test("forgetting one is what stops it being ended twice", async () => {
  const idle = await load(0.002);
  idle.begin("s2");
  await wait(160);
  assert(idle.isIdle("s2"), "it never went idle");
  idle.forgetIdle("s2");
  // Now unknown again, which is "just arrived" rather than "still idle" —
  // so the session it belongs to is not ended a second time.
  assert(!idle.isIdle("s2"), "a forgotten session was still idle");
});

await test("keeping the record is what keeps a failed revocation refused", async () => {
  /**
   * The other half of the same coin, and the reason forgetting is conditional
   * at the call site: an unknown session reads as newly arrived, so dropping
   * the record for one that is *still alive at GlitchTip* — which is exactly
   * what a failed revocation means — would hand it a fresh window and
   * authenticate it again on the very next request.
   *
   * Held on to, it stays idle, keeps answering "expired", and every later
   * request tries the revoke again.
   */
  const idle = await load(0.002);
  idle.begin("stubborn");
  await wait(160);
  assert(idle.isIdle("stubborn"), "it never went idle");

  // No forgetIdle() — the revoke failed.
  assert(idle.isIdle("stubborn"), "it stopped being idle without being forgotten");
  idle.touch("stubborn"); // and a heartbeat still cannot rescue it
  assert(idle.isIdle("stubborn"), "a heartbeat revived a session we failed to end");
});

await test("a crowd of strangers cannot evict a tombstone", async () => {
  /**
   * The two fixes above disagreed with each other.
   *
   * Keeping the record of an idle session is what keeps it refused — and the
   * map's own housekeeping deleted exactly those records, on the reasoning
   * that a session idle long ago "says nothing that the absence of an entry
   * doesn't". Once absence came to mean "newly arrived", that reasoning was
   * false, and the sweep became a way to resurrect any session: fill the map
   * with strangers until it trips, and the tombstones go with them.
   *
   * The strangers arrive through /auth/touch, which reads a cookie before
   * anybody has checked whether it means anything, so they cost nothing to
   * invent.
   */
  const idle = await load(0.002);
  idle.begin("victim");
  await wait(160);
  assert(idle.isIdle("victim"), "the session under test never went idle");

  for (let i = 0; i < 1200; i += 1) idle.touch(`stranger-${i}`);

  assert(idle.isIdle("victim"), "pressure on the map revived an expired session");
  // And they never got in at all: only the victim is tracked.
  assert(
    idle.trackedCount() === 1,
    `strangers were recorded: ${idle.trackedCount()} sessions tracked`
  );
});

await test("only a resolved session gets a record", async () => {
  // The rule everything else rests on. A cookie is whatever the sender says
  // it is, and /auth/touch reads one before anybody has established what it
  // refers to — so a report may refresh, and may never create.
  const idle = await load(10);
  idle.touch("invented-by-a-stranger");
  assert(idle.trackedCount() === 0, "a touch created a record");

  idle.begin("resolved-against-glitchtip");
  assert(idle.trackedCount() === 1, "a resolved session was not recorded");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
