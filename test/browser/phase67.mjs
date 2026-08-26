#!/usr/bin/env node
/** Phase 6/7 browser mutations, each against objects owned by this run. */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-phase67-${process.pid}-${Date.now().toString(36)}`;
const MANAGER = `${RUN}-manager@example.com`;
const PENDING = `${RUN}-pending@example.com`;
/**
 * GlitchTip caps a provider name at 40 characters. Built from RUN these came
 * to 44 once "-edited" was on the end, so every edit in this suite was a 422
 * the screen reported and the test never read — the check that followed
 * looked for the un-renamed name as a substring and found it. Short enough
 * that both names fit, and both are named here so neither can drift.
 */
const SSO = `sentinel-sso-${process.pid.toString(36)}-${Date.now().toString(36).slice(-5)}`;
const SSO_RENAMED = `${SSO}-renamed`;
const ENVIRONMENT = `${RUN}-environment`;
const TOKEN = `${RUN}-token`;
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
function org() {
  const out = django("from apps.organizations_ext.models import Organization; print('slug', Organization.objects.order_by('id').first().slug)");
  return out.match(/^slug (.+)$/m)?.[1]?.trim();
}
const ORG = org();
const SOCIAL_APPS = `/api/0/organizations/${encodeURIComponent(ORG)}/social-apps/`;
const PASSWORD = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
function seed() {
  django(`
from django.contrib.auth import get_user_model
from allauth.account.models import EmailAddress
from apps.organizations_ext.models import Organization, OrganizationUser
from apps.environments.models import Environment
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
for email, managed in [(${JSON.stringify(MANAGER)}, True), (${JSON.stringify(PENDING)}, False)]:
 u=User.objects.create_user(email=email, password=${JSON.stringify(PASSWORD)}, is_active=True)
 EmailAddress.objects.update_or_create(user=u, email=email, defaults={'primary': True, 'verified': True})
 if managed:
  role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='manager'][0]
  OrganizationUser.objects.create(user=u, organization=org, role=role)
Environment.objects.get_or_create(organization=org, name=${JSON.stringify(ENVIRONMENT)})
print('seeded')`);
}
function cleanup() {
  django(`
