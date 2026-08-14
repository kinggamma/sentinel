#!/usr/bin/env node
/**
 * Smoke tests for the running stack.
 *
 * Not unit tests: they drive a real Caddy, a real receiver and a real
 * GlitchTip, because the things that have actually broken here were never
 * inside a function. They were a CSRF header nobody sent, a URL space two
 * backends both claimed, and a guard mounted where it intercepted every
 * request. None of those are visible without the whole stack up.
 *
 * Run:  npm run smoke            (from receiver/)
 *       BASE_URL=http://host:8100 npm run smoke
 *
 * Also checks the standalone port (no /sentinel prefix) at STANDALONE_URL,
 * default http://localhost:4000 — skipped rather than failed if it can't be
 * reached, since a remote BASE_URL may have no route to it at all.
 *
 * The staff token is read from ../.env unless STAFF_API_TOKEN is set. A
 * GlitchTip session can be seeded with scripts/seed-smoke-session.sh and
 * passed as GLITCHTIP_SESSION to unlock the session and CSRF checks; without
 * it those are skipped rather than failed, so the suite still runs on a
 * machine with no shell access to the containers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const here = path.dirname(fileURLToPath(import.meta.url));

function staffToken() {
  if (process.env.STAFF_API_TOKEN) return process.env.STAFF_API_TOKEN;
  try {
    const env = readFileSync(path.join(here, "..", "..", ".env"), "utf8");
    return env.match(/^STAFF_API_TOKEN=(.*)$/m)?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

const TOKEN = staffToken();
const SESSION = process.env.GLITCHTIP_SESSION || "";
// Handed over with the session rather than written down here: the suite has
// to write to a real organisation, and naming one in the repo would put a
// particular installation's own organisation in a public file.
const ORG = process.env.GLITCHTIP_ORG || "";

let passed = 0;
const failures = [];
const skipped = [];

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === "skip") {
      skipped.push(name);
      process.stdout.write(`  ~ ${name} (skipped)\n`);
      return;
    }
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStatus(response, expected, context = "") {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(
    allowed.includes(response.status),
    `${context || response.url} answered ${response.status}, wanted ${allowed.join(" or ")}`
  );
}

const get = (path, init) => fetch(`${BASE}${path}`, { redirect: "manual", ...init });
const bearer = { authorization: `Bearer ${TOKEN}` };

// Its own port, no /sentinel prefix — a second root the shell has to work
// from, not just the proxied one BASE points at. Optional: a remote BASE
// may have no way to reach this port at all, so unreachable skips rather
// than fails.
const STANDALONE = (process.env.STANDALONE_URL || "http://localhost:4000").replace(/\/+$/, "");
const getStandalone = (path, init) => fetch(`${STANDALONE}${path}`, { redirect: "manual", ...init });

// --------------------------------------------------------------- the shell

async function shellServed() {
  process.stdout.write("\nThe viewer is served\n");

  await check("the bare address lands in Sentinel", async () => {
    const res = await get("/");
    assertStatus(res, [301, 302]);
    assert(
      (res.headers.get("location") || "").includes("/sentinel"),
      `redirects to ${res.headers.get("location")}, wanted /sentinel/`
    );
  });

  for (const route of [
    "/sentinel/",
    "/sentinel/issues",
    "/sentinel/settings/teams",
    "/sentinel/requests",
    "/sentinel/settings",
    "/sentinel/settings/apps/e-library-admin",
    // Reports, the last screen to stop being a mode of "/" — one app's list,
    // and one report inside it. Both are two segments deep or more, which is
    // where the <base> assertion below earns its place.
    // Issues, with its filters and page cursor in the query string — the
    // deep one is what a reload of page two of a filtered list asks for.
    "/sentinel/issues",
    "/sentinel/issues?q=is%3Aresolved&sort=-count&cursor=abc",
    "/sentinel/issues/123456",
    "/sentinel/reports/e-library-admin",
    "/sentinel/reports/e-library-admin/2f8a1c",
  ]) {
    await check(`${route} serves the shell`, async () => {
      const res = await get(route, { headers: { accept: "text/html" } });
      assertStatus(res, 200, route);
      const body = await res.text();
      assert(body.includes("<title>Sentinel</title>"), `${route} did not return the shell`);
      // Every asset reference in the shell is relative, so a wrong or
      // unfilled <base> is invisible here (this suite has no browser to
      // resolve URLs against) but breaks every route two segments deep —
      // it did, in exactly this form, before this check existed.
      assert(body.includes('<base href="/sentinel/" />'), `${route}: <base> is missing or wrong`);
      // app.js reads this instead of recomputing it from location.pathname —
      // one rule, on the server, not two copies of the same rule drifting.
      assert(
        body.includes('<meta name="sentinel-mount" content="/sentinel" />'),
        `${route}: mount meta tag is missing or wrong`
      );
      assert(!body.includes("__SENTINEL_BASE__"), `${route}: <base> placeholder was never filled in`);
      assert(!body.includes("__SENTINEL_MOUNT__"), `${route}: mount placeholder was never filled in`);
    });
  }

  await check("a missing asset 404s rather than returning the shell", async () => {
    const res = await get("/sentinel/definitely-not-here.js");
    assertStatus(res, 404);
  });

  for (const asset of [
    "styles.css",
    "app.js",
    "lib/api.js",
    "lib/dom.js",
    "lib/router.js",
    "lib/abort.js",
    "views/requests.js",
    "views/settings.js",
    "views/projects.js",
    "views/reports.js",
    "views/issues.js",
  ]) {
    await check(`${asset} is served`, async () => {
      assertStatus(await get(`/sentinel/${asset}`), 200, asset);
    });
  }
}

// --------------------------------------------------- standalone (no /sentinel)

/**
 * The same shell, at its other root. This is where the deep-route bug
 * actually lived: BASE (proxied, under /sentinel) happened to still work
 * for a one-segment route by the accident of relative paths dropping only
 * the last path segment, which made it easy to believe the fix was done
 * after testing only that root. The bare root has no such accident — a
 * wrong <base> here is wrong from the very first asset.
 */
