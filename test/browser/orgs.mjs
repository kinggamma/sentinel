#!/usr/bin/env node
/**
 * Belonging to two organisations, which no install here actually does.
 *
 * Everything about the multi-organisation behaviour — the switcher, the
 * scoped issue list, the landing grid showing one organisation's apps —
 * is dead code on a single-organisation deployment, and dead code that
 * cannot be exercised is dead code that quietly stops working. The whole
 * class of bug it exists to prevent is the silent one: showing less than
 * there is, or showing somebody else's, with nothing on screen admitting it.
 *
 * So this builds the situation rather than waiting for it. A second
 * organisation, a real project moved into it, and the questions that only
 * have answers when there are two: does the grid follow the organisation
 * named beside it, does it say what it is not showing, and does an app that
 * belongs to no organisation stay visible under both.
 *
 * Two things it changes and puts back, both in a finally:
 *
 * It moves a real project between organisations, because a project's
 * organisation is what the filtering reads and there is no other way to have
 * one in each.
 *
 * And it restarts the receiver with GLITCHTIP_ORG empty. That variable pins
 * identity to a single organisation, which is the right default here and
 * makes multi-organisation behaviour unreachable by construction — with it
 * set, the account reports one organisation no matter how many it is in.
 * Restoring it is `docker compose up -d`, which reads the value back out of
 * .env. If this is killed between the two, that one command puts it right.
 *
 *   docker compose up -d && npm install && npm run test:orgs
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const MOUNT = `${BASE}/sentinel`;
const SECOND = "suite-second-org";

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

function compose(args, env = {}) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ...env },
  });
}

function session() {
  const [key, org] = execFileSync("bash", ["scripts/seed-smoke-session.sh"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
    .trim()
    .split(/\s+/);
  assert(key, "seed-smoke-session.sh printed no session key");
  return { key, org };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function projectsFor(key) {
  const res = await fetch(`${BASE}/sentinel/api/projects`, {
    headers: { Cookie: `sessionid=${key}` },
  });
  assert(res.status === 200, `couldn't read projects (${res.status})`);
  return (await res.json()).projects || [];
}

/** What the landing grid is showing, and what it admits to hiding. */
async function grid(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#view", { timeout: 15_000 });
  await page
    .waitForFunction(() => document.querySelectorAll(".projects > *").length > 0, {
      timeout: 15_000,
    })
    .catch(() => {});

  return page.evaluate(() => ({
    apps: [...document.querySelectorAll(".projects .project-card, .projects > *")].map((card) =>
      (card.querySelector("h3, h2, .project-name")?.textContent || card.textContent || "")
        .trim()
        .split("\n")[0]
        .trim()
    ),
    elsewhere:
      [...document.querySelectorAll("#view p.muted")]
        .map((p) => p.textContent.trim())
        .find((t) => t.includes("other organisations")) || null,
    switcher: document.getElementById("org-switch")?.hidden === false,
    options: [...(document.getElementById("org-switch")?.options || [])].map((o) => o.value),
  }));
}

