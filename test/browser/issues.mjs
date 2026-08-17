#!/usr/bin/env node
/**
 * The issue screen, doing the things it exists to do.
 *
 * The HTTP smoke suite already asks GlitchTip whether these endpoints
 * answer, and they always did — it was green through every version of this
 * screen, including the ones where nothing rendered. Asking `/comments/` for
 * a list proves the API works; it says nothing about whether a note somebody
 * types reaches it, whether the reply comes back onto the page, whether the
 * write carried a CSRF token, or whether a facet that fails leaves a hole
 * that looks exactly like an empty one.
 *
 * Those are the failures this screen actually has, and every one of them
 * needs a browser: a real DOM to render into, a real cookie jar for the
 * session, and a real fetch for Django to accept or refuse. So this suite
 * drives the thing as a person does — types in the box, clicks the button,
 * follows the link — and checks GlitchTip's own state afterwards, because a
 * note that appears on screen and never reached the server is the exact bug
 * worth catching.
 *
 * It lives here rather than in receiver/ for the reason run.mjs explains:
 * the image's assets stage installs that package's dev dependencies, and a
 * browser driver in there would make every image build fetch one.
 *
 * Needs the stack up and seeded:
 *
 *   docker compose up -d && npm install && npm run test:issues
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const MOUNT = `${BASE}/sentinel`;
const EMAIL = process.env.SMOKE_EMAIL || "sentinel-smoke@example.com";

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

function script(...args) {
  return execFileSync("bash", ["scripts/seed-smoke-session.sh", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** The same sign-in the smoke suite uses: a real allauth login, not a forged cookie. */
function seedSession() {
  const [key, org] = script().split(/\s+/);
  assert(key, "seed-smoke-session.sh printed no session key");
  return { key, org };
}

/**
 * A CSRF token for this session, minted the way the server side already
 * mints one: allauth hands one back on a GET, and it is read off the
 * Set-Cookie header rather than a cookie jar this has none of.
 *
 * Fetched once and reused. Django binds the token to the session, so one
 * lasts as long as the session does.
 */
let csrf = null;

async function csrfFor(key) {
  if (csrf) return csrf;
  const response = await fetch(`${BASE}/_allauth/browser/v1/auth/session`, {
    headers: { Cookie: `sessionid=${key}` },
  });
  csrf = (response.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1] || null;
  return csrf;
}

/**
 * Ask GlitchTip directly, so the screen's claims can be checked against it.
 *
 * Writes from here carry a token like any other session write. They did not,
 * and the only writes this file makes are the ones that clean up after
 * itself — so every run refused its own tidying with a 403, swallowed it,
 * and left its notes on a real issue. Six of them accumulated before anybody
 * looked.
 */
