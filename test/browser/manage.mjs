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
const MARKER = "sentinel-manage-suite";
const RUN = `${MARKER}-${process.pid}`;
const PROJECT = `${RUN}-project`;
const TEAM = `${RUN}-team`;
/** Invited, promoted, demoted and removed by this suite. Never a real person. */
const GUEST = `${RUN}@example.com`;

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
ou = OrgUser.objects.get(user=u, organization__slug=${JSON.stringify(ORG)})
ou.role = [r for r in ou._meta.get_field('role').choices if r[1].lower()==${JSON.stringify(role)}][0][0]
ou.save()
print("role", ou.get_role_display())`);
  assert(out.toLowerCase().includes(role), `could not set the role to ${role}: ${out.trim()}`);
}

/**
 * Which organisation, asked rather than assumed.
 *
 * This was the name of one particular installation's organisation, written
 * into a file in a public repository, and every check in here would have
 * failed on anybody else's deployment for a reason that looked like a bug in
 * the code under test.
 */
let ORG = "";

async function organisationOf(key) {
  const me = await api("/sentinel/api/auth/me", key);
  const [first] = me?.orgs || [];
  assert(first, "the smoke account belongs to no organisation");
  return first;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pending request, put straight into the receiver's own store.
 *
 * The queue is Sentinel's, not GlitchTip's, and the only way to get into it
 * is to be somebody with no organisation asking — which this account cannot
 * be while it is a manager. So the record goes in directly, and comes out
 * again by the same route.
 */
function receiverFile(python) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "feedback-receiver", "node", "-e", python],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
}

/**
 * Somebody with no organisation, who asks to be let in.
 *
 * The queue is Sentinel's own and is only written by the endpoint an
 * applicant posts to, from a session that belongs to nobody yet. Writing the
 * file directly does not work — the receiver reads it once and keeps it —
 * and restarting the receiver to make it notice would make this suite the
 * thing it was written not to be.
 *
 * So it makes a real applicant: a throwaway GlitchTip account in no
 * organisation, signed in the way the smoke script signs in, posting the
 * request itself. Deleted afterwards, account and all. Nothing shared is
 * touched, and the path being tested is the one people actually walk.
 */
function makeApplicant(email) {
  const password = `Ap-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  django(`
from django.contrib.auth import get_user_model
User = get_user_model()
user, _ = User.objects.get_or_create(email=${JSON.stringify(email)})
user.set_password(${JSON.stringify(password)})
user.is_active = True
user.save()
print("made")`);
  return { email, password };
}

function removeApplicant(email) {
  django(`
from django.contrib.auth import get_user_model
get_user_model().objects.filter(email=${JSON.stringify(email)}).delete()
print("removed")`);
}

/** Signs in as them and asks, which is the only way into the queue. */
async function askForAccess({ email, password }) {
  const jar = [];
  const keep = (res) => {
    for (const value of (res.headers.getSetCookie?.() || [])) jar.push(value.split(";")[0]);
  };
  const cookie = () => jar.join("; ");

  keep(await fetch(`${BASE}/_allauth/browser/v1/auth/session`, { headers: { cookie: cookie() } }));
  const csrf = jar.join("; ").match(/csrftoken=([^;]+)/)?.[1] || "";

  const login = await fetch(`${BASE}/_allauth/browser/v1/auth/login`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json", "x-csrftoken": csrf },
    body: JSON.stringify({ email, password }),
  });
  keep(login);
  const session = jar.join("; ").match(/sessionid=([^;]+)/)?.[1];
  assert(session, `the applicant could not sign in (${login.status})`);

  const token = await receiverToken();
  const asked = await fetch(`${BASE}/sentinel/api/access/request`, {
    method: "POST",
    headers: {
      cookie: `sessionid=${session}; sentinel-csrf=${token}`,
      "x-sentinel-csrf": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ note: "put here by the management suite" }),
  });
  assert(asked.status === 201, `asking for access answered ${asked.status}`);
  return session;
}