async function standaloneMode() {
  process.stdout.write("\nStandalone, at its own port with no /sentinel prefix\n");

  const reachable = await getStandalone("/health")
    .then((res) => res.ok)
    .catch(() => false);
  if (!reachable) {
    process.stdout.write(`  (${STANDALONE} not reachable — standalone checks will skip)\n`);
  }

  await check('root serves the shell with <base href="/"> and an empty mount', async () => {
    if (!reachable) return "skip";
    const res = await getStandalone("/", { headers: { accept: "text/html" } });
    assertStatus(res, 200);
    const body = await res.text();
    assert(body.includes("<title>Sentinel</title>"), "did not return the shell");
    assert(body.includes('<base href="/" />'), "<base> is missing or wrong at the bare root");
    assert(
      body.includes('<meta name="sentinel-mount" content="" />'),
      "mount meta tag should be empty at the bare root, not \"/sentinel\""
    );
  });

  await check("styles.css and app.js resolve at the bare root", async () => {
    if (!reachable) return "skip";
    assertStatus(await getStandalone("/styles.css"), 200, "styles.css");
    assertStatus(await getStandalone("/app.js"), 200, "app.js");
  });

  // The actual bug this file exists to catch: a route two segments deep,
  // reloaded or bookmarked, used to serve a blank page — app.js itself
  // 404'd, resolved against the wrong root, and nothing after it ran.
  // The embedded viewer boots here, at ?app=&embed=1, and now navigates
  // itself to /reports/:app — so a reload inside that iframe asks this root
  // for a path it never used to be asked for.
  await check("the embedded viewer's own route serves the shell standalone", async () => {
    const res = await getStandalone("/reports/e-library-admin?app=e-library-admin&embed=1", {
      headers: { accept: "text/html" },
    });
    assertStatus(res, 200);
    const body = await res.text();
    assert(body.includes("<title>Sentinel</title>"), "embedded reports route did not return the shell");
    assert(body.includes('<base href="/" />'), "standalone <base> is missing or wrong");
  });

  await check("a deep client route serves the shell at the bare root too", async () => {
    if (!reachable) return "skip";
    const res = await getStandalone("/settings/apps/mewaka-lms", { headers: { accept: "text/html" } });
    assertStatus(res, 200);
    const body = await res.text();
    assert(body.includes("<title>Sentinel</title>"), "deep standalone route did not return the shell");
    assert(body.includes('<base href="/" />'), "deep standalone route: <base> is missing or wrong");
    assert(
      body.includes('<meta name="sentinel-mount" content="" />'),
      "deep standalone route: mount meta tag is missing or wrong"
    );
  });

  await check("a missing asset 404s at the bare root too", async () => {
    if (!reachable) return "skip";
    assertStatus(await getStandalone("/definitely-not-here.js"), 404);
  });
}

// ------------------------------------------------- which backend answers

