#!/usr/bin/env node
/**
 * Phase 8c in a browser.
 *
 * Logs answer from Postgres for anything recent, so unlike spans this screen
 * has real data to work with in a default deployment. What is worth checking
 * is the ladder — "warn and worse" has to mean three levels at the API and
 * not one — and that a trace pulls back the whole request rather than the
 * slice of it inside the current window.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";

/**
 * A log id is a UUIDv7, because the id *is* the timestamp — the table has no
 * separate one. A v4 uuid in that URL is not a missing log, it is a malformed
 * one, and GlitchTip answers it with a 500 rather than a 404. Both cases are
 * exercised below, and this builds the well-formed one.
 */
function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  const ms = BigInt(at);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-logs-${process.pid}-${Date.now().toString(36)}`;
const MEMBER = `${RUN}-member@example.com`;
const SERVICE = `${RUN}-checkout`;
const OTHER_SERVICE = `${RUN}-search`;
const TRACE = randomUUID();
const LONG = `${RUN} timeout talking to the payment gateway ${"and again ".repeat(30)}tail`;
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
  const out = django(`
from django.contrib.auth import get_user_model
from allauth.account.models import EmailAddress
from apps.organizations_ext.models import Organization, OrganizationUser
from apps.logs.models import LogEvent, LogResource
from apps.logs.constants import LogLevel
from glitchtip.partition_manager import UUID7Helper
from django.utils import timezone
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
u=User.objects.create_user(email=${JSON.stringify(MEMBER)}, password=${JSON.stringify(PASSWORD)}, is_active=True)
EmailAddress.objects.update_or_create(user=u, email=${JSON.stringify(MEMBER)}, defaults={'primary': True, 'verified': True})
role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='member'][0]
OrganizationUser.objects.create(user=u, organization=org, role=role)
project=org.projects.first()
now=timezone.now()
rows=[
 (LogLevel.INFO, ${JSON.stringify(`${RUN} order accepted`)}, ${JSON.stringify(SERVICE)}, None),
 (LogLevel.WARN, ${JSON.stringify(`${RUN} retrying the charge`)}, ${JSON.stringify(SERVICE)}, ${JSON.stringify(TRACE)}),
 (LogLevel.ERROR, ${JSON.stringify(LONG)}, ${JSON.stringify(SERVICE)}, ${JSON.stringify(TRACE)}),
 (LogLevel.DEBUG, ${JSON.stringify(`${RUN} cache miss`)}, ${JSON.stringify(OTHER_SERVICE)}, None),
]
made=[]
for level, body, service, trace in rows:
    log_id=UUID7Helper.from_datetime(now)
    LogEvent.objects.create(id=log_id, organization=org, project=project, level=level, body=body,
      service=service, environment='production', host='web-1', severity_number=int(level)*4,
      trace_id=trace, data={'route': '/checkout', 'attempt': 2})
    made.append(str(log_id))
for name, kind in [(${JSON.stringify(SERVICE)}, 'service'), (${JSON.stringify(OTHER_SERVICE)}, 'service'), ('production', 'environment')]:
    LogResource.objects.update_or_create(organization=org, name=name, type=kind,
      defaults={'first_seen': now, 'last_seen': now})
print('ids ' + ','.join(made))`);
  return out.match(/^ids (.+)$/m)?.[1]?.trim().split(",") || [];
}

function cleanup() {
  django(`
