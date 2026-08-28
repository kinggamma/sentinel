#!/usr/bin/env node
/**
 * Phase 9, in a browser: the app at the root, and every address GlitchTip's
 * own interface used to answer.
 *
 * The smoke suite already asks whether those paths return the shell. That is
 * the server's half and it was the easy half — what it cannot see is which
 * screen the client then shows, or whether the organisation survived the
 * translation. GlitchTip carried the organisation in the path and this app
 * carries it in the query, so "/<org>/issues" landing on the issue list of
 * the wrong organisation would look completely correct from outside.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-flip-${process.pid}-${Date.now().toString(36)}`;
const MEMBER = `${RUN}-member@example.com`;
const PASSWORD = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, run) {
  try { await run(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}
function django(python) {
  return execFileSync("docker", ["compose", "exec", "-T", "glitchtip-web", "./manage.py", "shell", "-c", python],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const ORG = django(
  "from apps.organizations_ext.models import Organization; print('slug', Organization.objects.order_by('id').first().slug)"
).match(/^slug (.+)$/m)?.[1]?.trim();

function seed() {
  django(`
from django.contrib.auth import get_user_model
from allauth.account.models import EmailAddress
from apps.organizations_ext.models import Organization, OrganizationUser
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
u=User.objects.create_user(email=${JSON.stringify(MEMBER)}, password=${JSON.stringify(PASSWORD)}, is_active=True)
EmailAddress.objects.update_or_create(user=u, email=${JSON.stringify(MEMBER)}, defaults={'primary': True, 'verified': True})
role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='member'][0]
OrganizationUser.objects.create(user=u, organization=org, role=role)
print('seeded')`);
}

function cleanup() {
  django(`
from django.contrib.auth import get_user_model
get_user_model().objects.filter(email__in=${JSON.stringify([MEMBER])}).delete()
print('clean')`);
}

/** Where the client settled, once it has stopped redirecting. */
async function landsOn(page, from, expected) {
  await page.goto(`${BASE}${from}`);
  await page.waitForFunction(
    (want) => new URL(location.href).pathname === want,
    expected.path,
    { timeout: 8_000 }
  ).catch(() => {});
  const url = new URL(page.url());
  assert(url.pathname === expected.path,
    `${from} landed on ${url.pathname}, wanted ${expected.path}`);
  if (expected.org !== undefined) {
    assert(url.searchParams.get("org") === expected.org,
      `${from} kept org=${url.searchParams.get("org")}, wanted ${expected.org}`);
  }
  return url;
}

