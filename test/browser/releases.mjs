#!/usr/bin/env node
/**
 * Phase 8a in a browser, against a release this run owns.
 *
 * Two things here are worth more than the screen rendering. GlitchTip grants
 * project:releases to every role including member, so the delete button has
 * to be offered to a member — and the release update endpoint replaces both
 * of its fields whatever the payload contains, so saving a ref must not
 * silently stamp the release as shipped. Both are checked at the API rather
 * than by reading the page back, because the page would look right either
 * way.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const RUN = `sentinel-rel-${process.pid}-${Date.now().toString(36)}`;
const MEMBER = `${RUN}-member@example.com`;
const VERSION = `${RUN}-1.0.0`;
const OTHER = `${RUN}-2.0.0`;
const ENVIRONMENT = `${RUN}-production`;
const FILE = `${RUN}-app.js.map`;
const WITH_FILE = `${RUN}-3.0.0`;
const BUNDLED = `${RUN}-bundled.js.map`;
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
from apps.releases.models import Release, Deploy
from apps.files.models import File
from apps.sourcecode.models import DebugSymbolBundle
from django.utils import timezone
from uuid import uuid4
User=get_user_model(); org=Organization.objects.get(slug=${JSON.stringify(ORG)})
u=User.objects.create_user(email=${JSON.stringify(MEMBER)}, password=${JSON.stringify(PASSWORD)}, is_active=True)
EmailAddress.objects.update_or_create(user=u, email=${JSON.stringify(MEMBER)}, defaults={'primary': True, 'verified': True})
role=[v for v,n in OrganizationUser._meta.get_field('role').choices if n.lower()=='member'][0]
OrganizationUser.objects.create(user=u, organization=org, role=role)

r=Release.objects.create(organization=org, version=${JSON.stringify(VERSION)}, ref='main', commit_count=2, deploy_count=1,
  data={'commits': [
    {'id': 'f'*40, 'message': 'Stop the thing breaking\\n\\nA longer body nobody reads', 'authorName': 'Somebody'},
    {'id': 'e'*40, 'message': 'Tidy up', 'authorEmail': 'else@example.com'}]})
project=org.projects.first()
if project: r.projects.add(project)
Deploy.objects.create(release=r, environment=${JSON.stringify(ENVIRONMENT)}, url='https://deploys.example.com/1',
  date_started=timezone.now(), date_finished=timezone.now())
f=File.objects.create(name=${JSON.stringify(FILE)}, type='release.file', size=2048, headers={})
DebugSymbolBundle.objects.create(organization=org, release=r, file=f, debug_id=uuid4())

Release.objects.create(organization=org, version=${JSON.stringify(OTHER)})

# A release still holding a file, to find out what deleting one does: the
# bundle's release is SET_NULL and a check constraint demands it keep either
# a release or a debug id, so a bundle without one cannot survive the update.
keep=Release.objects.create(organization=org, version=${JSON.stringify(WITH_FILE)})
bf=File.objects.create(name=${JSON.stringify(BUNDLED)}, type='release.file', size=4096, headers={})
DebugSymbolBundle.objects.create(organization=org, release=keep, file=bf, debug_id=uuid4())
print('seeded')`);
}

function cleanup() {
  /**
   * Bundles first. A release delete sets its bundles' release to null, and a
   * check constraint refuses a bundle that then has neither a release nor a
   * debug id — so removing the bundle is the only order that works.
   */
  django(`
from django.contrib.auth import get_user_model
from apps.releases.models import Release
from apps.files.models import File
from apps.sourcecode.models import DebugSymbolBundle
versions=${JSON.stringify([VERSION, OTHER, WITH_FILE])}
get_user_model().objects.filter(email__in=${JSON.stringify([MEMBER])}).delete()
DebugSymbolBundle.objects.filter(release__organization__slug=${JSON.stringify(ORG)}, release__version__in=versions).delete()
Release.objects.filter(organization__slug=${JSON.stringify(ORG)}, version__in=versions).delete()
File.objects.filter(name__in=${JSON.stringify([FILE, BUNDLED])}).delete()
print('clean')`);
}

/** What GlitchTip itself holds, read with the browser's own session. */
async function release(page, version = VERSION) {
  return page.evaluate(async ([org, wanted]) => {
    const res = await fetch(`/api/0/organizations/${encodeURIComponent(org)}/releases/${encodeURIComponent(wanted)}/`,
      { credentials: "same-origin", cache: "no-store" });
    return res.ok ? await res.json() : { failed: res.status };
  }, [ORG, version]);
}

/**
 * Wait for GlitchTip to agree, polled from here rather than from the page:
 * an async predicate handed to waitForFunction succeeds on its first poll
 * whatever it eventually answers, so it proves nothing about a write.
 */
async function settles(page, decide, { attempts = 20, every = 300 } = {}) {
  let last = null;
  for (let at = 0; at < attempts; at += 1) {
    last = await release(page);
    if (last && !last.failed && decide(last)) return last;
    await page.waitForTimeout(every);
  }
  throw new Error(`release never settled: ${JSON.stringify(last)}`);
}

async function signIn(page, email) {
  await page.goto(`${BASE}/sentinel/signin`);
  await page.fill("#email-input", email);
  await page.fill("#password-input", PASSWORD);
  await page.click(".gate-card button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#topbar")?.hidden, null, { timeout: 20_000 });
}

