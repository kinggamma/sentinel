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
  idle.touch("s1");
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
  idle.touch("busy");
  idle.touch("abandoned");
  await wait(80);
  idle.touch("busy");
  await wait(80);
  assert(!idle.isIdle("busy"), "the busy one was signed out");
  assert(idle.isIdle("abandoned"), "the abandoned one was not");
});

await test("forgetting one stops it being judged twice", async () => {
  const idle = await load(0.002);
  idle.touch("s2");
  await wait(160);
  assert(idle.isIdle("s2"), "it never went idle");
  idle.forgetIdle("s2");
  // Now unknown again, which is "just arrived" rather than "still idle" —
  // so the session it belongs to is not ended a second time.
  assert(!idle.isIdle("s2"), "a forgotten session was still idle");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