async function api(path, key, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const headers = { Cookie: `sessionid=${key}`, ...(init.headers || {}) };

  if (!["GET", "HEAD"].includes(method)) {
    const token = await csrfFor(key);
    assert(token, "allauth offered no csrftoken to write with");
    headers.Cookie = `sessionid=${key}; csrftoken=${token}`;
    headers["x-csrftoken"] = token;
  }

  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * An issue with more than one event, because event navigation cannot be
 * tested on an issue that has nowhere to navigate to. Falls back to any
 * issue at all, so the rest of the suite still runs on a thin seed.
 */
async function pickIssue(key, org) {
  const { status, body } = await api(
    `/api/0/organizations/${encodeURIComponent(org)}/issues/?limit=100&query=`,
    key
  );
  assert(status === 200, `couldn't list issues (${status})`);
  assert(Array.isArray(body) && body.length, "no issues seeded — run scripts/seed-demo-errors.sh");
  const many = body.find((issue) => Number(issue.count) > 1);
  return { id: (many || body[0]).id, hasSiblings: Boolean(many) };
}

/**
 * Two notes, sharing a marker so cleanup finds both, and worded so that
 * neither contains the other — "is that note gone?" cannot be answered
 * while a second note has the first one's text inside it.
 */
const MARK = `browser-suite-${process.pid}`;
const NOTE = `typed ${MARK}`;
const CSRF_NOTE = `token check ${MARK}`;

/**
 * Whatever this run wrote, gone, even if it failed in the middle of writing
 * it — and loudly if it cannot be. This writes to a real issue in a real
 * installation, so failing to tidy is a result, not a detail: silence here
 * is what let six notes pile up on somebody's issue across six runs.
 *
 * It sweeps every run's marker, not just this one's, so a run that was
 * killed before its own cleanup is repaired by the next.
 */
async function removeOurNotes(key, org, issueId) {
  const comments = `/api/0/organizations/${encodeURIComponent(org)}/issues/${issueId}/comments/`;
  const { status, body } = await api(comments, key);
  if (!Array.isArray(body)) {
    process.stdout.write(`\n  ! could not list notes to clean up (${status})\n`);
    return;
  }

  const ours = body.filter((comment) => comment?.data?.text?.includes("browser-suite-"));
  const stranded = [];
  for (const comment of ours) {
    const gone = await api(`${comments}${comment.id}/`, key, { method: "DELETE" });
    if (gone.status >= 400) stranded.push(`${comment.id} (${gone.status})`);
  }

  if (stranded.length) {
    process.stdout.write(
      `\n  ! left ${stranded.length} note(s) behind on issue ${issueId}: ${stranded.join(", ")}\n` +
        `    they are real and want deleting by hand\n`
    );
  }
}

/** The section headed `title`, or null. Sections are found by their heading. */
const sectionText = (title) => `
  (() => {
    const h = [...document.querySelectorAll(".detail-section h3")]
      .find((n) => n.textContent.trim() === ${JSON.stringify(title)});
    return h ? h.parentElement.textContent.replace(/\\s+/g, " ").trim() : null;
  })()
`;

async function main() {
  const { key, org } = seedSession();
  const { id: issueId, hasSiblings } = await pickIssue(key, org);
  process.stdout.write(`\nIssue screen (issue ${issueId}, org ${org})\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE });
  await context.addCookies([
    { name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true },
  ]);

  const detail = `${MOUNT}/issues/${issueId}`;

  try {
    // --------------------------------------------------------- it renders

    await test("the detail screen renders its facets, not just its stack trace", async () => {
      const page = await context.newPage();
      const broke = [];
      page.on("pageerror", (error) => broke.push(error.message));
      await page.goto(detail, { waitUntil: "networkidle" });

      await page.waitForSelector(".comment-form textarea", { timeout: 10_000 });
      const headings = await page.$$eval(".detail-section h3", (ns) =>
        ns.map((n) => n.textContent.trim())
      );
      assert(headings.includes("Notes"), `no Notes section; got ${JSON.stringify(headings)}`);
      assert(
        headings.some((h) => h.startsWith("Tags")),
        `no Tags section; got ${JSON.stringify(headings)}`
      );
      assert(!broke.length, `page errors: ${broke.join(", ")}`);
      await page.close();
    });

    // ------------------------------------------------------- writing a note

    await test("a note typed into the form reaches GlitchTip and comes back", async () => {
      const page = await context.newPage();
      await page.goto(detail, { waitUntil: "networkidle" });
      await page.waitForSelector(".comment-form textarea");

      const before = await page.$$eval("article.comment", (n) => n.length);
      await page.fill(".comment-form textarea", NOTE);
      await page.click(".comment-form button");

      await page.waitForFunction(
        (text) => [...document.querySelectorAll("article.comment")].some((c) => c.textContent.includes(text)),
        NOTE,
        { timeout: 10_000 }
      );

      const after = await page.$$eval("article.comment", (n) => n.length);
      assert(after === before + 1, `expected one more note on screen, went ${before} → ${after}`);

      const cleared = await page.inputValue(".comment-form textarea");
      assert(cleared === "", `the box kept its text after posting: ${JSON.stringify(cleared)}`);

      const { body } = await api(`/api/0/organizations/${org}/issues/${issueId}/comments/`, key);
      assert(
        Array.isArray(body) && body.some((c) => c?.data?.text === NOTE),
        "the note rendered on screen but GlitchTip does not have it"
      );
      await page.close();
    });

    await test("the write carried a CSRF token", async () => {
      const page = await context.newPage();
      const writes = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/comments/")) {
          writes.push(request.headers());
        }
      });
      await page.goto(detail, { waitUntil: "networkidle" });
      await page.waitForSelector(".comment-form textarea");
      await page.fill(".comment-form textarea", CSRF_NOTE);
      await page.click(".comment-form button");
      await page.waitForFunction(
        (text) => [...document.querySelectorAll("article.comment")].some((c) => c.textContent.includes(text)),
        CSRF_NOTE,
        { timeout: 10_000 }
      );

      assert(writes.length === 1, `expected one POST, saw ${writes.length}`);
      const token = writes[0]["x-csrftoken"];
      assert(token && token.length > 10, `no usable x-csrftoken header: ${JSON.stringify(token)}`);
      await page.close();
    });

    await test("the same write without the token is refused", async () => {
      const page = await context.newPage();
      await page.goto(detail, { waitUntil: "networkidle" });
      const status = await page.evaluate(async (path) => {
        const response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { text: "should never be stored" } }),
        });
        return response.status;
      }, `/api/0/organizations/${encodeURIComponent(org)}/issues/${issueId}/comments/`);
      assert(status === 403, `a tokenless write answered ${status}, wanted 403`);
      await page.close();
    });

    await test("deleting a note removes it from the screen and from GlitchTip", async () => {
      const page = await context.newPage();
      await page.goto(detail, { waitUntil: "networkidle" });
      await page.waitForSelector("article.comment");

      const mine = page
        .locator("article.comment")
        .filter({ hasText: NOTE })
        .first()
        .locator("button", { hasText: "Delete" });
      assert(await mine.count(), "no Delete button on a note this account wrote");
      await mine.click();

      await page.waitForFunction(
        (text) => ![...document.querySelectorAll("article.comment")].some((c) => c.textContent.includes(text)),
        NOTE,
        { timeout: 10_000 }
      );

      const { body } = await api(`/api/0/organizations/${org}/issues/${issueId}/comments/`, key);
      assert(
        Array.isArray(body) && !body.some((c) => c?.data?.text === NOTE),
        "the note left the screen but GlitchTip still has it"
      );
      await page.close();
    });

    // --------------------------------------------------- moving between events

    await test(
      hasSiblings
        ? "the earlier event is a link, and following it shows a different event"
        : "event navigation is absent when the issue has one event",
      async () => {
        const page = await context.newPage();
        await page.goto(detail, { waitUntil: "networkidle" });
        await page.waitForSelector(".detail-section");

        const earlier = page.locator(".event-nav a", { hasText: "Earlier" });
        if (!hasSiblings) {
          assert((await earlier.count()) === 0, "offered an earlier event on a single-event issue");
          await page.close();
          return;
        }

        assert(await earlier.count(), "no link to the earlier event");
        const first = await page.textContent(".event-nav .muted");
        await earlier.click();
        await page.waitForFunction(
          (was) => {
            const now = document.querySelector(".event-nav .muted")?.textContent;
            return now && now !== was;
          },
          first,
          { timeout: 10_000 }
        );

        assert(page.url().includes("event="), `the address kept no record of the event: ${page.url()}`);
        await page.close();
      }
    );

    // ------------------------------------------------- when a facet will not load

    await test("a facet that fails says so, and the rest of the screen survives", async () => {
      const page = await context.newPage();
      await page.route(`**/api/0/organizations/${org}/issues/${issueId}/comments/`, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      );
      await page.goto(detail, { waitUntil: "networkidle" });
      await page.waitForSelector(".detail-section");

      const notes = await page.evaluate(sectionText("Notes"));
      assert(notes, "the Notes section vanished instead of reporting the failure");
      assert(
        /Couldn't load this \(500\)/.test(notes),
        `Notes said nothing about why: ${JSON.stringify(notes)}`
      );
      assert(
        (await page.$$eval(".detail-section h3", (n) => n.map((x) => x.textContent))).some((h) =>
          h.startsWith("Tags")
        ),
        "one failing facet took the working ones with it"
      );
      await page.close();
    });

    await test("a facet refused for permissions says that, not that it broke", async () => {
      const page = await context.newPage();
      await page.route(`**/api/0/organizations/${org}/issues/${issueId}/user-reports/`, (route) =>
        route.fulfill({ status: 403, contentType: "application/json", body: "{}" })
      );
      await page.goto(detail, { waitUntil: "networkidle" });
      await page.waitForSelector(".detail-section");

      const said = await page.evaluate(sectionText("What people said"));
      assert(said, "the user-reports section vanished on a 403");
      assert(
        /don't have access/.test(said),
        `a 403 was reported as something else: ${JSON.stringify(said)}`
      );
      await page.close();
    });

    // --------------------------------------------------------------- on a phone

    /**
     * 390 points wide, which is an iPhone, and the width these screens have
     * twice been broken at — once by a table that would not shrink and once
     * by a nav that grew. Both times the symptom was the same and neither
     * was visible on a laptop: the page scrolls sideways, so every line of
     * text runs off the edge and reading anything means dragging it back.
     *
     * The nav is measured too, because the fix for the second one is only a
     * fix while the links stay reachable — a row that scrolls sideways is
     * the trade, and a row that has quietly become three is not.
     */
    await test("nothing scrolls sideways on a phone, and the nav stays one row", async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await phone.addCookies([
        { name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true },
      ]);
      const page = await phone.newPage();

      try {
        for (const [name, url, ready] of [
          ["the issue list", `${MOUNT}/issues?range=14d&q=`, "#issue-rows"],
          ["the issue itself", detail, ".comment-form textarea"],
          ["every tag value", `${detail}/tags`, "#view h2"],
        ]) {
          await page.goto(url, { waitUntil: "networkidle" });
          await page.waitForSelector(ready, { timeout: 15_000 });

          const { viewport, width } = await page.evaluate(() => ({
            viewport: window.innerWidth,
            width: document.documentElement.scrollWidth,
          }));
          assert(
            width <= viewport,
            `${name} is ${width}px wide in a ${viewport}px window — it scrolls sideways`
          );
        }

        const nav = await page.evaluate(() => {
          const block = document.querySelector(".sidebar-external");
          const links = [...block.querySelectorAll("a")].filter((a) => !a.hidden);
          const rows = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
          return { links: links.length, rows: rows.size, height: block.getBoundingClientRect().height };
        });
        assert(nav.links >= 5, `the GlitchTip links went missing on a phone (${nav.links})`);
        assert(nav.rows === 1, `the GlitchTip links wrapped onto ${nav.rows} rows`);
      } finally {
        await phone.close();
      }
    });

    // ------------------------------------------------------------ every tag value

    await test("the tags screen lists values, and links back to the issue", async () => {
      const page = await context.newPage();
      await page.goto(`${detail}/tags`, { waitUntil: "networkidle" });
      await page.waitForSelector("#view h2");

      const heading = await page.textContent("#view h2");
      assert(heading.trim() === "Tags", `wrong heading: ${JSON.stringify(heading)}`);

      const back = page.locator("#view a", { hasText: "Back to the issue" });
      assert(await back.count(), "no way back to the issue");
      await back.click();
      await page.waitForSelector(".comment-form textarea", { timeout: 10_000 });
      assert(
        page.url().includes(`/issues/${issueId}`) && !page.url().includes("/tags"),
        `back went somewhere else: ${page.url()}`
      );
      await page.close();
    });
  } finally {
    await removeOurNotes(key, org, issueId).catch(() => {});
    await browser.close();
    try {
      script("--clear", key);
    } catch {
      // The session expires on its own; a failure to tidy is not a failure.
    }
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  process.stdout.write(`\nsuite could not run: ${error.stack || error.message}\n`);
  process.exit(1);
});
