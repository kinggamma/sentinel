#!/usr/bin/env node
/**
 * The regressions that need a real browser.
 *
 * Everything in receiver/test/smoke.mjs is HTTP: it asks the API questions
 * and checks the answers. That suite was completely green while the embedded
 * viewer was broken, because the viewer breaks on the boot path a browser
 * takes — it asks who it is before it fetches anything, was told "nobody",
 * and a guard put a Sentinel sign-in form inside somebody's admin page. No
 * amount of calling the API directly with a bearer token can see that.
 *
 * So these run a browser, in an iframe, on a host page, with no cookies: the
 * shape the thing actually ships in.
 *
 * Two deliberate choices about how it runs:
 *
 * It lives at the repository root rather than in receiver/, because the
 * image's assets stage runs `npm install --include=dev` in there and putting
 * a browser driver in that package would make every image build fetch one.
 *
 * And it binds no port. The host page has to come from an origin the
 * receiver already allows to frame it — frame-ancestors is built from that
 * list — but those origins are where somebody's actual apps run. Serving the
 * page from memory through request interception borrows the origin without
 * taking the port, so this cannot collide with a dev server that is already
 * running on it.
 *
 *   npm install && npm run test:browser
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const STANDALONE = (process.env.STANDALONE_URL || "http://localhost:4000").replace(/\/+$/, "");
/** An origin the receiver allows to frame the viewer. Never actually served. */
const HOST_ORIGIN = (process.env.HOST_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");
const HOST_URL = `${HOST_ORIGIN}/__sentinel-embed-test`;

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

function staffToken() {
  if (process.env.STAFF_API_TOKEN) return process.env.STAFF_API_TOKEN;
  try {
    return execFileSync(
      "docker",
      ["compose", "exec", "-T", "feedback-receiver", "printenv", "STAFF_API_TOKEN"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "";
  }
}

/**
 * A stand-in for an app's admin page: it frames the viewer and hands over the
 * shared token when the viewer says it is ready, which is the handshake the
 * real integrations implement.
 */
function hostPage(token, app) {
  return `<!doctype html><meta charset="utf-8"><title>Host admin</title>
<h1>Host admin page</h1>
<iframe id="viewer" src="${STANDALONE}/?app=${encodeURIComponent(app)}&embed=1"
        style="width:900px;height:600px;border:0"></iframe>
<script>
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "incident-viewer-ready") {
      event.source.postMessage(
        { type: "incident-viewer-token", token: ${JSON.stringify(token)} },
        "*"
      );
    }
  });
</script>`;
}

/** A fresh browser context with no cookies, serving the host page from memory. */
async function embed(browser, { token, app = "mewaka-lms" }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route(HOST_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: hostPage(token, app) })
  );
  await page.goto(HOST_URL, { waitUntil: "load" });
  return { context, page, errors, frame: page.frameLocator("#viewer") };
}

// --------------------------------------------------------------------- run

const token = staffToken();
if (!token) {
  process.stdout.write(
    "STAFF_API_TOKEN not readable — set it, or start the stack so it can be read from the container.\n"
  );
  process.exit(1);
}

/**
 * The host page is served from memory rather than from a listening socket,
 * and Chrome treats a request from such a page to localhost as local network
 * access — which it now blocks by default, with
 * ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS. That is a fact about this
 * harness borrowing an origin it does not really serve, not about the
 * product: the same page from a real server on the same port loads fine.
 */
const browser = await chromium.launch({
  args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"],
});

try {
  process.stdout.write("\nThe embedded viewer, in a real iframe with no session\n");

  await test("it renders reports, and never a sign-in form", async () => {
    const { context, frame, errors } = await embed(browser, { token });

    // The rows prove it authenticated; the absence of the form proves it did
    // not fall back to asking who we are, which is what it did when
    // /auth/me answered from the session cookie alone.
    await frame.locator(".list li a.row").first().waitFor({ timeout: 20_000 });
    assert(
      (await frame.locator("#email-input").count()) === 0,
      "a Sentinel sign-in form appeared inside the host page"
    );
    assert(!errors.length, `page errors: ${errors.join("; ")}`);

    const cookies = await context.cookies();
    assert(
      !cookies.some((cookie) => cookie.name === "sessionid"),
      `it acquired a session: ${cookies.map((c) => c.name).join(", ")}`
    );
    await context.close();
  });

  await test("it is pinned to the app its host page is about", async () => {
    const { context, frame } = await embed(browser, { token, app: "mewaka-lms" });
    await frame.locator(".list li a.row").first().waitFor({ timeout: 20_000 });

    // Scoped sessions have no way back to "all projects", and the breadcrumb
    // names the one app they are for.
    const crumb = await frame.locator("#crumb").textContent();
    assert(/mewaka-lms/.test(crumb || ""), `breadcrumb was ${JSON.stringify(crumb)}`);
    await context.close();
  });

  await test("a token the receiver does not know is refused", async () => {
    // The right shape, the wrong secret. Proves the reports above appear
    // because of the token rather than because the path is open.
    const { context, frame, page } = await embed(browser, { token: "x".repeat(token.length) });
    await page.waitForTimeout(5000);
    assert(
      (await frame.locator(".list li a.row").count()) === 0,
      "an unknown token was shown somebody's reports"
    );
    await context.close();
  });
} finally {
  await browser.close();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
