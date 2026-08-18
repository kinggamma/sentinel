#!/usr/bin/env node
/**
 * Getting a CSRF token, on both of the mounts this app is served at.
 *
 * The client used to read `csrftoken` out of document.cookie and send
 * whatever it found, including nothing. Nothing was the common case for any
 * session that had not just come through allauth, and Django answers a
 * tokenless session write with a bare 403 — so the screen offered its
 * buttons and every one of them failed silently. It now fetches a token when
 * it has none.
 *
 * Which is right behind the shared origin, where allauth answers, and
 * pointless on the receiver's own port, where it does not. The difference
 * matters more than it looks: without it every write on the standalone mount
 * starts a doomed request first, forever, because the cookie it is waiting
 * for is never going to appear.
 *
 * These stub fetch and document.cookie rather than a browser, because what
 * is being tested is entirely about which requests get made and what header
 * comes out — and a real browser would make that harder to see, not easier.
 *
 *   node test/csrf.test.mjs
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

function same(got, wanted, message) {
  assert(got === wanted, `${message}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
}

/**
 * One mount, as the browser sees it.
 *
 * `allauth` decides which of the two this is: an object means the shared
 * origin, where a GET to the capability document answers and leaves a
 * cookie behind; null means the receiver's own port, where it 404s.
 */
function mount({ allauth = { sets: "tok-1" }, cookie = "" } = {}) {
  const calls = [];
  let jar = cookie;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return jar;
      },
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {} });

    if (url.includes("/_allauth/browser/v1/config")) {
      if (!allauth) return { status: 404, ok: false, text: async () => "" };
      if (allauth.throws) throw new TypeError("offline");
      if (allauth.status && allauth.status !== 200) {
        return { status: allauth.status, ok: false, text: async () => "" };
      }
      if (allauth.sets) jar = `csrftoken=${allauth.sets}`;
      return { status: 200, ok: true, text: async () => "{}" };
    }

    return { status: 200, ok: true, text: async () => "{}" };
  };

  return {
    calls,
    writes: () => calls.filter((c) => c.method !== "GET"),
    mints: () => calls.filter((c) => c.url.includes("/_allauth/")),
    setCookie: (value) => {
      jar = value;
    },
  };
}

/** api.js keeps its "can this origin mint?" answer in module state, so each
 *  case needs its own copy of the module. */
let cacheBust = 0;
async function freshApi() {
  cacheBust += 1;
  return import(`../public/lib/api.js?case=${cacheBust}`);
}

process.stdout.write("\nCSRF tokens, per mount\n");

// -------------------------------------------------- behind the shared origin

await test("a token already in the jar is used without asking for one", async () => {
  const world = mount({ cookie: "csrftoken=already-here" });
  const { sentinel } = await freshApi();

  await sentinel.post("/settings", { a: 1 });

  same(world.mints().length, 0, "asked for a token it already had");
  same(world.writes()[0].headers["x-csrftoken"], "already-here", "the header");
});

await test("a missing token is fetched, and the write carries it", async () => {
  const world = mount({ cookie: "" });
  const { sentinel } = await freshApi();

  await sentinel.post("/settings", { a: 1 });

  same(world.mints().length, 1, "should have asked allauth exactly once");
  same(world.writes()[0].headers["x-csrftoken"], "tok-1", "the header");
});

await test("concurrent writes share one request rather than each starting their own", async () => {
  const world = mount({ cookie: "" });
  const { sentinel } = await freshApi();

  await Promise.all([
    sentinel.post("/settings", { a: 1 }),
    sentinel.post("/settings", { b: 2 }),
    sentinel.del("/settings/3"),
  ]);

  same(world.mints().length, 1, "one mint for three writes");
  for (const write of world.writes()) {
    same(write.headers["x-csrftoken"], "tok-1", "every write carries the token");
  }
});

await test("a GET never asks for a token, because it never needs one", async () => {
  const world = mount({ cookie: "" });
  const { sentinel } = await freshApi();

  await sentinel.get("/projects");

  same(world.mints().length, 0, "a read asked for a write token");
});

// ------------------------------------------------ on the receiver's own port

await test("where allauth does not exist, it asks once and then stops asking", async () => {
  const world = mount({ allauth: null, cookie: "" });
  const { sentinel } = await freshApi();

  await sentinel.post("/settings", { a: 1 });
  await sentinel.post("/settings", { b: 2 });
  await sentinel.del("/settings/3");

  same(world.mints().length, 1, "a 404 is permanent — it should not be re-asked per write");
  same(world.writes().length, 3, "the writes themselves still went");
  same(world.writes()[2].headers["x-csrftoken"], "", "no token to send, and none pretended");
});

await test("a bearer-authenticated caller never asks at all", async () => {
  // The embedded viewer: authenticated by header, exempt by construction,
  // and on the mount where asking would 404 anyway.
  const world = mount({ allauth: null, cookie: "" });
  const { sentinel, useBearerToken } = await freshApi();

  useBearerToken("shared-token");
  await sentinel.post("/settings", { a: 1 });
  useBearerToken("");

  same(world.mints().length, 0, "a bearer write went looking for a CSRF token");
  same(world.writes()[0].headers.authorization, "Bearer shared-token", "the bearer header");
});

// ------------------------------------------------------- transient failures

await test("being offline is not remembered as 'this origin cannot mint'", async () => {
  const world = mount({ allauth: { throws: true }, cookie: "" });
  const { sentinel } = await freshApi();

  await sentinel.post("/settings", { a: 1 });
  same(world.mints().length, 1, "first attempt");

  await sentinel.post("/settings", { b: 2 });
  same(world.mints().length, 2, "a network blip should be retried, not latched");
});

await test("a token arriving late is picked up without another request", async () => {
  const world = mount({ allauth: { throws: true }, cookie: "" });
  const { sentinel } = await freshApi();

  await sentinel.post("/settings", { a: 1 });
  // Signing in elsewhere in the app is exactly how this happens.
  world.setCookie("csrftoken=arrived-later");
  await sentinel.post("/settings", { b: 2 });

  same(world.mints().length, 1, "asked again despite having a token");
  same(world.writes()[1].headers["x-csrftoken"], "arrived-later", "the newer token");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