async function backendsOwnTheirPaths() {
  process.stdout.write("\nEach backend keeps its own URL space\n");

  await check("/api/settings/ is GlitchTip's, not the receiver's", async () => {
    const res = await get("/api/settings/");
    assertStatus(res, 200);
    const body = await res.json();
    assert(
      "socialApps" in body || "enableUserRegistration" in body,
      "answered, but not with GlitchTip's settings payload — the receiver has taken the path over"
    );
  });

  await check("/api/0/ is GlitchTip's", async () => {
    assertStatus(await get("/api/0/organizations/"), [200, 401, 403]);
  });

  await check("/sentinel/api/auth/config is the receiver's", async () => {
    const res = await get("/sentinel/api/auth/config");
    assertStatus(res, 200);
    const body = await res.json();
    assert("glitchtipEnabled" in body, "not the receiver's auth config");
  });

  await check("report intake is the receiver's, and still accepts a report", async () => {
    if (!TOKEN) return "skip";
    const form = new FormData();
    form.set("appName", "smoke-test-suite");
    form.set("note", "posted by the smoke tests");
    form.set("source", "staff-report");
    const res = await fetch(`${BASE}/api/reports`, { method: "POST", headers: bearer, body: form });
    assertStatus(res, 201, "POST /api/reports");
    const { id } = await res.json();

    // Leave nothing behind: a suite that litters is a suite people stop running.
    const cleanup = await fetch(`${BASE}/sentinel/api/reports/${id}`, {
      method: "DELETE",
      headers: bearer,
    });
    assertStatus(cleanup, [204, 200], "cleanup of the posted report");
  });

  await check("/api/reports is matched exactly, not as a prefix", async () => {
    // /api/reportsomething must not reach the receiver — it would mean the
    // matcher is a wildcard and could swallow GlitchTip paths.
    const res = await get("/api/reportsomething");
    assert(res.status !== 201, "a made-up /api/reports* path reached the receiver");
  });
}

// ------------------------------------------------------------ who may read