seed();
const browser = await chromium.launch();
const errors = [];
try {
  process.stdout.write(`\nReleases (organisation: ${ORG})\n`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, MEMBER);

  await test("the sidebar offers Releases as a screen here, not a link out", async () => {
    assert(await page.locator("#nav-releases").isVisible(), "Releases is not in the sidebar");
    const href = await page.locator("#nav-releases").getAttribute("href");
    assert(href === "/sentinel/releases", `Releases points at ${href}`);
    assert(await page.locator("#nav-releases").getAttribute("target") === null, "Releases still opens a new tab");
  });

  await test("the list shows the organisation's releases", async () => {
    await page.goto(`${BASE}/sentinel/releases?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${VERSION}`);
    await page.waitForSelector(`text=${OTHER}`);
  });

  await test("a release opens its own screen, with what went into it", async () => {
    await page.getByRole("link", { name: VERSION }).click();
    await page.waitForSelector("h2.mono");
    const body = await page.locator("#view").innerText();
    for (const wanted of ["Stop the thing breaking", "Somebody", ENVIRONMENT, FILE, "2.0 kB"]) {
      assert(body.includes(wanted), `detail is missing ${wanted}: ${body}`);
    }
    // The subject only — a commit body in a table cell is a wall of text.
    assert(!body.includes("A longer body nobody reads"), "the commit body reached the table");
  });

  await test("a member is offered the delete controls, because GlitchTip allows them", async () => {
    /**
     * project:releases sits in the member scope set and the release endpoints
     * ask for nothing else. Hiding these behind an admin check would take a
     * control away from somebody GlitchTip lets use it.
     */
    assert(await page.getByRole("button", { name: "Delete release" }).isVisible(), "no delete for a member");
    assert(await page.getByRole("button", { name: "Save release" }).isVisible(), "no save for a member");
  });

  await test("saving a ref does not quietly mark the release as shipped", async () => {
    /**
     * The trap this phase is built around. GlitchTip's update schema defaults
     * dateReleased to now and its handler writes back every field, so a
     * payload that leaves the date out stamps it with the current time. The
     * release starts unreleased and must stay that way.
     */
    assert((await release(page)).dateReleased === null, "seed was already marked released");
    await page.fill("#release-ref", `${RUN}-ref`);
    await page.getByRole("button", { name: "Save release" }).click();
    const saved = await settles(page, (one) => one.ref === `${RUN}-ref`);
    assert(saved.ref === `${RUN}-ref`, `ref did not save: ${JSON.stringify(saved)}`);
    assert(saved.dateReleased === null, `saving a ref marked it released: ${saved.dateReleased}`);
    // And the screen came back showing it, rather than leaving the typed
    // value sitting in a field over a stale release.
    assert(await page.locator("#release-ref").inputValue() === `${RUN}-ref`, "the re-render lost the ref");
  });

  await test("and a date can be set, and then cleared again", async () => {
    await page.fill("#release-date", "2026-03-04T05:06");
    await page.getByRole("button", { name: "Save release" }).click();
    const saved = await settles(page, (one) => Boolean(one.dateReleased));
    assert(new Date(saved.dateReleased).getTime() === new Date(2026, 2, 4, 5, 6).getTime(),
      `date came back as ${saved.dateReleased}`);
    // The other half of the same trap, in the other direction.
    assert(saved.ref === `${RUN}-ref`, "saving the date dropped the ref");

    await page.fill("#release-date", "");
    await page.getByRole("button", { name: "Save release" }).click();
    const cleared = await settles(page, (one) => one.dateReleased === null);
    assert(cleared.dateReleased === null, `clearing the date left ${cleared.dateReleased}`);
    assert(cleared.ref === `${RUN}-ref`, "clearing the date dropped the ref");
  });

  await test("a file can be deleted from the release", async () => {
    await page.goto(`${BASE}/sentinel/releases/${encodeURIComponent(VERSION)}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${FILE}`);
    await page.locator("tr", { hasText: FILE }).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), FILE);
  });

  await test("a release can be deleted, and the list stops offering it", async () => {
    await page.goto(`${BASE}/sentinel/releases/${encodeURIComponent(OTHER)}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector("h2.mono");
    await page.getByRole("button", { name: "Delete release" }).click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), OTHER);
    assert((await release(page, OTHER)).failed === 404, "GlitchTip still has the release");
  });

  await test("a release that still holds a file can be deleted", async () => {
    /**
     * Not the same case as the one above. Deleting a release detaches its
     * debug-symbol bundles rather than removing them, and a bundle is only
     * allowed to lose its release if it has a debug id to be found by
     * instead — so this is the path where a delete can fail on a constraint
     * the screen knows nothing about.
     */
    await page.goto(`${BASE}/sentinel/releases/${encodeURIComponent(WITH_FILE)}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(`text=${BUNDLED}`);
    await page.getByRole("button", { name: "Delete release" }).click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await page.waitForFunction((name) => !document.body.innerText.includes(name), WITH_FILE);
    assert((await release(page, WITH_FILE)).failed === 404, "GlitchTip still has the release");
  });

  await test("a version that does not exist says so, rather than rendering an empty release", async () => {
    await page.goto(`${BASE}/sentinel/releases/${encodeURIComponent(`${RUN}-nope`)}?org=${encodeURIComponent(ORG)}`);
    await page.waitForSelector(".error");
    assert((await page.locator("#view").innerText()).match(/isn't there|don't have access/), "no explanation shown");
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
