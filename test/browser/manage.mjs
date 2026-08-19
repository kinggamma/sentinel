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
  try {
    return execFileSync(
      "docker",
      ["compose", "exec", "-T", "glitchtip-web", "./manage.py", "shell", "-c", python],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    // The reason, not the script. Swallowing stderr here cost two rounds of
    // guessing at a not-null constraint that Django was naming plainly.
    const why = String(error.stderr || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`manage.py failed: ${why || error.message}`);
  }
}

/**
 * Accounts this suite makes, uses and deletes.
 *
 * It used to sign in as the shared smoke account and raise its role, which
 * was wrong twice over. That account is shared with every other suite, and
 * the script that signs it in resets its password on each call — Django
 * derives a session's auth hash from the password hash, so every earlier
 * session dies the moment another is minted. This suite signed in several
 * times and then kept using the first key, which is why its later checks
 * failed in a way that looked like the app losing sessions.
 *
 * So it makes its own: a manager to act as, a member to be refused as, and
 * applicants who ask to be let in. Each is signed in exactly once, nothing
 * shared is touched, and every one is removed at the end.
 */
const made = [];

function makeAccount(email, { role = null } = {}) {
  const password = `Su-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const out = django(`
from django.apps import apps
from django.contrib.auth import get_user_model
Org = apps.get_model('organizations_ext','Organization')
OrgUser = apps.get_model('organizations_ext','OrganizationUser')
User = get_user_model()
user, _ = User.objects.get_or_create(email=${JSON.stringify(email)})
user.set_password(${JSON.stringify(password)})
user.is_active = True
user.save()
# None, not JSON's null, which Python has never heard of.
role = ${role ? JSON.stringify(role) : "None"}
if role:
    org = Org.objects.get(slug=${JSON.stringify(ORG)})
    # The value first: the row has a not-null role, so creating it and then
    # setting one inserts a null on the way through and is refused.
    value = [r for r in OrgUser._meta.get_field('role').choices if r[1].lower() == role][0][0]
    member, made = OrgUser.objects.get_or_create(
        user=user, organization=org, defaults={"role": value})
    if not made and member.role != value:
        member.role = value
        member.save()
print("made", user.email)`);
  assert(out.includes("made"), `could not make ${email}: ${out.trim()}`);
  made.push(email);
  return { email, password };
}

function dropAccount(email) {
  django(`
from django.contrib.auth import get_user_model
get_user_model().objects.filter(email=${JSON.stringify(email)}).delete()
print("dropped")`);
}

function dropAccounts() {
  for (const email of made.splice(0)) {
    try {
      dropAccount(email);
    } catch (error) {
      process.stdout.write(`  ! could not remove ${email}: ${error.message}\n`);
    }
  }
}

/**
 * Signing in the way a browser does, through allauth.
 *
 * Once per account. Nothing here resets a password after the fact, so a
 * session minted at the start is still good at the end — which the previous
 * arrangement could not promise.
 */
async function signIn({ email, password }) {
  const jar = [];
  const keep = (res) => {
    for (const value of res.headers.getSetCookie?.() || []) jar.push(value.split(";")[0]);
  };
  const cookie = () => jar.join("; ");

  keep(await fetch(`${BASE}/_allauth/browser/v1/auth/session`, { headers: { cookie: cookie() } }));
  const csrf = cookie().match(/csrftoken=([^;]+)/)?.[1] || "";

  const login = await fetch(`${BASE}/_allauth/browser/v1/auth/login`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json", "x-csrftoken": csrf },
    body: JSON.stringify({ email, password }),
  });
  keep(login);
  const key = cookie().match(/sessionid=([^;]+)/)?.[1];
  assert(key, `${email} could not sign in (${login.status})`);
  return key;
}

/** Which organisation, from the receiver's own configuration. */
function organisation() {
  const pinned = execFileSync(
    "docker",
    ["compose", "exec", "-T", "feedback-receiver", "printenv", "GLITCHTIP_ORG"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  ).trim();
  if (pinned) return pinned;

  const first = django(`
from django.apps import apps
org = apps.get_model('organizations_ext','Organization').objects.order_by('id').first()
print("org", org.slug if org else "")`);
  const slug = first.match(/^org (.+)$/m)?.[1]?.trim();
  assert(slug, "there is no organisation to work in");
  return slug;
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
/**
 * An applicant: somebody with no organisation who asks to be let in.
 *
 * The queue is Sentinel's own and is only written by the endpoint an
 * applicant posts to. Writing the file directly does not work — the receiver
 * reads it once and keeps it in memory — so a real account asks, which is
 * also the path people actually walk.
 */
async function applicantAsks(email) {
  const who = makeAccount(email);
  const key = await signIn(who);
  const token = await receiverToken();
  const asked = await fetch(`${BASE}/sentinel/api/access/request`, {
    method: "POST",
    headers: {
      cookie: `sessionid=${key}; sentinel-csrf=${token}`,
      "x-sentinel-csrf": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ note: "put here by the management suite" }),
  });
  assert(asked.status === 201, `${email} asking for access answered ${asked.status}`);
  return { ...who, key };
}

/**
 * Requests left in the queue by earlier runs of this suite.
 *
 * They cannot be deleted from the file: the receiver read it once and keeps
 * it, so anything removed behind its back reappears the next time it writes.
 * The only thing that clears a request is the person it belongs to asking
 * where they stand once they are no longer waiting — so each stranded
 * applicant is recreated just long enough to do exactly that, then removed.
 */
async function sweepStaleRequests(managerKey) {
  const queue = await api("/sentinel/api/access/requests", managerKey);
  const stale = (queue?.requests || []).filter((one) =>
    String(one.email || "").startsWith(MARKER)
  );
  if (!stale.length) return 0;

  for (const request of stale) {
    try {
      const account = makeAccount(request.email);
      const key = await signIn(account);
      await forgetRequest({ ...account, key });
      dropAccount(request.email);
      made.splice(made.indexOf(request.email), 1);
    } catch (error) {
      process.stdout.write(`  ! could not clear ${request.email}: ${error.message}\n`);
    }
  }
  return stale.length;
}

/**
 * Take a decided request out of the queue, through the receiver rather than
 * behind its back.
 *
 * Editing the JSON file leaves the record in the receiver's memory, which
 * writes it back out on the next decision — so what looked like cleanup put
 * it straight back. `/access/me` clears somebody's request once they are no
 * longer waiting, so the applicant is let into the organisation and then
 * asks that question themselves, which is what happens to a real person the
 * moment they are approved.
 */
async function forgetRequest(applicant) {
  django(`
from django.apps import apps
from django.contrib.auth import get_user_model
Org = apps.get_model('organizations_ext','Organization')
OrgUser = apps.get_model('organizations_ext','OrganizationUser')
user = get_user_model().objects.filter(email=${JSON.stringify(applicant.email)}).first()
if user:
    org = Org.objects.get(slug=${JSON.stringify(ORG)})
    # With a role: the column is not-null, so creating the row and setting one
    # afterwards inserts a null on the way through and is refused.
    lowest = OrgUser._meta.get_field('role').choices[0][0]
    OrgUser.objects.get_or_create(user=user, organization=org, defaults={"role": lowest})
print("joined")`);

  /**
   * Their own session, asking where they stand. The receiver clears the
   * request when the answer is "you are in" — and says so in the reply, which
   * is checked rather than assumed: a silent no-op here is what left this
   * suite's own applicants in the queue while it reported itself clean.
   */
  /**
   * Signed in again, after the join rather than before it.
   *
   * Reusing the session they asked with left them reading as pending — the
   * session predates the membership, and whatever the receiver had already
   * decided about it was not revisited in time for this. A fresh sign-in is
   * one request and removes the question; it is also what the sweep for
   * earlier runs does, which is the version that always worked.
   */
  const key = await signIn(applicant).catch(() => applicant.key);
  const said = await fetch(`${BASE}/sentinel/api/access/me`, {
    headers: { cookie: `sessionid=${key}` },
  });
  const body = await said.json().catch(() => ({}));
  if (body.pending !== false) {
    process.stdout.write(
      `  ! ${applicant.email} still reads as pending (${said.status}), so its request stayed\n`
    );
  }
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

/**
 * Which organisation everything below happens in, decided once at the start
 * and never assumed. Writing one installation's name into this file would
 * fail on everybody else's for a reason resembling a bug in the app.
 */
let ORG = "";

/** Ask GlitchTip what is actually there, rather than trusting the screen. */
async function api(path, key) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: `sessionid=${key}` } });
  if (res.status !== 200) return null;
  return res.json();
}

async function main() {
  process.stdout.write("\nMaking and unmaking things\n");

  let browser;
  /** Applicants this run created, so cleanup can clear their requests. */
  const applicants = [];
  /** The session cleanup deletes with, kept from the one sign-in. */
  let cleanupKey = null;

  try {
    // Before anything else: everything below names it.
    ORG = organisation();
    process.stdout.write(`  (organisation: ${ORG})\n`);

    /**
     * Anything a previous run of *this* suite left, and nothing else.
     *
     * The names this suite makes are a fixed marker followed by the process
     * id, so that is exactly what it removes — a pattern nothing chosen by a
     * person looks like. An earlier version matched every slug starting
     * "suite", which would have deleted somebody's real work.
     */
    django(`
import re
from django.apps import apps
from django.contrib.auth import get_user_model
Project = apps.get_model('projects','Project')
Team = apps.get_model('teams','Team')
mine = re.compile(r"^sentinel-manage-suite-\\d+-(project|team)$")
projects = [p.id for p in Project.objects.filter(slug__startswith=${JSON.stringify(MARKER)}) if mine.match(p.slug)]
teams = [t.id for t in Team.objects.filter(slug__startswith=${JSON.stringify(MARKER)}) if mine.match(t.slug)]
Project.objects.filter(id__in=projects).delete()
Team.objects.filter(id__in=teams).delete()
# Matched in Python, not with startswith: the email column has a
# nondeterministic collation and Postgres refuses LIKE against it.
User = get_user_model()
stale = [u.id for u in User.objects.only("id", "email")
         if str(u.email or "").startswith(${JSON.stringify(MARKER)})]
User.objects.filter(id__in=stale).delete()
print("swept", len(projects), "project(s),", len(teams), "team(s),", len(stale), "account(s)")`);

    /**
     * The account this suite acts as: its own, made manager, signed in once.
     * Nothing shared is touched and nothing resets its password behind it.
     */
    const manager = makeAccount(`${RUN}-manager@example.com`, { role: "manager" });
    const key = await signIn(manager);
    cleanupKey = key;

    const stranded = await sweepStaleRequests(key);
    if (stranded) process.stdout.write(`  (cleared ${stranded} request(s) from earlier runs)\n`);

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
    /**
     * A window on the one session this suite holds.
     *
     * There used to be a freshly minted session per window, to work around
     * the context losing its own. The cause was this suite: signing in again
     * reset the account's password, and Django ties a session's auth hash to
     * the password hash, so each new sign-in killed the last. One account,
     * one sign-in, and the problem is gone rather than worked around.
     */
    const windowOn = async () => {
      const own = await browser.newContext();
      await own.addCookies([
        { name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true },
      ]);
      const view = await own.newPage();
      view.on("pageerror", (error) => broke.push(error.message));
      return {
        view,
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

      /**
       * A second account of this suite's own, rather than demoting the one
       * it is acting as. Flipping a role mid-run changed a shared account and
       * left every session minted before it unusable.
       */
      const ordinary = makeAccount(`${RUN}-member@example.com`, { role: "member" });
      const refused = await fetch(`${BASE}/sentinel/api/access/requests`, {
        headers: { Cookie: `sessionid=${await signIn(ordinary)}` },
      });
      assert(refused.status === 403, `an ordinary member could read the queue (${refused.status})`);
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
      const { view, close, section: part } = await windowOn();
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

    await test("one request can be declined and another approved, from the screen", async () => {
      /**
       * Two applicants, because one cannot be both.
       *
       * Using a single request for both buttons meant that wherever approval
       * works — an installation with a service token — the decline that
       * followed acted on an already-approved request, which is not a state
       * anybody reaches by using the product.
       *
       * Approving needs the GlitchTip service token, which this installation
       * does not have. Where it is absent the screen must say so rather than
       * fail silently, and that is what is checked; where it is present the
       * request must come back approved.
       */
      const declined = await applicantAsks(`${RUN}-declined@example.com`);
      const approved = await applicantAsks(`${RUN}-approved@example.com`);
      applicants.push(declined, approved);

      const { view, close, section: part } = await windowOn();
      try {
        await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
        await view.waitForSelector(".detail-section", { timeout: 15_000 });

        const waiting = (who) =>
          part("Waiting to be let in").locator("li").filter({ hasText: who.email });
        assert(await waiting(declined).count(), "the first applicant is not on the screen");
        assert(await waiting(approved).count(), "the second applicant is not on the screen");

        await waiting(declined).locator("button", { hasText: "Decline" }).click();
        await view.waitForFunction(
          (who) => !document.body.textContent.includes(who),
          declined.email,
          { timeout: 20_000 }
        );

        await waiting(approved).locator("button", { hasText: "Approve" }).click();
        await view.waitForTimeout(5000);

        const queue = await api("/sentinel/api/access/requests", key);
        const rows = queue?.requests || [];
        const wasDeclined = rows.find((one) => one.email === declined.email);
        const wasApproved = rows.find((one) => one.email === approved.email);

        assert(
          wasDeclined?.status === "declined",
          `the first is ${wasDeclined?.status ?? "gone"}, not declined`
        );

        if (wasApproved?.status === "approved") return; // a service token is configured
        assert(
          wasApproved?.status === "pending",
          `the second is ${wasApproved?.status ?? "gone"} — neither approved nor left alone`
        );
        const said = await part("Waiting to be let in").locator(".error").textContent();
        assert(
          /service token/i.test(said || ""),
          `approval failed without saying why: ${JSON.stringify(said)}`
        );
      } finally {
        await close();
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
      const { view, close: shut } = await windowOn();
      await view.goto(`${MOUNT}/people`, { waitUntil: "networkidle" });
      await view.waitForSelector("#view tbody tr", { timeout: 15_000 }).catch(async () => {
        const seen = (await view.textContent("#view")) || "";
        assert(false, `no member list at ${view.url()} — the screen said: ${seen.replace(/\s+/g, " ").trim().slice(0, 200)}`);
      });
      // The account this suite is signed in as, not whichever one the
      // constant at the top of the file happens to name.
      const mine = view.locator("#view tbody tr").filter({ hasText: manager.email });
      assert(await mine.count(), "the signed-in account is not in the list");
      assert(
        (await mine.locator("select").count()) === 0 &&
          (await mine.locator("button", { hasText: "Remove" }).count()) === 0,
        "offered to change or remove your own membership"
      );
      await shut();
    });

    await test("nothing on these screens threw", () => {
      assert(!broke.length, `page errors: ${broke.join("; ")}`);
    });
  } finally {
    if (browser) await browser.close();

    /**
     * Each in its own block, so one failing does not strand the others.
     * The accounts go last: they are what everything else is deleted with.
     */
    try {
      const csrf = await tokenFor(cleanupKey);
      if (csrf) {
        // The invited guest, whether or not the test that removes them ran.
        const members = (await api(`/api/0/organizations/${ORG}/members/`, cleanupKey)) || [];
        for (const one of members.filter((m) => String(m.email || "").startsWith(MARKER))) {
          await remove(`/api/0/organizations/${ORG}/members/${one.id}/`, cleanupKey, csrf);
        }
        /**
         * The project and team go through the ORM, not the API.
         *
         * GlitchTip will not let this account delete the project it made:
         * the queryset behind that endpoint wants team membership, and this
         * account is in no team — so the API answered 404 and the project
         * stayed. Cleanup is not the place to prove an endpoint works; the
         * tests above do that through the screen. Its job is that nothing
         * survives, so it removes them directly.
         */
        django(`
from django.apps import apps
apps.get_model('projects','Project').objects.filter(slug=${JSON.stringify(PROJECT)}).delete()
apps.get_model('teams','Team').objects.filter(slug=${JSON.stringify(TEAM)}).delete()
print("removed")`);
      } else {
        process.stdout.write("  ! no CSRF token for cleanup\n");
      }
    } catch (error) {
      process.stdout.write(`  ! cleanup of projects and teams failed: ${error.message}\n`);
    }

    try {
      // Through the receiver, so its own copy forgets them too.
      for (const applicant of applicants) await forgetRequest(applicant);
    } catch (error) {
      process.stdout.write(`  ! could not clear the requests: ${error.message}\n`);
    }

    dropAccounts();
  }

  // Checked rather than hoped: this made real things in a real GlitchTip.
  await test("it leaves nothing of its own behind", async () => {
    /**
     * A manager, because one of the things it audits is the request queue —
     * and the receiver refuses that to anybody below manager. Auditing as a
     * member got a 403, read it as an empty list, and reported that nothing
     * was left while six of this suite's requests sat in the queue.
     */
    const checking = makeAccount(`${RUN}-audit@example.com`, { role: "manager" });
    const key = await signIn(checking);

    const projects = (await api(`/api/0/organizations/${ORG}/projects/`, key)) || [];
    const teams = (await api(`/api/0/organizations/${ORG}/teams/`, key)) || [];
    assert(!projects.some((one) => one.slug === PROJECT), `${PROJECT} was left behind`);
    assert(!teams.some((one) => one.slug === TEAM), `${TEAM} was left behind`);

    const members = (await api(`/api/0/organizations/${ORG}/members/`, key)) || [];
    const mine = members.filter(
      (one) => String(one.email || "").startsWith(MARKER) && one.email !== checking.email
    );
    assert(!mine.length, `left ${mine.length} of its own member(s) behind`);

    const queue = await api("/sentinel/api/access/requests", key);
    assert(queue, "the audit could not read the queue, so it cannot say whether it is clean");
    const asked = (queue.requests || []).filter((one) =>
      String(one.email || "").startsWith(MARKER)
    );
    assert(!asked.length, `left ${asked.length} request(s) in the queue`);

    dropAccounts();
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
    // 404 means something already removed it, which on a good run is the
    // test that deletes it through the screen. Anything else is reported —
    // including a 2xx that did not stick, which the audit then catches.
    if (res.status >= 400 && res.status !== 404) {
      process.stdout.write(`  ! cleanup of ${path} answered ${res.status}\n`);
    }
    return res.status;
  } catch (error) {
    process.stdout.write(`  ! cleanup of ${path} threw: ${error.message}\n`);
  }
}

main().catch((error) => {
  // The accounts are this suite's, and nothing else will remove them.
  dropAccounts();
  process.stdout.write(`\nsuite could not run: ${error.stack || error.message}\n`);
  process.exit(1);
});