async function authBoundaries() {
  process.stdout.write("\nAuthentication boundaries\n");

  await check("the receiver refuses an anonymous caller", async () => {
    assertStatus(await get("/sentinel/api/projects"), 401);
  });

  await check("/auth/me answers with a state rather than refusing", async () => {
    // It is a read-only view of the one session there is, and "nobody is
    // signed in" is an answer. Refusing would also make the client's own
    // central 401 handling fire on the question of whether anyone is signed
    // in, which is the thing that handling exists to avoid.
    const res = await get("/sentinel/api/auth/me");
    assertStatus(res, 200);
    const body = await res.json();
    assert(body.state === "anonymous", `state was ${body.state}`);
    assert(body.email === null, "an anonymous answer carries no identity");
    assert(body.can.canRead === false, "and grants nothing");
  });

  await check("/auth/me never mints a session of its own", async () => {
    // The whole point of one-session: this endpoint reads, and a Set-Cookie
    // here would mean Sentinel had started keeping its own again.
    const res = await get("/sentinel/api/auth/me");
    assert(!res.headers.get("set-cookie"), "it set a cookie");
  });

  await check("token sign-in is gone, and says so rather than 404ing", async () => {
    const res = await fetch(`${BASE}/sentinel/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "irrelevant" }),
    });
    assertStatus(res, 410);
  });

  await check("silent sign-in is gone entirely", async () => {
    if (!SESSION) return "skip";
    // Asked with a session good enough that the old endpoint would have
    // answered it. Anonymously this only ever proves the guard runs first,
    // since the guard on /sentinel/api refuses before routing reaches a 404.
    const res = await fetch(`${BASE}/sentinel/api/auth/sso`, {
      method: "POST",
      headers: { cookie: `sessionid=${SESSION}` },
    });
    assertStatus(res, 404, "POST /auth/sso with a valid session");
  });

  await check("the staff token reads reports", async () => {
    if (!TOKEN) return "skip";
    const res = await get("/sentinel/api/reports", { headers: bearer });
    assertStatus(res, 200);
    assert(Array.isArray(await res.json()), "reports did not come back as a list");
  });

  await check("a disabled account is refused, on the session it already had", async () => {
    if (!SESSION) return "skip";
    /**
     * The one that got through. Deactivating an account leaves its session
     * working and GlitchTip still answering 200 for it — isActive in the body
     * is the only sign — so a receiver that assumed "GlitchTip described this
     * user, therefore they are active" kept a disabled person signed in and
     * fully authorised until their session aged out. Nothing else notices.
     */
    const { execFileSync } = await import("node:child_process");
    const toggle = (flag) =>
      execFileSync("bash", ["scripts/seed-smoke-session.sh", flag], {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
      }).trim();

    toggle("--disable");
    try {
      /**
       * Polled rather than asked once, because identity is cached for a few
       * seconds and being switched off has to outlive that. The window is
       * deliberate — it is what stops one page load costing six lookups —
       * but it means a disabling takes effect within seconds rather than
       * instantly, and a test that asked immediately would pass or fail
       * depending on when in that window it ran. It failed exactly that way
       * when it was written.
       */
      const deadline = Date.now() + 20_000;
      let body;
      do {
        const me = await get("/sentinel/api/auth/me", {
          headers: { cookie: `sessionid=${SESSION}` },
        });
        body = await me.json();
        if (body.state === "disabled") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);

      assert(body.state === "disabled", `state was ${body.state}, wanted disabled`);
      assert(body.can.canRead === false, "a disabled account could still read");

      const reports = await get("/sentinel/api/reports", {
        headers: { cookie: `sessionid=${SESSION}` },
      });
      assert(reports.status === 401, `reports answered ${reports.status}, wanted 401`);
    } finally {
      // Always, including when an assertion above threw: leaving the shared
      // account switched off would break every later run.
      toggle("--enable");

      // And wait until that is visible, for the same caching reason. Without
      // this the next check inherited a cached "disabled" and failed with a
      // 401 that had nothing to do with what it was testing.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const me = await get("/sentinel/api/auth/me", {
          headers: { cookie: `sessionid=${SESSION}` },
        });
        if ((await me.json()).state !== "disabled") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  });

  await check("a person sees only the apps whose project they can see", async () => {
    if (!SESSION || !TOKEN) return "skip";
    /**
     * The other one. A person's project list used to fall back to "no
     * restriction" whenever GlitchTip refused or failed to answer, and an app
     * with no known project was shown to everybody — so a momentary fault, or
     * an unmapped app, handed one organisation's reports to another's.
     */
    const appsFor = async (headers) => {
      const res = await get("/sentinel/api/reports", { headers });
      assertStatus(res, 200);
      return new Set((await res.json()).map((report) => report.appName));
    };

    const asStaff = await appsFor(bearer);
    const asPerson = await appsFor({ cookie: `sessionid=${SESSION}` });

    for (const app of asPerson) {
      assert(asStaff.has(app), `a person saw ${app}, which the staff token does not`);
    }
    // The staff token is the one thing that sees everything, by name rather
    // than by falling out of an absent value.
    assert(asStaff.size >= asPerson.size, "the staff token saw fewer apps than a person");
  });

  await check("a bearer write needs no CSRF token", async () => {
    if (!TOKEN) return "skip";
    // The exemption matters as much as the requirement: apps posting reports
    // have no cookie and no way to obtain one.
    //
    // Writes back exactly what is already there. A suite that quietly empties
    // the allowed-origins list would break report intake for every app, which
    // is a spectacular way for a test to cause the outage it was meant to
    // catch.
    const current = await (await get("/sentinel/api/settings/origins", { headers: bearer })).json();
    const editable = (current.origins || []).filter((o) => !(current.fixed || []).includes(o));

    const res = await fetch(`${BASE}/sentinel/api/settings/origins`, {
      method: "PUT",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ origins: editable }),
    });
    assertStatus(res, 200, "PUT settings/origins with a bearer token");

    const after = await (await get("/sentinel/api/settings/origins", { headers: bearer })).json();
    assert(
      JSON.stringify(after.origins) === JSON.stringify(current.origins),
      "the allowed-origins list changed; the suite must leave it as it found it"
    );
  });
}

// ----------------------------------------------------------------- CSRF

async function csrfIsEnforced() {
  process.stdout.write("\nCSRF on session-authenticated writes\n");

  await check("a session write without a token is refused", async () => {
    if (!SESSION || !ORG) return "skip";
    const res = await fetch(`${BASE}/api/0/organizations/${encodeURIComponent(ORG)}/issues/?id=999999`, {
      method: "PUT",
      headers: { cookie: `sessionid=${SESSION}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    assertStatus(res, 403, "a session write with no CSRF header");
  });

  await check("a session write with a token is accepted by CSRF", async () => {
    if (!SESSION || !ORG) return "skip";
    const bootstrap = await get("/_allauth/browser/v1/auth/session", {
      headers: { cookie: `sessionid=${SESSION}` },
    });
    const csrf = (bootstrap.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1];
    assert(csrf, "no csrftoken cookie was offered to bootstrap from");

    const res = await fetch(`${BASE}/api/0/organizations/${encodeURIComponent(ORG)}/issues/?id=999999`, {
      method: "PUT",
      headers: {
        cookie: `sessionid=${SESSION}; csrftoken=${csrf}`,
        "x-csrftoken": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "resolved" }),
    });
    // 404/400 are fine — the point is that it got past CSRF, not that the
    // made-up issue exists.
    assert(res.status !== 403, `still refused with a CSRF token (${res.status})`);
  });
}

// ------------------------------------------------------------------ run

async function main() {
  process.stdout.write(`Smoke tests against ${BASE}\n`);
  if (!TOKEN) process.stdout.write("  (no STAFF_API_TOKEN found — token checks will skip)\n");
  if (!SESSION) process.stdout.write("  (no GLITCHTIP_SESSION set — CSRF checks will skip)\n");

  await shellServed();
  await standaloneMode();
  await backendsOwnTheirPaths();
  await authBoundaries();
  await csrfIsEnforced();

  process.stdout.write(
    `\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped\n`
  );
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\nThe suite itself fell over: ${error.stack}\n`);
  process.exit(1);
});
