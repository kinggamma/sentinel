#!/usr/bin/env node
/**
 * Making, changing and deleting things: projects, alerts, environments,
 * teams and members, driven through the screens.
 *
 * Everything else here checks that addresses answer and that guards refuse.
 * None of it presses a button that writes, which is most of Phases 4 and 5 —
 * and the failures those phases actually had were all on the writing side: a
 * control offered to a role that gets a 404, a form posting a field the
 * endpoint ignores, a select shared by every row so the wrong team is sent.
 *
 * Safe by construction, which is the difference between this and the
 * organisation suite. It moves nothing that already exists and restarts
 * nothing. Every object it touches is one it made — a project, a team, an
 * alert, all named after this run — and each is removed again. The two
 * exceptions are stated plainly because they are real:
 *
 *   - it raises the smoke account's role, because the whole point is
 *     exercising what a role permits, and puts it back;
 *   - it hides and unhides one existing environment, which is reversible and
 *     visible only as a filter entry.
 *
 * It never touches a real project, a real report, or anybody's membership.
 *
 *   docker compose up -d && npm install && npm run test:manage
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const MOUNT = `${BASE}/sentinel`;
const EMAIL = process.env.SMOKE_EMAIL || "sentinel-smoke@example.com";

/** Named after the run, so two runs cannot collide and cleanup is exact. */
const RUN = `suite${process.pid}`;
const PROJECT = `${RUN}-project`;
const TEAM = `${RUN}-team`;

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

function django(python) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "glitchtip-web", "./manage.py", "shell", "-c", python],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
}

const minted = [];

function session() {
  const [key, org] = execFileSync("bash", ["scripts/seed-smoke-session.sh"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
    .trim()
    .split(/\s+/);
  assert(key, "seed-smoke-session.sh printed no session key");
  minted.push(key);
  return { key, org };
}

function clearSessions() {
  for (const key of minted.splice(0)) {
    try {
      execFileSync("bash", ["scripts/seed-smoke-session.sh", "--clear", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Reported by the check at the end rather than thrown from cleanup.
    }
  }
}

/** The role decides which controls exist, so it is the fixture. */
function setRole(role) {
  const out = django(`
from django.apps import apps
from django.contrib.auth import get_user_model
OrgUser = apps.get_model('organizations_ext','OrganizationUser')
u = get_user_model().objects.get(email=${JSON.stringify(EMAIL)})
ou = OrgUser.objects.get(user=u, organization__slug=${JSON.stringify(process.env.GLITCHTIP_ORG || "almareem")})
ou.role = [r for r in ou._meta.get_field('role').choices if r[1].lower()==${JSON.stringify(role)}][0][0]
ou.save()
print("role", ou.get_role_display())`);
  assert(out.toLowerCase().includes(role), `could not set the role to ${role}: ${out.trim()}`);
}

const ORG = process.env.GLITCHTIP_ORG || "almareem";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask GlitchTip what is actually there, rather than trusting the screen. */
async function api(path, key) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: `sessionid=${key}` } });
  if (res.status !== 200) return null;
  return res.json();
}