from django.contrib.auth import get_user_model
from apps.logs.models import LogEvent, LogResource
from apps.organizations_ext.models import Organization
org=Organization.objects.get(slug=${JSON.stringify(ORG)})
get_user_model().objects.filter(email__in=${JSON.stringify([MEMBER])}).delete()
LogEvent.objects.filter(organization=org, body__startswith=${JSON.stringify(RUN)}).delete()
LogResource.objects.filter(organization=org, name__in=${JSON.stringify([SERVICE, OTHER_SERVICE])}).delete()
print('clean')`);
}

async function signIn(page, email) {
  await page.goto(`${BASE}/sentinel/signin`);
  await page.fill("#email-input", email);
  await page.fill("#password-input", PASSWORD);
  await page.click(".gate-card button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#topbar")?.hidden, null, { timeout: 20_000 });
}

const view = (page) => page.locator("#view").innerText();
const rowsWith = async (page) => (await page.locator("tbody tr").allInnerTexts()).join("\n");

const IDS = seed();
const browser = await chromium.launch();
const errors = [];
try {
  process.stdout.write(`\nLogs (organisation: ${ORG})\n`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, MEMBER);

  await test("Logs is a screen here, and offered because this installation has it", async () => {
    assert(await page.locator("#nav-logs").isVisible(), "Logs is not in the sidebar");
    assert(await page.locator("#nav-logs").getAttribute("href") === "/sentinel/logs", "Logs points elsewhere");
    assert(await page.locator("#nav-logs").getAttribute("target") === null, "it still opens a new tab");
  });

  await test("the list shows what was logged, with its level", async () => {
    await page.goto(`${BASE}/sentinel/logs?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${RUN} order accepted`);
    const body = await rowsWith(page);
    for (const wanted of ["order accepted", "retrying the charge", "cache miss", SERVICE, "production"]) {
      assert(body.includes(wanted), `list is missing ${wanted}`);
    }
    assert((await page.locator(".log-error").count()) >= 1, "no level chips");
  });

  await test("a long line is cut at a word, and says there is more", async () => {
    const rows = await page.locator("tbody tr").allInnerTexts();
    const long = rows.find((one) => one.includes("timeout talking"));
    assert(long, "the long line is missing");
    assert(long.includes("…"), `not truncated: ${long}`);
    assert(!long.includes("tail"), "the whole body reached the row");
    assert(long.includes("more…"), "no indication there is more");
  });

  await test("'warn and worse' means three levels, not one", async () => {
    /**
     * The ladder. GlitchTip takes one `level` parameter per level, so a
     * screen sending only "warn" would hide the errors somebody asked to
     * see — the exact opposite of what they chose.
     */
    await page.selectOption("#log-level", "warn");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
    const body = await rowsWith(page);
    assert(body.includes("retrying the charge"), "the warning is gone");
    assert(body.includes("timeout talking"), "the error is gone — 'and worse' meant only warn");
    assert(!body.includes("order accepted"), "info survived a warn filter");
    assert(!body.includes("cache miss"), "debug survived a warn filter");
    assert(page.url().includes("level=warn"), `the address forgot: ${page.url()}`);
  });

  await test("a service filter narrows it, and both survive a reload", async () => {
    await page.selectOption("#log-service", OTHER_SERVICE);
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 0
      || !document.body.innerText.includes("retrying the charge"));
    await page.selectOption("#log-level", "");
    await page.waitForFunction((name) => document.body.innerText.includes(name), `${RUN} cache miss`);
    await page.reload();
    await page.waitForSelector(`text=${RUN} cache miss`);
    assert(await page.locator("#log-service").inputValue() === OTHER_SERVICE, "the service filter forgot");
    assert(!(await rowsWith(page)).includes("order accepted"), "the filter forgot on reload");
  });

  await test("one log opens whole, with its attributes", async () => {
    await page.goto(`${BASE}/sentinel/logs/${IDS[2]}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".log-full");
    const body = await view(page);
    // The row cut this at a word; the screen does not cut it at all.
    assert(body.includes("tail"), `the whole body is not shown: ${body.slice(0, 200)}`);
    assert(body.includes("web-1"), "host missing");
    assert(body.includes("/checkout"), "attributes missing");
    assert(await page.locator(".log-error").count() >= 1, "level chip missing");
  });

  await test("its trace leads to the rest of the request", async () => {
    await page.getByRole("link", { name: TRACE }).click();
    await page.waitForSelector(".log-trace");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
    const body = await rowsWith(page);
    assert(body.includes("retrying the charge"), "the other line of the trace is missing");
    assert(!body.includes("cache miss"), "a line outside the trace came along");
    // And is a state with a way out, rather than a filter with no label.
    await page.getByRole("button", { name: "Show all logs" }).click();
    await page.waitForFunction((name) => document.body.innerText.includes(name), `${RUN} cache miss`);
  });

  await test("a log id that is not there says so", async () => {
    await page.goto(`${BASE}/sentinel/logs/${uuidv7()}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".error");
    assert((await view(page)).match(/isn't there|don't have access/),
      `no explanation shown: ${await view(page)}`);
  });

  await test("and a malformed one is reported rather than swallowed", async () => {
    /**
     * GlitchTip decodes the timestamp out of the id, so a v4 uuid is not a
     * log it cannot find — it is a value it cannot parse, and it answers 500.
     * Nothing here can turn that into "not found" honestly, so the screen
     * says what happened instead of guessing.
     */
    await page.goto(`${BASE}/sentinel/logs/${randomUUID()}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".error");
    assert((await view(page)).includes("500"), `the failure was hidden: ${await view(page)}`);
  });

  await test("nothing on these screens threw", async () => {
    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
  });

  await context.close();
} finally {
  await browser.close();
  cleanup();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