function seedRequest(email) {
  receiverFile(`
const fs = require("fs");
const path = "/data/access-requests.json";
const all = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
all[${JSON.stringify(email)}] = {
  id: ${JSON.stringify(email)},
  email: ${JSON.stringify(email)},
  name: null,
  note: "put here by the management suite",
  organisation: ${JSON.stringify(ORG)},
  status: "pending",
  requestedAt: new Date().toISOString(),
  decidedAt: null,
};
fs.writeFileSync(path, JSON.stringify(all, null, 2));
console.log("seeded");`);
}

function clearRequest(email) {
  receiverFile(`
const fs = require("fs");
const path = "/data/access-requests.json";
const all = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
delete all[${JSON.stringify(email)}];
fs.writeFileSync(path, JSON.stringify(all, null, 2));
console.log("cleared");`);
}

/**
 * The receiver's own CSRF token, which its writes require.
 *
 * Fetched once and kept. Calling this twice — once for the cookie and once
 * for the header — hands out two different tokens, and a double-submit check
 * comparing two different tokens refuses every time. Which is exactly what
 * it did.
 */
let receiverCsrf = null;

async function receiverToken() {
  if (receiverCsrf) return receiverCsrf;
  const res = await fetch(`${BASE}/sentinel/`, { headers: { accept: "text/html" } });
  receiverCsrf = (res.headers.get("set-cookie") || "").match(/sentinel-csrf=([^;]+)/)?.[1] || "";
  return receiverCsrf;
}

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
    // Before anything else: the role fixture and the sweep both name it.
    const opening = session();
    ORG = await organisationOf(opening.key);
    process.stdout.write(`  (organisation: ${ORG})\n`);

    /**
     * Anything a previous run of *this* suite left, and nothing else.
     *
     * The sweep matched slug__startswith='suite', which would have deleted a
     * real project or team belonging to somebody whose naming happened to
     * begin that way. The names this suite makes are a fixed marker followed
     * by the process id, so that is exactly what it removes — a pattern
     * nothing chosen by a person looks like.
     */
    django(`
import re
from django.apps import apps
Project = apps.get_model('projects','Project')
Team = apps.get_model('teams','Team')
mine = re.compile(r"^sentinel-manage-suite-\\d+-(project|team)$")
projects = [p.id for p in Project.objects.filter(slug__startswith=${JSON.stringify(MARKER)}) if mine.match(p.slug)]
teams = [t.id for t in Team.objects.filter(slug__startswith=${JSON.stringify(MARKER)}) if mine.match(t.slug)]
Project.objects.filter(id__in=projects).delete()
Team.objects.filter(id__in=teams).delete()
# And the throwaway accounts, which are only ever made by this suite.
# Matched in Python, not with startswith: the email column has a
# nondeterministic collation and Postgres refuses LIKE against it.
from django.contrib.auth import get_user_model
User = get_user_model()
stale = [u.id for u in User.objects.only("id", "email")
         if str(u.email or "").startswith(${JSON.stringify(MARKER)})]
User.objects.filter(id__in=stale).delete()
print("swept", len(projects), "project(s),", len(teams), "team(s),", len(stale), "account(s)")`);

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

    /**
     * A window of its own, on a session minted for it.
     *
     * The long-lived context loses its session partway through a run that
     * changes roles — /auth/me answers 200 and answers it as nobody, and the
     * app correctly goes to sign-in. Why the cookie stops being sent is not
     * understood and deserves chasing on its own; what it must not do is
     * turn a real check into a timeout waiting for a selector.
     *
     * It is also the better fixture where a check depends on a role: a
     * session created after the role was set is the one that has it.
     */
    const freshWindow = async () => {
      const fresh = session();
      const own = await browser.newContext();
      await own.addCookies([
        { name: "sessionid", value: fresh.key, domain: "localhost", path: "/", httpOnly: true },
      ]);
      const view = await own.newPage();
      view.on("pageerror", (error) => broke.push(error.message));
      return {
        view,
        // The session this window is using, for the checks that call the API
        // directly and must do so as whoever the window is.
        key: fresh.key,
        close: () => own.close(),
        section: (title) =>
          view.locator(".detail-section").filter({ has: view.locator("h3", { hasText: title }) }),
      };
    };

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

    await test("an alert can be made, edited, tested and deleted", async () => {
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

      // Editing the threshold, which is the half of a rule most likely to be
      // wrong on the first attempt and was previously unchangeable.
      const row = section("Alerts").locator("li").filter({ hasText: `${RUN} alert` });
      await row.locator("button", { hasText: "Edit" }).click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.fill(`#edit-quantity-${made[0].id}`, "25");
      await page.locator(".modal button", { hasText: "Save" }).click();
      await page.waitForTimeout(4000);
      const edited = (await api(`/api/0/projects/${ORG}/${PROJECT}/alerts/`, key)) || [];
      assert(edited[0]?.quantity === 25, `the threshold is ${edited[0]?.quantity}, not 25`);
      assert(
        (edited[0]?.alertRecipients || []).length === (made[0].alertRecipients || []).length,
        "editing the threshold changed who is told about it"
      );

      await section("Alerts").locator("li").filter({ hasText: `${RUN} alert` })
        .locator("button", { hasText: "Test" }).click();
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

      await section("Alerts").locator("li").filter({ hasText: `${RUN} alert` })
        .locator("button", { hasText: "Delete" }).click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.locator(".modal button", { hasText: "Delete it" }).click();
      await page.waitForTimeout(4000);
      const gone = (await api(`/api/0/projects/${ORG}/${PROJECT}/alerts/`, key)) || [];
      assert(!gone.length, `${gone.length} alert(s) survived deletion`);
    });

    // -------------------------------------------------------- environments

    await test("an environment can be hidden and shown again", async () => {
      /**
       * On this suite's own project, with an environment this suite puts
       * there.
       *
       * It used to hide and unhide one belonging to a real project, which is
       * somebody's filter list — and when no environment existed it returned
       * early and reported a pass, so the check most likely to be skipped was
       * the one that mattered. An environment only exists once something has
       * reported under it, so rather than wait for that, the rows go in
       * directly and come out again.
       */
      const NAME = `${RUN}-env`;
      django(`
from django.apps import apps
Environment = apps.get_model('environments','Environment')
EnvironmentProject = apps.get_model('environments','EnvironmentProject')
Project = apps.get_model('projects','Project')
project = Project.objects.get(slug=${JSON.stringify(PROJECT)})
environment, _ = Environment.objects.get_or_create(
    name=${JSON.stringify(NAME)}, organization=project.organization)
EnvironmentProject.objects.get_or_create(
    environment=environment, project=project, defaults={"is_hidden": False})
print("seeded")`);

      try {
        const stateOf = async () => {
          const all =
            (await api(`/api/0/projects/${ORG}/${PROJECT}/environments/?visibility=all`, key)) || [];
          const found = all.find((one) => one.name === NAME);
          assert(found, `${NAME} is not in the environment list at all`);
          return found.isHidden;
        };
        assert((await stateOf()) === false, "the seeded environment should start visible");

        const flip = async (label) => {
          await page.goto(`${MOUNT}/projects/${PROJECT}`, { waitUntil: "networkidle" });
          await page.waitForSelector(".detail-section", { timeout: 15_000 });
          const row = section("Environments").locator("li").filter({ hasText: NAME });
          const button = row.locator("button", { hasText: label });
          assert(await button.count(), `no ${label} button for ${NAME}`);
          await button.click();
          await page.waitForTimeout(4000);
        };

        await flip("Hide");
        assert((await stateOf()) === true, `${NAME} was not hidden`);

        // Still reachable, which is the whole difference between hiding and
        // deleting — the default list would no longer show it at all.
        await flip("Show");
        assert((await stateOf()) === false, `${NAME} could not be shown again`);
      } finally {
        django(`
from django.apps import apps
Environment = apps.get_model('environments','Environment')
Environment.objects.filter(name=${JSON.stringify(NAME)}).delete()
print("removed")`);
      }
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

    await test("a team can be deleted from its own screen", async () => {
      /**
       * Through the button, not through the cleanup that runs afterwards.
       * Cleanup deleting it proves the API works and says nothing about
       * whether anybody can reach that from the product.
       */
      await page.goto(`${MOUNT}/teams/${TEAM}`, { waitUntil: "networkidle" });
      await page.waitForSelector("#team-slug", { timeout: 15_000 });

      await page.locator("button", { hasText: "Delete this team" }).click();
      await page.waitForSelector(".modal", { timeout: 10_000 });
      await page.locator(".modal button", { hasText: "Delete it" }).click();
      await page.waitForFunction(() => location.pathname.endsWith("/teams"), { timeout: 20_000 });

      const teams = (await api(`/api/0/organizations/${ORG}/teams/`, key)) || [];
      assert(!teams.some((one) => one.slug === TEAM), "the team is still there");
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

    await test("somebody can be invited, promoted and removed", async () => {
      /**
       * On a guest this suite invites, never on a real member.
       *
       * These three are the writes People exists for, and none of them were
       * covered — the shared selector bug and the empty teamRoles both lived
       * in this path and were found by reading rather than by running.
       *
       * The invitation needs no mail to be configured: GlitchTip creates the
       * membership either way and hands back a link, and it is the membership
       * these check.
       */
      const { view, close, section: part } = await freshWindow();
      try {
      await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
      await view.waitForSelector("#invite-email", { timeout: 15_000 });

      // A team is offered at all, which is what stops an invitation landing
      // somebody in none — the state where they sign in and see nothing.
      const offered = await view.evaluate(() =>
        [...(document.getElementById("invite-team")?.options || [])].map((o) => o.value)
      );
      assert(offered.length, "no team offered, so every invitation sees nothing");

      await view.fill("#invite-email", GUEST);
      await part("Invite somebody").locator("button[type=submit]").click();
      await view.waitForFunction(
        (who) => [...document.querySelectorAll("#view tbody tr")].some((r) => r.textContent.includes(who)),
        GUEST,
        { timeout: 20_000 }
      );

      const invited = ((await api(`/api/0/organizations/${ORG}/members/`, key)) || []).find(
        (one) => one.email === GUEST
      );
      assert(invited, "the screen listed them but GlitchTip has no such member");
      assert(invited.role === "member", `invited as ${invited.role}`);

      // A team, because an invitation into none produces somebody who signs
      // in and sees nothing — the bug this form used to have.
      const teams = (await api(`/api/0/organizations/${ORG}/members/${invited.id}/`, key))?.teams;
      assert(
        !teams || teams.length,
        "invited into no team at all, which grants sight of nothing"
      );

      const row = view.locator("#view tbody tr").filter({ hasText: GUEST });
      await row.locator("select").selectOption("admin");
      await view.waitForTimeout(4000);
      const promoted = ((await api(`/api/0/organizations/${ORG}/members/`, key)) || []).find(
        (one) => one.email === GUEST
      );
      assert(promoted?.role === "admin", `role is ${promoted?.role}, not admin`);

      await view.locator("#view tbody tr").filter({ hasText: GUEST })
        .locator("button", { hasText: "Remove" }).click();
      await view.waitForSelector(".modal", { timeout: 10_000 });
      await view.locator(".modal button", { hasText: "Remove them" }).click();
      await view.waitForFunction(
        (who) => ![...document.querySelectorAll("#view tbody tr")].some((r) => r.textContent.includes(who)),
        GUEST,
        { timeout: 20_000 }
      );
      const gone = ((await api(`/api/0/organizations/${ORG}/members/`, key)) || []).some(
        (one) => one.email === GUEST
      );
      assert(!gone, "removed from the screen but still a member");
      } finally {
        await close();
      }
    });

    await test("a request can be declined, and approving says why it cannot", async () => {
      /**
       * Declining is entirely Sentinel's own and always works. Approving
       * needs the GlitchTip service token, which an installation may simply
       * not have configured — so what is checked there is that it says so,
       * rather than failing silently or pretending it worked.
       */
      const applicant = `${RUN}-applicant@example.com`;
      const who = makeApplicant(applicant);
      await askForAccess(who);

      const { view, close, key: mine, section: part } = await freshWindow();
      try {
      await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
      await view.waitForSelector(".detail-section", { timeout: 15_000 });
      const waiting = part("Waiting to be let in").locator("li").filter({ hasText: applicant });
      assert(await waiting.count(), "the seeded request is not on the screen");

      // The id is the record's own, not the address — they were the same
      // only in a version of this test that wrote the file by hand.
      const queued = await api("/sentinel/api/access/requests", mine);
      const record = (queued?.requests || []).find((one) => one.email === applicant);
      assert(record, "the request this suite made is not in the queue the API returns");

      const approveToken = await receiverToken();
      const approve = await fetch(
        `${BASE}/sentinel/api/access/requests/${encodeURIComponent(record.id)}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: `sessionid=${mine}; sentinel-csrf=${approveToken}`,
            "x-sentinel-csrf": approveToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ organisation: ORG }),
        }
      );
      const said = await approve.json().catch(() => ({}));
      assert(
        approve.status === 200 || (approve.status === 501 && /service token/i.test(said.error || "")),
        `approving answered ${approve.status}: ${JSON.stringify(said).slice(0, 120)}`
      );

      await waiting.locator("button", { hasText: "Decline" }).click();
      await view.waitForFunction(
        (who) => !document.body.textContent.includes(who),
        applicant,
        { timeout: 20_000 }
      );
      const queue = await api("/sentinel/api/access/requests", mine);
      const still = (queue?.requests || []).find((one) => one.email === applicant);
      assert(still?.status === "declined", `the request is ${still?.status ?? "gone"}, not declined`);
      clearRequest(applicant);
      } finally {
        await close();
        removeApplicant(applicant);
      }
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
        // The guest, whether or not the test that removes them got that far.
        const members = (await api(`/api/0/organizations/${ORG}/members/`, key)) || [];
        for (const one of members.filter((m) => String(m.email || "").startsWith(MARKER))) {
          await remove(`/api/0/organizations/${ORG}/members/${one.id}/`, key, csrf);
        }
        await remove(`/api/0/teams/${ORG}/${TEAM}/`, key, csrf);
        await remove(`/api/0/projects/${ORG}/${PROJECT}/`, key, csrf);
      } else {
        process.stdout.write("  ! no CSRF token for cleanup\n");
      }
    } catch (error) {
      process.stdout.write(`  ! cleanup could not sign in: ${error.message}\n`);
    }

    try {
      // Any request this suite put in the queue, decided or not.
      receiverFile(`
const fs = require("fs");
const path = "/data/access-requests.json";
const all = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
for (const key of Object.keys(all)) {
  if (key.startsWith(${JSON.stringify(MARKER)})) delete all[key];
}
fs.writeFileSync(path, JSON.stringify(all, null, 2));
console.log("swept");`);
    } catch (error) {
      process.stdout.write(`  ! could not clear seeded requests: ${error.message}\n`);
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
    // 404 is the outcome cleanup wanted: something already removed it, which
    // on a good run is the test that deletes it through the screen.
    if (res.status >= 400 && res.status !== 404) {
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