async function main() {
  process.stdout.write("\nMaking and unmaking things\n");

  let browser;
  let elevated = false;

  try {
    /**
     * Anything a previous run left, before this one adds to it.
     *
     * Earlier versions of this suite failed partway and stranded a project
     * and two teams, which then sat in a real organisation looking like
     * somebody's work. Sweeping every run's prefix rather than only this
     * one's means a run that dies is repaired by the next instead of
     * accumulating.
     */
    django(`
from django.apps import apps
Project = apps.get_model('projects','Project')
Team = apps.get_model('teams','Team')
project = Project.objects.filter(slug__startswith='suite', slug__endswith='-project').delete()
team = Team.objects.filter(slug__startswith='suite', slug__endswith='-team').delete()
print("swept", project, team)`);

    setRole("manager");
    elevated = true;
    const { key } = session();

    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addCookies([
      { name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true },
    ]);
    const page = await context.newPage();
    const broke = [];
    page.on("pageerror", (error) => broke.push(error.message));

    const section = (title) =>
      page.locator(".detail-section").filter({ has: page.locator("h3", { hasText: title }) });

    // ------------------------------------------------------------ projects

    await test("a project can be made from the screen", async () => {
      await page.goto(`${MOUNT}/projects/new`, { waitUntil: "networkidle" });
      await page.waitForSelector("#new-project-name", { timeout: 15_000 });
      await page.fill("#new-project-name", PROJECT);
      await page.click("#view form button[type=submit]");
      await page.waitForFunction(
        (slug) => location.pathname.endsWith(`/projects/${slug}`),
        PROJECT,
        { timeout: 20_000 }
      );

      const projects = await api(`/api/0/organizations/${ORG}/projects/`, key);
      assert(
        (projects || []).some((one) => one.slug === PROJECT),
        "GlitchTip does not have the project the screen said it made"
      );
    });

    await test("its name can be changed", async () => {
      await page.waitForSelector("#project-name", { timeout: 15_000 });
      await page.fill("#project-name", `${PROJECT} renamed`);
      await section("Settings").locator("form button[type=submit]").click();
      await page.waitForTimeout(3000);

      const detail = await api(`/api/0/projects/${ORG}/${PROJECT}/`, key);
      assert(detail?.name === `${PROJECT} renamed`, `GlitchTip still calls it ${detail?.name}`);
    });

    await test("a key can be added and revoked, and the last one cannot", async () => {
      const keys = () => section("Where this project's errors come from");
      const before = (await api(`/api/0/projects/${ORG}/${PROJECT}/keys/`, key)) || [];

      // One key: revoking it would leave nothing to report to, so it is not offered.
      assert(before.length === 1, `expected one key to start with, found ${before.length}`);
      assert(
        (await keys().locator("button", { hasText: "Revoke" }).count()) === 0,
        "offered to revoke the only key"
      );

      await keys().locator("button", { hasText: "Add a key" }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".dsn-row").length > 1 ||
          document.querySelector(".detail-section .error:not([hidden])"),
        { timeout: 20_000 }
      );
      const after = (await api(`/api/0/projects/${ORG}/${PROJECT}/keys/`, key)) || [];
      assert(after.length === 2, `expected two keys, found ${after.length}`);

      // Now revoking is offered, and asks first.
      await keys().locator("button", { hasText: "Revoke" }).first().click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.locator(".modal button", { hasText: "Revoke it" }).click();
      await page.waitForTimeout(4000);
      const left = (await api(`/api/0/projects/${ORG}/${PROJECT}/keys/`, key)) || [];
      assert(left.length === 1, `expected one key after revoking, found ${left.length}`);
    });

    // -------------------------------------------------------------- alerts

    await test("an alert can be made, tested and deleted", async () => {
      await page.goto(`${MOUNT}/projects/${PROJECT}`, { waitUntil: "networkidle" });
      await page.waitForSelector("#alert-quantity", { timeout: 15_000 });

      await page.fill("#alert-name", `${RUN} alert`);
      await page.fill("#alert-quantity", "5");
      await page.fill("#alert-minutes", "30");
      await section("Alerts").locator("form button[type=submit]").click();
      await page.waitForTimeout(4000);

      const made = (await api(`/api/0/projects/${ORG}/${PROJECT}/alerts/`, key)) || [];
      assert(made.length === 1, `expected one alert, GlitchTip has ${made.length}`);
      assert(made[0].quantity === 5 && made[0].timespanMinutes === 30, "the numbers did not arrive");

      const row = section("Alerts").locator("li").filter({ hasText: `${RUN} alert` });
      await row.locator("button", { hasText: "Test" }).click();
      await page.waitForFunction(
        () => /:/.test(document.querySelector(".alert-results")?.textContent || ""),
        { timeout: 20_000 }
      );
      const outcome = await section("Alerts").locator(".alert-results").textContent();
      /**
       * What it says depends on the installation — "sent" where mail is
       * configured, "skipped" where it is not. What must not happen is
       * silence, or a tick that means nothing.
       */
      assert(
        /(sent|skipped|error)/i.test(outcome),
        `the test said nothing useful: ${JSON.stringify(outcome)}`
      );

      await row.locator("button", { hasText: "Delete" }).click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.locator(".modal button", { hasText: "Delete it" }).click();
      await page.waitForTimeout(4000);
      const gone = (await api(`/api/0/projects/${ORG}/${PROJECT}/alerts/`, key)) || [];
      assert(!gone.length, `${gone.length} alert(s) survived deletion`);
    });

    // -------------------------------------------------------- environments

    await test("an environment can be hidden and shown again", async () => {
      // On a real project, because a new one has never been reported to.
      await page.goto(`${MOUNT}/projects/e-library`, { waitUntil: "networkidle" });
      await page.waitForSelector(".detail-section", { timeout: 15_000 });

      if (!(await section("Environments").locator("button").count())) return; // none reported yet

      const name = (await section("Environments").locator("li .tag-value").first().textContent())
        .trim();
      /**
       * Asked for all of them, not the default.
       *
       * The default view is visible-only, so a hidden environment is simply
       * absent from it — and "absent" would read here as "unchanged", which
       * is how this check passed a screen that could hide but never show.
       */
      const stateOf = async () => {
        const all =
          (await api(`/api/0/projects/${ORG}/e-library/environments/?visibility=all`, key)) || [];
        const found = all.find((one) => one.name === name);
        assert(found, `${name} vanished from the environment list entirely`);
        return found.isHidden;
      };

      // Starts from whatever it is, so a previous run or a real preference
      // does not decide whether this passes — and ends where it started.
      const started = await stateOf();
      const flip = async (label) => {
        await page.goto(`${MOUNT}/projects/e-library`, { waitUntil: "networkidle" });
        await page.waitForSelector(".detail-section", { timeout: 15_000 });
        const button = section("Environments").locator("button", { hasText: label }).first();
        assert(await button.count(), `no ${label} button for ${name}`);
        await button.click();
        await page.waitForTimeout(4000);
      };

      await flip(started ? "Show" : "Hide");
      assert(
        (await stateOf()) === !started,
        `${name} did not change: still ${(await stateOf()) ? "hidden" : "shown"}`
      );

      await flip(started ? "Hide" : "Show");
      assert(
        (await stateOf()) === started,
        `${name} was left ${(await stateOf()) ? "hidden" : "shown"} — it must go back`
      );
    });

    // --------------------------------------------------------------- teams

    await test("a team can be made, filled, pointed at a project, and deleted", async () => {
      await page.goto(`${MOUNT}/teams/new`, { waitUntil: "networkidle" });
      await page.waitForSelector("#new-team-slug", { timeout: 15_000 });
      await page.fill("#new-team-slug", TEAM);
      await page.click("#view form button[type=submit]");
      await page.waitForFunction((slug) => location.pathname.endsWith(`/teams/${slug}`), TEAM, {
        timeout: 20_000,
      });

      // Whoever makes it is in it, which is what makes the next step possible.
      const members = (await api(`/api/0/teams/${ORG}/${TEAM}/members/`, key)) || [];
      assert(members.length === 1, `expected the creator to be in it, found ${members.length}`);

      const projects = section("What it can see");
      await projects.locator("select").selectOption(PROJECT);
      await projects.locator("button", { hasText: "Add" }).click();
      await page.waitForTimeout(4000);
      const reaches = (await api(`/api/0/teams/${ORG}/${TEAM}/projects/`, key)) || [];
      assert(
        reaches.some((one) => one.slug === PROJECT),
        "the project was not added to the team"
      );

      // And removing it asks first.
      await section("What it can see").locator("button", { hasText: "Remove" }).first().click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.locator(".modal button", { hasText: "Remove it" }).click();
      await page.waitForTimeout(4000);
      const after = (await api(`/api/0/teams/${ORG}/${TEAM}/projects/`, key)) || [];
      assert(!after.some((one) => one.slug === PROJECT), "the project stayed in the team");
    });

    // -------------------------------------------------------------- people

    await test("a member sees no queue, and a manager does", async () => {
      /**
       * The queue holds applicants' addresses and admits people with a
       * credential stronger than the person clicking, so who can see it is
       * the security property worth pinning.
       */
      const managerSees = await fetch(`${BASE}/sentinel/api/access/requests`, {
        headers: { Cookie: `sessionid=${key}` },
      });
      assert(managerSees.status === 200, `a manager was refused the queue (${managerSees.status})`);

      setRole("member");
      const asMember = session();
      const refused = await fetch(`${BASE}/sentinel/api/access/requests`, {
        headers: { Cookie: `sessionid=${asMember.key}` },
      });
      assert(refused.status === 403, `an ordinary member could read the queue (${refused.status})`);

      setRole("manager");
    });

    await test("the invitation form offers a team, so nobody is invited into none", async () => {
      const fresh = session();
      const other = await browser.newContext();
      await other.addCookies([
        { name: "sessionid", value: fresh.key, domain: "localhost", path: "/", httpOnly: true },
      ]);
      const view = await other.newPage();
      await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
      await view.waitForSelector("#invite-email", { timeout: 15_000 });

      const teams = await view.evaluate(() =>
        [...(document.getElementById("invite-team")?.options || [])].map((o) => o.value)
      );
      assert(teams.length, "no team to invite into — every invitation would see nothing");
      assert(teams.includes(TEAM), `the team this run made is not offered: ${teams.join(", ")}`);
      await other.close();
    });

    await test("nobody may change their own row", async () => {
      /**
       * Its own session and its own window.
       *
       * The long-lived context this suite drives loses its session partway
       * through a run that changes roles — /auth/me still answers 200, but
       * answers it as nobody, and the app does the right thing with that and
       * goes to sign-in. Why the cookie stops being sent is not yet
       * understood and is worth chasing separately; what it must not do is
       * quietly turn a real check into a timeout on a selector.
       *
       * So this asks the question on a session minted for it, which is also
       * the more honest fixture: the answer depends on a role, and a session
       * created after that role was set is the one that has it.
       */
      const fresh = session();
      const own = await browser.newContext();
      await own.addCookies([
        { name: "sessionid", value: fresh.key, domain: "localhost", path: "/", httpOnly: true },
      ]);
      const view = await own.newPage();
      await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
      await view.waitForSelector("#view tbody tr", { timeout: 15_000 }).catch(async () => {
        const seen = (await view.textContent("#view")) || "";
        assert(false, `no member list at ${view.url()} — the screen said: ${seen.replace(/\s+/g, " ").trim().slice(0, 200)}`);
      });
      const mine = view.locator("#view tbody tr").filter({ hasText: EMAIL });
      assert(await mine.count(), "the signed-in account is not in the list");
      assert(
        (await mine.locator("select").count()) === 0 &&
          (await mine.locator("button", { hasText: "Remove" }).count()) === 0,
        "offered to change or remove your own membership"
      );
      await own.close();
    });

    await test("nothing on these screens threw", () => {
      assert(!broke.length, `page errors: ${broke.join("; ")}`);
    });
  } finally {
    if (browser) await browser.close();

    /**
     * Each in its own block, so one failing does not strand the others —
     * and the role last, because it is the one that changes what a real
     * person can do.
     */
    /**
     * A session minted now, not the one the tests ran on.
     *
     * Reusing the first one answered 401 here: several were signed in during
     * the run, and the earliest is the likeliest to have been invalidated by
     * the time cleanup needs it. Cleanup deletes real objects, so it gets a
     * credential it knows is good rather than the oldest one lying around.
     */
    try {
      const { key } = session();
      const csrf = await tokenFor(key);
      if (csrf) {
        await remove(`/api/0/teams/${ORG}/${TEAM}/`, key, csrf);
        await remove(`/api/0/projects/${ORG}/${PROJECT}/`, key, csrf);
      } else {
        process.stdout.write("  ! no CSRF token for cleanup\n");
      }
    } catch (error) {
      process.stdout.write(`  ! cleanup could not sign in: ${error.message}\n`);
    }

    try {
      if (elevated) setRole("member");
    } catch (error) {
      process.stdout.write(`  ! could not put the role back: ${error.message}\n`);
    }

    clearSessions();
  }

  // Checked rather than hoped: this made real objects in a real GlitchTip.
  await test("it leaves nothing of its own behind", async () => {
    const { key } = session();
    const projects = (await api(`/api/0/organizations/${ORG}/projects/`, key)) || [];
    const teams = (await api(`/api/0/organizations/${ORG}/teams/`, key)) || [];
    assert(!projects.some((one) => one.slug === PROJECT), `${PROJECT} was left behind`);
    assert(!teams.some((one) => one.slug === TEAM), `${TEAM} was left behind`);

    const me = await api("/sentinel/api/auth/me", key);
    assert(
      me?.orgRoles?.[ORG]?.role === "member",
      `the role was left as ${me?.orgRoles?.[ORG]?.role}`
    );
    clearSessions();
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

async function tokenFor(key) {
  const res = await fetch(`${BASE}/_allauth/browser/v1/auth/session`, {
    headers: { Cookie: `sessionid=${key}` },
  });
  return (res.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1] || null;
}

async function remove(path, key, csrf) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: {
        Cookie: `sessionid=${key}; csrftoken=${csrf}`,
        "x-csrftoken": csrf,
      },
    });
    // Said out loud. A silent cleanup failure is how the check at the end
    // ends up reporting a leak with no clue why it happened.
    if (res.status >= 400) {
      process.stdout.write(`  ! cleanup of ${path} answered ${res.status}\n`);
    }
  } catch (error) {
    process.stdout.write(`  ! cleanup of ${path} threw: ${error.message}\n`);
  }
}

main().catch((error) => {
  clearSessions();
  process.stdout.write(`\nsuite could not run: ${error.stack || error.message}\n`);
  process.exit(1);
});
