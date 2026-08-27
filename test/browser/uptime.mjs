#!/usr/bin/env node
/**
 * Phase 8d in a browser — the first of the remaining verticals that writes.
 *
 * The monitor made here is a Heartbeat on purpose. Every other kind is
 * something GlitchTip goes and fetches, and a test that creates one points
 * this machine's uptime worker at a third party for as long as the test
 * lives. A heartbeat is watched by silence, so nothing leaves the stack.
 *
 * The seeded monitor is an HTTP one, created straight through the ORM so it
 * skips the validator that would reject a private address — its URL is this
 * stack's own, so if the worker does pick it up the traffic stays here.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-up-${process.pid}-${Date.now().toString(36)}`;
const MEMBER = `${RUN}-member@example.com`;
const WATCHED = `${RUN}-checkout`;
const MADE = `${RUN}-nightly`;
const RENAMED = `${RUN}-nightly-renamed`;
const PAGE = `${RUN}-status`;
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
from apps.uptime.models import Monitor, MonitorCheck
from apps.uptime.constants import MonitorType, MonitorCheckReason
from glitchtip.partition_manager import UUID7Helper
from django.utils import timezone
from datetime import timedelta
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
u=User.objects.create_user(email=${JSON.stringify(MEMBER)}, password=${JSON.stringify(PASSWORD)}, is_active=True)
EmailAddress.objects.update_or_create(user=u, email=${JSON.stringify(MEMBER)}, defaults={'primary': True, 'verified': True})
role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='member'][0]
OrganizationUser.objects.create(user=u, organization=org, role=role)
now=timezone.now()
m=Monitor.objects.create(organization=org, name=${JSON.stringify(WATCHED)}, monitor_type=MonitorType.GET,
  url='http://localhost:8000/api/0/', expected_status=200, expected_body='', interval=300,
  timeout=10, confirmation_threshold=2)
for minutes, up, reason, took, change in [(2, True, None, 120, True), (30, False, MonitorCheckReason.TIMEOUT, None, True), (60, True, None, 95, False)]:
    MonitorCheck.objects.create(id=UUID7Helper.from_datetime(now-timedelta(minutes=minutes)), monitor=m,
      organization=org, is_up=up, reason=reason, response_time=took, is_change=change, data={})
print('monitor ' + str(m.id))`);
  return out.match(/^monitor (\d+)$/m)?.[1];
}

function cleanup() {
  django(`
from django.contrib.auth import get_user_model
from apps.uptime.models import Monitor, StatusPage
from apps.organizations_ext.models import Organization
org=Organization.objects.get(slug=${JSON.stringify(ORG)})
get_user_model().objects.filter(email__in=${JSON.stringify([MEMBER])}).delete()
Monitor.objects.filter(organization=org, name__in=${JSON.stringify([WATCHED, MADE, RENAMED])}).delete()
StatusPage.objects.filter(organization=org, name__in=${JSON.stringify([PAGE])}).delete()
print('clean')`);
}

/** What GlitchTip holds, read through the browser's own session. */
async function monitors(page) {
  return page.evaluate(async (org) => {
    const res = await fetch(`/api/0/organizations/${encodeURIComponent(org)}/monitors/`,
      { credentials: "same-origin", cache: "no-store" });
    return res.ok ? await res.json() : { failed: res.status };
  }, ORG);
}

async function settles(page, decide, { attempts = 20, every = 300 } = {}) {
  let last = null;
  for (let at = 0; at < attempts; at += 1) {
    last = await monitors(page);
    const found = Array.isArray(last) ? last.find(decide) : null;
    if (found) return found;
    await page.waitForTimeout(every);
  }
  throw new Error(`GlitchTip never agreed: ${JSON.stringify(last)}`);
}

async function signIn(page, email) {
  await page.goto(`${BASE}/sentinel/signin`);
  await page.fill("#email-input", email);
  await page.fill("#password-input", PASSWORD);
  await page.click(".gate-card button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#topbar")?.hidden, null, { timeout: 20_000 });
}

