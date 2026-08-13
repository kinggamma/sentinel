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
    "issues.js",
    "lib/api.js",
    "lib/dom.js",
    "lib/router.js",
    "lib/abort.js",
    "views/requests.js",
    "views/settings.js",
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

  await check("/auth/me is 401 without a session", async () => {
    assertStatus(await get("/sentinel/api/auth/me"), 401);
  });

  await check("the staff token reads reports", async () => {
    if (!TOKEN) return "skip";
    const res = await get("/sentinel/api/reports", { headers: bearer });
    assertStatus(res, 200);
    assert(Array.isArray(await res.json()), "reports did not come back as a list");
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
    if (!SESSION) return "skip";
    const res = await fetch(`${BASE}/api/0/organizations/almareem/issues/?id=999999`, {
      method: "PUT",
      headers: { cookie: `sessionid=${SESSION}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    assertStatus(res, 403, "a session write with no CSRF header");
  });

  await check("a session write with a token is accepted by CSRF", async () => {
    if (!SESSION) return "skip";
    const bootstrap = await get("/_allauth/browser/v1/auth/session", {
      headers: { cookie: `sessionid=${SESSION}` },
    });
    const csrf = (bootstrap.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1];
    assert(csrf, "no csrftoken cookie was offered to bootstrap from");

    const res = await fetch(`${BASE}/api/0/organizations/almareem/issues/?id=999999`, {
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