seed();
const browser = await chromium.launch();
const errors = [];
try {
  process.stdout.write(`\nThe flip (organisation: ${ORG})\n`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => errors.push(error.message));

  await test("signing in happens at the root, with no prefix in sight", async () => {
    await page.goto(`${BASE}/signin`);
    await page.waitForSelector("#email-input");
    await page.fill("#email-input", MEMBER);
    await page.fill("#password-input", PASSWORD);
    await page.click(".gate-card button[type=submit]");
    await page.waitForFunction(() => !document.querySelector("#topbar")?.hidden, null, { timeout: 20_000 });
    assert(!new URL(page.url()).pathname.startsWith("/sentinel"),
      `it went back to the old mount: ${page.url()}`);
  });

  await test("the addresses GlitchTip used per organisation land on the screens that replaced them", async () => {
    /**
     * The organisation moves from the path to the query. Getting that wrong
     * is invisible from outside: the right screen for the wrong organisation
     * renders perfectly.
     */
    for (const [from, path] of [
      [`/${ORG}/issues`, "/issues"],
      [`/${ORG}/projects`, "/projects"],
      [`/${ORG}/releases`, "/releases"],
      [`/${ORG}/performance`, "/performance"],
      [`/${ORG}/logs`, "/logs"],
      [`/${ORG}/uptime-monitors`, "/uptime"],
      [`/${ORG}/settings`, "/organisation"],
      [`/${ORG}/settings/general`, "/organisation"],
    ]) {
      await landsOn(page, from, { path, org: ORG });
    }
  });

  await test("and the ones that name a thing keep the thing", async () => {
    await landsOn(page, `/${ORG}/issues/4321`, { path: "/issues/4321", org: ORG });
    await landsOn(page, `/${ORG}/projects/e-library`, { path: "/projects/e-library", org: ORG });
  });

  await test("its profile screens are the one profile screen", async () => {
    await landsOn(page, "/profile/auth-tokens", { path: "/profile" });
    await landsOn(page, "/profile/settings", { path: "/profile" });
    // /profile itself is a real route here and must not be redirected.
    await page.goto(`${BASE}/profile`);
    await page.waitForSelector("#view h2");
    assert(new URL(page.url()).pathname === "/profile", `/profile moved to ${page.url()}`);
  });

  await test("its list of organisations is this app's landing screen", async () => {
    await landsOn(page, "/organizations", { path: "/" });
  });

  await test("a bookmark of the old mount still works", async () => {
    /**
     * Nine phases of links point at /sentinel/. The mount is still real and
     * still served — the flip added a root, it did not move the app.
     */
    await page.goto(`${BASE}/sentinel/issues?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector("#view");
    assert(new URL(page.url()).pathname === "/sentinel/issues", `it moved to ${page.url()}`);
    const base = await page.evaluate(() => document.querySelector("base")?.getAttribute("href"));
    assert(base === "/sentinel/", `the old mount is serving <base href="${base}">`);
  });

  await test("no link leads back to the page it is on", async () => {
    /**
     * The flip's quietest failure. Three links pointed at GLITCHTIP_URL —
     * the sidebar's way out, a card's "GlitchTip ↗", and an issue's
     * permalink — and that address is this app now, so each of them left,
     * came back, and landed on a screen Sentinel already had. Two are gone;
     * the third points at wherever GlitchTip's own interface still is, and
     * is not offered at all when it is nowhere.
     */
    const config = await page.evaluate(async () => {
      const res = await fetch("/sentinel/api/auth/config", { credentials: "same-origin" });
      return res.ok ? await res.json() : null;
    });
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".project-card, .empty");
    await page.waitForTimeout(600);

    const out = await page.evaluate(() => {
      const link = document.querySelector("#glitchtip-link");
      return {
        hidden: !link || link.hidden,
        href: link?.getAttribute("href") || null,
        cardLinks: [...document.querySelectorAll(".project-card a")].map((a) => a.getAttribute("href")),
      };
    });

    if (config?.glitchtipUiUrl) {
      assert(!out.hidden, "the escape hatch is configured and not offered");
      assert(out.href === config.glitchtipUiUrl,
        `the way out points at ${out.href}, wanted ${config.glitchtipUiUrl}`);
    } else {
      assert(out.hidden, `nothing is configured, but a way out is offered: ${out.href}`);
    }

    for (const href of out.cardLinks) {
      assert(href && !href.startsWith("http"),
        `a card still links out of the app: ${href}`);
    }
    // A card led to the project screen twice while this was being written.
    assert(new Set(out.cardLinks).size === out.cardLinks.length,
      `a card links to the same place twice: ${out.cardLinks.join(", ")}`);
  });

  await test("nothing on any of that threw", async () => {
    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
  });

  await context.close();

  // The signed-out half, in a session that has never signed in.
  const anon = await browser.newContext();
  const stranger = await anon.newPage();
  stranger.setDefaultTimeout(8_000);

  await test("its sign-in, sign-up and reset addresses land on ours", async () => {
    for (const [from, path] of [
      ["/login", "/signin"],
      [`/login/${ORG}`, "/signin"],
      ["/auth", "/signin"],
      ["/register", "/signup"],
      ["/reset-password", "/password/request"],
    ]) {
      await landsOn(stranger, from, { path });
      await stranger.waitForSelector(".gate-card");
    }
  });

  await test("and a reset link from one of its emails keeps its key", async () => {
    /**
     * The address most likely to be sitting unread in somebody's inbox, and
     * the one where losing a path segment silently is worst: the key is the
     * whole credential.
     */
    const url = await landsOn(stranger, "/reset-password/abc-123-def", { path: "/password/reset/abc-123-def" });
    assert(url.pathname.endsWith("abc-123-def"), `the key was lost: ${url.pathname}`);
    await stranger.waitForSelector(".gate-card");
  });

  await anon.close();
} finally {
  await browser.close();
  cleanup();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