from django.contrib.auth import get_user_model
from allauth.socialaccount.models import SocialApp
from apps.environments.models import Environment
from apps.organizations_ext.models import Organization
get_user_model().objects.filter(email__in=${JSON.stringify([MANAGER, PENDING])}).delete()
SocialApp.objects.filter(name__in=${JSON.stringify([SSO, SSO_RENAMED])}).delete()
Environment.objects.filter(organization__slug=${JSON.stringify(ORG)}, name=${JSON.stringify(ENVIRONMENT)}).delete()
print('clean')`);
}
async function signIn(page, email, { expectShell = true } = {}) {
  await page.goto(`${BASE}/sentinel/signin`);
  await page.fill("#email-input", email);
  await page.fill("#password-input", PASSWORD);
  await page.click(".gate-card button[type=submit]");
  if (expectShell) {
    await page.waitForFunction(() => !document.querySelector("#topbar")?.hidden, null, { timeout: 20_000 });
  } else {
    await page.waitForURL((url) => !url.pathname.endsWith("/signin"), { timeout: 20_000 });
  }
}
async function attachAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  }});
  return { cdp, authenticatorId };
}
async function reloadUntilText(page, url, text, { present = true, attempts = 4 } = {}) {
  let last = "";
  for (let at = 0; at < attempts; at += 1) {
    await page.goto(url);
    await page.waitForFunction(() => {
      const view = document.querySelector("#view");
      return Boolean(view && view.innerText.trim().length);
    }, null, { timeout: 8_000 });
    const body = await page.locator("#view").innerText();
    last = body;
    const has = body.includes(text);
    if (has === present) return body;
  }
  throw new Error(`render never ${present ? "showed" : "hid"} ${text}: ${last}`);
}
/**
 * Wait until GlitchTip itself agrees, asked from inside the page's session.
 *
 * Deliberately not page.waitForFunction. Hand that an async predicate and it
 * resolves on the very first poll no matter what the predicate eventually
 * answers: the value it tests for truthiness is the promise, and a promise is
 * an object. Every API wait in this file used to succeed before its fetch had
 * landed — one poll, answer false, "success". Only their rejections were ever
 * noticed, which is why a free variable in one of them was still able to fail
 * a run and nothing else about them ever could.
 *
 * page.evaluate does await what it is given, so the polling happens out here
 * where the answer is a value rather than a promise.
 */
async function untilApi(page, path, decide, { attempts = 20, every = 400 } = {}) {
  let last = null;
  for (let at = 0; at < attempts; at += 1) {
    last = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      return { ok: res.ok, status: res.status, rows: res.ok ? await res.json() : null };
    }, path);
    if (last.ok && decide(last.rows)) return last.rows;
    await page.waitForTimeout(every);
  }
  throw new Error(`GlitchTip never agreed (last ${last?.status}): ${JSON.stringify(last?.rows)}`);
}

function base32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2)));
}
function totp(secret) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const at = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

seed();
const browser = await chromium.launch();
try {
  process.stdout.write("\nPhase 6/7 browser mutations\n");
  await test("a signed-in person without organisation access can open Profile", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(4_000);
    await signIn(page, PENDING, { expectShell: false });
    await page.goto(`${BASE}/sentinel/profile`);
    await page.waitForSelector("#view h2");
    assert((await page.locator("body").innerText()).includes(PENDING), `profile unavailable: ${await page.locator("body").innerText()}`);

    /**
     * And is offered nothing it cannot open. Profile is the one screen this
     * account can reach; the other six all need an organisation, and the
     * guard bounces every one of them back to /access. A sidebar full of
     * links that do that is worse than a short sidebar.
     */
    for (const id of ["nav-issues", "nav-projects", "nav-people", "nav-organisation", "nav-reports", "nav-settings"]) {
      assert(await page.locator(`#${id}`).isHidden(), `${id} offered to an account that cannot open it`);
    }
    assert(await page.locator("#nav-profile").isVisible(), "profile link missing from the one screen it can reach");
    await context.close();
  });

  const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(4_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, MANAGER);

  await test("organisation environments are visible from the organisation screen", async () => {
    await page.goto(`${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${ENVIRONMENT}`);
  });

  await test("credential dialogs are removed when navigation aborts their route", async () => {
    await page.getByRole("button", { name: "Add sign-on provider" }).click();
    assert(await page.locator(".modal").count() === 1, "SSO dialog did not open");
    await page.goto(`${BASE}/sentinel/profile`);
    assert(await page.locator(".modal").count() === 0, "SSO dialog survived navigation");
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    await page.waitForSelector(".totp-qr");
    await page.goto(`${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`);
    assert(await page.locator(".modal").count() === 0, "MFA dialog survived navigation");
  });

  await test("an SSO provider can be created, edited and removed", async () => {
    const ssoContext = await browser.newContext(); const ssoPage = await ssoContext.newPage(); ssoPage.setDefaultTimeout(8_000);
    let postResult = null;
    const capture = async (response) => {
      if (response.request().method() === "POST" && response.url().includes("/social-apps/")) {
        postResult = { status: response.status(), body: await response.text() };
      }
    };
    try {
      await signIn(ssoPage, MANAGER);
      await ssoPage.goto(`${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`);
      ssoPage.on("response", capture);
      await ssoPage.click("button:has-text('Add sign-on provider')");
      await ssoPage.fill("#sso-name", SSO);
      await ssoPage.fill("#sso-client-id", `${RUN}-client`);
      await ssoPage.fill("#sso-client-secret", `${RUN}-secret`);
      await ssoPage.fill("#sso-server-url", "https://identity.example.com/");
      await ssoPage.getByRole("button", { name: "Add provider" }).click();
      await untilApi(ssoPage, SOCIAL_APPS, (rows) => rows.some((row) => row?.name === SSO))
        .catch(async (error) => {
          throw new Error(`SSO create did not persist (${JSON.stringify(postResult)}, ${error.message}): ${await ssoPage.locator("#view").innerText()}`);
        });
      await reloadUntilText(ssoPage, `${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`, SSO);
      ssoPage.off("response", capture);
      await ssoPage.locator("li", { hasText: SSO }).getByRole("button", { name: "Edit" }).click();
      await ssoPage.fill("#sso-name", SSO_RENAMED);
      await ssoPage.getByRole("button", { name: "Save provider" }).click();
      // The new name present and the old one gone — a rename, rather than a
      // second provider that happens to be called the right thing.
      await untilApi(ssoPage, SOCIAL_APPS, (rows) =>
        rows.some((row) => row?.name === SSO_RENAMED) && !rows.some((row) => row?.name === SSO));
      await reloadUntilText(ssoPage, `${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`, SSO_RENAMED);
      await ssoPage.locator("li", { hasText: SSO_RENAMED }).getByRole("button", { name: "Remove" }).click();
      await ssoPage.getByRole("button", { name: "Remove it" }).click();
      await untilApi(ssoPage, SOCIAL_APPS, (rows) =>
        !rows.some((row) => String(row?.name || "").startsWith(SSO)));
      await reloadUntilText(ssoPage, `${BASE}/sentinel/organisation?org=${encodeURIComponent(ORG)}`, SSO, { present: false });
    } finally {
      await ssoContext.close();
    }
  });

  await page.goto(`${BASE}/sentinel/profile`); await page.waitForSelector("h2");
  await test("token validation and API failures are visible immediately", async () => {
    await page.getByRole("button", { name: "Make a token" }).click();
    assert((await page.locator("body").innerText()).includes("Tick what it needs"), "no-scope validation is invisible");
    await page.route("**/api/0/api-tokens/", async (route) => {
      if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "deliberate token failure" }) });
      else await route.continue();
    });
    await page.getByLabel("Read projects").check();
    await page.getByRole("button", { name: "Make a token" }).click();
    await page.waitForSelector("text=deliberate token failure");
    await page.unroute("**/api/0/api-tokens/");
  });

  await test("a token can be made, displays its created date, and is deleted", async () => {
    await page.fill("#token-label", TOKEN); await page.getByLabel("Read projects").check();
    await page.getByRole("button", { name: "Make a token" }).click();
    await page.waitForSelector("text=Copy this now");
    await page.reload(); await page.waitForSelector(`text=${TOKEN}`);
    const row = page.locator("li", { hasText: TOKEN });
    assert((await row.innerText()).match(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}/), "created date missing");
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), TOKEN);
  });

  await test("the real GlitchTip setup-wizard hash is handed off", async () => {
    const created = await fetch(`${BASE}/api/0/wizard/`).then((res) => res.json());
    await page.goto(`${BASE}/sentinel/profile/setup-wizard/${created.hash}`);
    await page.getByRole("button", { name: "Connect setup wizard" }).click();
    await page.waitForSelector("text=Setup wizard connected");
    const result = await fetch(`${BASE}/api/0/wizard/${created.hash}/`).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert(result.status === 200 && result.body.apiKeys, "wizard cache was not populated by the authenticated screen");
    await fetch(`${BASE}/api/0/wizard/${created.hash}/`, { method: "DELETE" });
  });

  await test("TOTP can be enrolled, recovery codes regenerated, and TOTP removed", async () => {
    await page.goto(`${BASE}/sentinel/profile`); await page.getByRole("button", { name: "Set up authenticator" }).click();
    assert((await page.locator(".totp-qr").getAttribute("src"))?.startsWith("data:image/png"), "TOTP QR was not rendered locally");
    const secret = (await page.locator("#totp-secret").textContent()).trim();
    await page.fill("#totp-code", totp(secret)); await page.getByRole("button", { name: "Verify and turn on" }).click();
    await page.waitForSelector("text=Save these recovery codes");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Regenerate recovery codes" }).click();
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await page.waitForSelector("text=Save these recovery codes"); await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Remove authenticator" }).click();
    await page.getByRole("button", { name: "Remove it" }).click();
    await page.waitForSelector("text=No second factor");
  });

  await test("a passkey can be added, renamed and removed with a virtual authenticator", async () => {
    const { cdp, authenticatorId } = await attachAuthenticator(page);
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.fill("#passkey-name", `${RUN}-key`); await page.getByRole("button", { name: "Create passkey" }).click();
    await page.waitForSelector(`text=${RUN}-key`);
    const row = page.locator("li", { hasText: `${RUN}-key` }); await row.getByRole("button", { name: "Rename" }).click();
    await page.fill("#passkey-name", `${RUN}-renamed`); await page.getByRole("button", { name: "Save name" }).click();
    await page.waitForSelector(`text=${RUN}-renamed`);
    await page.locator("li", { hasText: `${RUN}-renamed` }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Remove it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), `${RUN}-renamed`);
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }); await cdp.detach();
  });

  assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
  await context.close();
} finally {
  await browser.close();
  cleanup();
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