async function main() {
  process.stdout.write("\nTwo organisations\n");

  // Which project to move, decided before anything is changed so the
  // restore knows exactly where it came from.
  const first = session();
  const before = await projectsFor(first.key);
  const movable = before.find((p) => p.glitchtipProject && p.org);
  const staying = before.find((p) => p.glitchtipProject && p !== movable);
  if (!movable || !staying) {
    process.stdout.write(
      "  (needs two apps mapped to GlitchTip projects — run scripts/seed-demo-errors.sh)\n"
    );
    return;
  }

  const homeOrg = movable.org;
  let moved = false;
  let unpinned = false;
  let browser;

  try {
    django(`
from django.apps import apps
from django.contrib.auth import get_user_model
Org = apps.get_model('organizations_ext','Organization')
Project = apps.get_model('projects','Project')
u = get_user_model().objects.get(email='sentinel-smoke@example.com')
org, _ = Org.objects.get_or_create(slug=${JSON.stringify(SECOND)}, defaults={'name': 'Suite Second Org'})
if not org.organization_users.filter(user=u).exists():
    org.organization_users.create(user=u, role=0)
p = Project.objects.get(slug=${JSON.stringify(movable.glitchtipProject)})
p.organization = org
p.save()
print("moved")`);
    moved = true;

    // The pin has to come off for the account to report two organisations
    // at all; everything below is unreachable while it is on.
    compose(["up", "-d", "feedback-receiver"], { GLITCHTIP_ORG: "" });
    unpinned = true;
    await sleep(5000);

    const { key } = session();
    const seen = await projectsFor(key);
    const nowIn = Object.fromEntries(seen.map((p) => [p.appName, p.org]));
    assert(
      nowIn[movable.appName] === SECOND,
      `the receiver still thinks ${movable.appName} is in ${nowIn[movable.appName]}`
    );

    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addCookies([
      { name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true },
    ]);
    const page = await context.newPage();

    await test("the switcher offers both organisations", async () => {
      const view = await grid(page, `${MOUNT}/?org=${homeOrg}`);
      assert(view.switcher, "no organisation switcher with two organisations");
      assert(
        view.options.includes(homeOrg) && view.options.includes(SECOND),
        `the switcher offered ${JSON.stringify(view.options)}`
      );
    });

    await test("the grid shows the organisation you are in, not every app you can reach", async () => {
      const view = await grid(page, `${MOUNT}/?org=${homeOrg}`);
      const named = view.apps.join(" ");
      assert(named.includes(staying.appName), `${staying.appName} should be here: ${named}`);
      assert(
        !named.includes(movable.appName),
        `${movable.appName} moved organisation and should not be here: ${named}`
      );
    });

    await test("and says how many it is not showing, rather than just being shorter", async () => {
      const view = await grid(page, `${MOUNT}/?org=${homeOrg}`);
      assert(view.elsewhere, "nothing said about the apps in the other organisation");
      assert(
        /1 more app reports/.test(view.elsewhere),
        `the count reads oddly: ${JSON.stringify(view.elsewhere)}`
      );
    });

    await test("switching organisation shows the other one's apps", async () => {
      const view = await grid(page, `${MOUNT}/?org=${SECOND}`);
      const named = view.apps.join(" ");
      assert(named.includes(movable.appName), `${movable.appName} should be here: ${named}`);
      assert(
        !named.includes(staying.appName),
        `${staying.appName} is in the other organisation: ${named}`
      );
    });

    await test("an app in no organisation at all stays visible under both", async () => {
      /**
       * An app that has reported but maps to no GlitchTip project belongs to
       * nobody's organisation. Filtering it away would make it unreachable
       * at the exact moment somebody is setting it up, which is when its
       * card matters most — so it is shown everywhere, and this only checks
       * that when such an app exists.
       */
      const orphan = (await projectsFor(key)).find((p) => !p.org);
      if (!orphan) return;

      for (const slug of [homeOrg, SECOND]) {
        const view = await grid(page, `${MOUNT}/?org=${slug}`);
        assert(
          view.apps.join(" ").includes(orphan.appName),
          `${orphan.appName} belongs to no organisation but vanished under ${slug}`
        );
      }
    });
  } finally {
    if (browser) await browser.close();

    if (moved) {
      django(`
from django.apps import apps
Org = apps.get_model('organizations_ext','Organization')
Project = apps.get_model('projects','Project')
p = Project.objects.get(slug=${JSON.stringify(movable.glitchtipProject)})
p.organization = Org.objects.get(slug=${JSON.stringify(homeOrg)})
p.save()
Org.objects.filter(slug=${JSON.stringify(SECOND)}).delete()
print("restored")`);
    }

    // Puts GLITCHTIP_ORG back to whatever .env says, pin included.
    if (unpinned) {
      compose(["up", "-d", "feedback-receiver"]);
      await sleep(4000);
    }
  }

  // Proof that the restore worked, rather than a hope that it did — this
  // suite is the only thing here that reconfigures a running stack.
  await test("it puts the stack back the way it found it", async () => {
    const { key } = session();
    const after = await projectsFor(key);
    const home = after.find((p) => p.appName === movable.appName)?.org;
    {
      assert(home === homeOrg, `${movable.appName} was left in ${home}, not ${homeOrg}`);
    }
    const orgs = django(`
from django.apps import apps
Org = apps.get_model('organizations_ext','Organization')
print("orgs", list(Org.objects.values_list('slug', flat=True)))`);
    assert(!orgs.includes(SECOND), `the second organisation was left behind: ${orgs.trim()}`);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  process.stdout.write(`\nsuite could not run: ${error.stack || error.message}\n`);
  process.exit(1);
});
