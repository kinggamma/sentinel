#!/usr/bin/env node
/**
 * Phase 8b in a browser.
 *
 * Transaction groups come from Postgres and are seeded here. Spans, the
 * org-wide span groups, the repeated-query patterns and the trend series do
 * not: they are read from GlitchTip's cold storage, which a default
 * deployment does not configure, and every one of those endpoints answers an
 * empty list rather than an error when it is missing. So the thing worth
 * checking about those four is that the screen says which of the two silences
 * it is looking at, since the response cannot tell it.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-perf-${process.pid}-${Date.now().toString(36)}`;
const MEMBER = `${RUN}-member@example.com`;
const SLOW = `GET /${RUN}/checkout`;
const FAST = `GET /${RUN}/health`;
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
from apps.performance.models import TransactionGroup
from django.utils import timezone
from datetime import timedelta
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
u=User.objects.create_user(email=${JSON.stringify(MEMBER)}, password=${JSON.stringify(PASSWORD)}, is_active=True)
EmailAddress.objects.update_or_create(user=u, email=${JSON.stringify(MEMBER)}, defaults={'primary': True, 'verified': True})
role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='member'][0]
OrganizationUser.objects.create(user=u, organization=org, role=role)
project=org.projects.first()
now=timezone.now()
TransactionGroup.objects.create(organization=org, project=project, transaction=${JSON.stringify(SLOW)},
  op='http.server', method='GET', first_seen=now-timedelta(days=2), last_seen=now,
  avg_duration=1240.0, p50=980.0, p95=3100.0, count=500, error_count=25)
TransactionGroup.objects.create(organization=org, project=project, transaction=${JSON.stringify(FAST)},
  op='http.server', method='GET', first_seen=now-timedelta(days=2), last_seen=now,
  avg_duration=4.5, p50=4.0, p95=9.0, count=20000, error_count=0)
print('seeded')`);
}

function cleanup() {
  django(`
from django.contrib.auth import get_user_model
from apps.performance.models import TransactionGroup
get_user_model().objects.filter(email__in=${JSON.stringify([MEMBER])}).delete()
TransactionGroup.objects.filter(transaction__in=${JSON.stringify([SLOW, FAST])}).delete()
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

seed();
const browser = await chromium.launch();
const errors = [];
try {
  process.stdout.write(`\nPerformance (organisation: ${ORG})\n`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, MEMBER);

  await test("Performance is a screen here rather than a link out", async () => {
    assert(await page.locator("#nav-performance").isVisible(), "Performance is not in the sidebar");
    assert(await page.locator("#nav-performance").getAttribute("href") === "/sentinel/performance",
      "Performance points somewhere else");
    assert(await page.locator("#nav-performance").getAttribute("target") === null, "it still opens a new tab");
  });

  await test("the list shows transactions slowest first, with their numbers", async () => {
    await page.goto(`${BASE}/sentinel/performance?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${SLOW}`);
    const rows = await page.locator("tbody tr").allInnerTexts();
    assert(rows[0].includes(SLOW), `slowest is not first: ${rows.join(" | ")}`);
    assert(rows[0].includes("1.24 s"), `average is not readable: ${rows[0]}`);
    assert(rows[0].includes("3.10 s"), `p95 is not readable: ${rows[0]}`);
    assert(rows[0].includes("5.0%"), `error rate missing: ${rows[0]}`);
    // Grouped, so 500 and 20,000 are told apart by shape rather than by
    // counting digits.
    const busy = rows.find((one) => one.includes(FAST));
    assert(busy.includes((20000).toLocaleString()), `count is not grouped: ${busy}`);
    // The fast one keeps milliseconds, which is the whole point of the unit
    // changing per row rather than per column.
    const fast = rows.find((one) => one.includes(FAST));
    assert(fast.includes("4.5 ms"), `fast row lost its unit: ${fast}`);
  });

  await test("sorting by traffic reorders it, and the address says so", async () => {
    await page.selectOption("#perf-sort", "-count");
    await page.waitForFunction((slow) => {
      const first = document.querySelector("tbody tr");
      return first && !first.innerText.includes(slow);
    }, SLOW);
    assert(page.url().includes("sort=-count"), `sort is not in the address: ${page.url()}`);
    const rows = await page.locator("tbody tr").allInnerTexts();
    assert(rows[0].includes(FAST), `busiest is not first: ${rows[0]}`);
  });

  await test("a search narrows it to one, and survives a reload", async () => {
    await page.fill("#perf-query", "health");
    await page.press("#perf-query", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
    assert(page.url().includes("q=health"), `search is not in the address: ${page.url()}`);
    await page.reload();
    await page.waitForSelector(`text=${FAST}`);
    assert(await page.locator("#perf-query").inputValue() === "health", "the field forgot on reload");
    assert(await page.locator("tbody tr").count() === 1, "the filter forgot on reload");
  });

  await test("one transaction opens its own screen", async () => {
    await page.goto(`${BASE}/sentinel/performance?org=${encodeURIComponent(ORG)}`);
    await page.getByRole("link", { name: SLOW }).click();
    // The facts block rather than a bare h2: innerText reads as empty for an
    // element that is attached but not yet laid out, which is exactly the
    // moment a generic selector matches.
    await page.waitForSelector("dl.release-facts");
    const body = await view(page);
    for (const wanted of ["1.24 s", "980 ms", "3.10 s", "500", "25 (5.0%)", "http.server"]) {
      assert(body.includes(wanted), `detail is missing ${wanted}: ${body}`);
    }
  });

  await test("an empty span list says why it might be empty, not just that it is", async () => {
    /**
     * The finding this screen is built around. Cold storage is what answers
     * spans, N+1 and the trend, and when it is absent all three return an
     * empty list — identical to a quiet week. Saying only "nothing here"
     * would leave somebody staring at a busy service that reports no spans.
     */
    const body = await view(page);
    assert(body.includes("cold storage"), `no explanation of the empty spans: ${body}`);
  });

  await test("the other two performance screens are reachable and say the same", async () => {
    for (const [tab, path] of [["Spans", "/performance/spans"], ["Repeated queries", "/performance/n-plus-one"]]) {
      await page.goto(`${BASE}/sentinel${path}?org=${encodeURIComponent(ORG)}`);
      await page.waitForSelector(".sub-tab.current");
      assert(await page.locator(".sub-tab.current").innerText() === tab, `${path} did not mark its tab`);
      assert((await view(page)).includes("cold storage"), `${path} did not explain its silence`);
    }
  });

  await test("a transaction id that is not there says so", async () => {
    await page.goto(`${BASE}/sentinel/performance/999999999?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".error");
    assert((await view(page)).match(/isn't there|don't have access/), "no explanation shown");
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