const view = (page) => page.locator("#view").innerText();

const SEEDED = seed();
const browser = await chromium.launch();
const errors = [];
try {
  process.stdout.write(`\nUptime (organisation: ${ORG})\n`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, MEMBER);

  await test("Uptime is a screen here, and the GlitchTip block is gone with it", async () => {
    assert(await page.locator("#nav-uptime").isVisible(), "Uptime is not in the sidebar");
    assert(await page.locator("#nav-uptime").getAttribute("href") === "/sentinel/uptime", "it points elsewhere");
    // Every link that block held is a screen now, so the block itself went.
    assert(await page.locator(".sidebar-external").count() === 0, "the external nav block survived");
  });

  await test("the list shows what is watched and whether it answered", async () => {
    await page.goto(`${BASE}/sentinel/uptime?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${WATCHED}`);
    const row = await page.locator("tr", { hasText: WATCHED }).innerText();
    assert(row.includes("GET"), `kind missing: ${row}`);
    assert(row.includes("every 5m"), `interval is not readable: ${row}`);
  });

  await test("one monitor opens with its settings and its checks", async () => {
    await page.getByRole("link", { name: WATCHED }).click();
    await page.waitForSelector("dl.release-facts");
    const body = await view(page);
    for (const wanted of ["every 5m", "10s", "2 in a row", "Timed out", "120 ms"]) {
      assert(body.includes(wanted), `detail is missing ${wanted}: ${body}`);
    }
  });

  await test("a member is offered the controls, because GlitchTip asks for nothing more", async () => {
    /**
     * These endpoints declare no permission decorator at all — membership is
     * the whole check — so hiding create or delete from a member would take
     * away something GlitchTip lets them do from its own screen.
     */
    assert(await page.getByRole("button", { name: "Delete monitor" }).isVisible(), "no delete for a member");
    assert(await page.getByRole("button", { name: "Save monitor" }).isVisible(), "no save for a member");
  });

  await test("the form asks for what the kind needs, and nothing else", async () => {
    await page.goto(`${BASE}/sentinel/uptime/new?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector("#monitor-type");
    assert(await page.locator("#monitor-url").isVisible(), "a GET monitor has nowhere to look");
    assert(await page.locator("#monitor-status").isVisible(), "a GET monitor expects a status");
    await page.selectOption("#monitor-type", "Heartbeat");
    assert(await page.locator("#monitor-url").isHidden(), "a heartbeat was asked for a URL");
    assert(await page.locator("#monitor-status").isHidden(), "a heartbeat was asked for a status");
    await page.selectOption("#monitor-type", "TCP Port");
    assert(await page.locator("#monitor-url").isVisible(), "a port monitor needs a host");
    assert((await page.locator("label[for=monitor-url], .field").allInnerTexts()).join(" ").includes("Host and port"),
      "a port monitor's field is still called URL");
  });

  await test("it says what is missing before GlitchTip has to", async () => {
    await page.selectOption("#monitor-type", "Heartbeat");
    await page.fill("#monitor-name", "");
    await page.getByRole("button", { name: "Create monitor" }).click();
    await page.waitForSelector(".form-problems li");
    assert((await view(page)).includes("Give it a name"), "no complaint about the missing name");
    // And nothing was sent: still on the form, not on a monitor's screen.
    assert(page.url().includes("/uptime/new"), `it navigated anyway: ${page.url()}`);
  });

  await test("a heartbeat monitor can be made, and says where to call in", async () => {
    await page.fill("#monitor-name", MADE);
    await page.fill("#monitor-interval", "86400");
    await page.fill("#monitor-threshold", "3");
    await page.getByRole("button", { name: "Create monitor" }).click();
    await page.waitForSelector("dl.release-facts");
    const made = await settles(page, (one) => one.name === MADE);
    assert(made.monitorType === "Heartbeat", `wrong kind: ${made.monitorType}`);
    assert(made.interval === 86400, `wrong interval: ${made.interval}`);
    // The address itself, not the heading above it — section headings are
    // uppercased by CSS, and innerText reads what is rendered.
    const body = await view(page);
    assert(body.includes(`/${ORG}/heartbeat_check/${made.endpointID}/`),
      `the heartbeat address is missing or wrong: ${body}`);
    assert(body.toLowerCase().includes("where to call in"), "no heading over it");
  });

  await test("renaming it keeps everything else, which the API does not do by itself", async () => {
    /**
     * The trap this phase is built around. GlitchTip's update assigns every
     * field of the payload onto the monitor, so a form that sent only the
     * name would clear the interval and the threshold along with it.
     */
    await page.fill("#monitor-name", RENAMED);
    await page.getByRole("button", { name: "Save monitor" }).click();
    const saved = await settles(page, (one) => one.name === RENAMED);
    assert(saved.interval === 86400, `the interval was lost: ${saved.interval}`);
    assert(saved.confirmationThreshold === 3, `the threshold was lost: ${saved.confirmationThreshold}`);
    assert(saved.monitorType === "Heartbeat", `the kind was lost: ${saved.monitorType}`);
  });

  await test("and it can be deleted", async () => {
    await page.getByRole("button", { name: "Delete monitor" }).click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), RENAMED);
    const left = await monitors(page);
    assert(!left.some((one) => one.name === RENAMED), "GlitchTip still has the monitor");
  });

  await test("status pages are a tab beside the monitors, not a section of their own", async () => {
    await page.goto(`${BASE}/sentinel/uptime/status-pages?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".sub-tab.current");
    assert(await page.locator(".sub-tab.current").innerText() === "Status pages", "the tab is not marked");
    // The limitation, said on the screen rather than discovered afterwards.
    const body = await view(page);
    assert(body.includes("cannot be set from here"), `the API's limit is not explained: ${body}`);
  });

  await test("a status page can be made, and says who can see it", async () => {
    /**
     * List and create is the whole API: no read, no update, no delete, and
     * `StatusPageIn` takes only a name and whether it is public — so a page
     * is necessarily created empty and this is all there is to test.
     */
    await page.fill("#page-name", PAGE);
    await page.check("#page-public");
    await page.getByRole("button", { name: "Create status page" }).click();
    await page.waitForSelector(`text=${PAGE}`);
    // Lower-cased: the chip is uppercased by CSS and innerText reads what is
    // rendered, not what the element was given.
    const row = (await page.locator("tr", { hasText: PAGE }).innerText()).toLowerCase();
    assert(row.includes("public"), `it did not come back public: ${row}`);
    assert(row.includes("0"), `a new page should hold no monitors: ${row}`);

    const made = await page.evaluate(async ([org, wanted]) => {
      const res = await fetch(`/api/0/organizations/${encodeURIComponent(org)}/status-pages/`,
        { credentials: "same-origin", cache: "no-store" });
      return res.ok ? (await res.json()).find((one) => one.name === wanted) || null : { failed: res.status };
    }, [ORG, PAGE]);
    assert(made && made.isPublic === true, `GlitchTip did not keep it: ${JSON.stringify(made)}`);
    assert(made.slug, "no slug, so the public page has no address");
  });

  await test("a monitor id that is not there says so", async () => {
    await page.goto(`${BASE}/sentinel/uptime/999999999?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".error");
    assert((await view(page)).match(/isn't there|don't have access/), "no explanation shown");
  });

  await test("nothing on these screens threw", async () => {
    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
  });

  await test("it leaves nothing of its own behind", async () => {
    const left = await monitors(page);
    const mine = Array.isArray(left) ? left.filter((one) => String(one.name || "").startsWith(RUN)) : [];
    assert(mine.length === 1 && mine[0].name === WATCHED,
      `left behind: ${mine.map((one) => one.name).join(", ")}`);
    assert(String(SEEDED).length > 0, "the seeded monitor id was never read back");
  });

  await context.close();
} finally {
  await browser.close();
  cleanup();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
