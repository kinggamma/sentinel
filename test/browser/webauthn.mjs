#!/usr/bin/env node
/**
 * Signing in with a passkey, against a virtual authenticator.
 *
 * There is no way to hand-test this repeatably. A real key needs a person to
 * touch it, and the failure modes that matter are all in the encoding —
 * challenges and signatures travel as base64url and arrive as ArrayBuffers,
 * and getting a conversion wrong produces a browser prompt that appears
 * perfectly normally and then fails with nothing useful to say.
 *
 * Chrome's DevTools protocol can create an authenticator that signs without
 * anybody present, which is the only way this flow gets exercised at all.
 *
 *   npm run test:webauthn
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
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

function shell(python) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "glitchtip-web", "./manage.py", "shell", "-c", python],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
}

/** A password we set for this run, so the run is self-contained. */
function setPassword() {
  const password = `Wa-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  shell(`
from django.contrib.auth import get_user_model
u = get_user_model().objects.get(email=${JSON.stringify(EMAIL)})
u.set_password(${JSON.stringify(password)})
u.is_active = True
u.save()
print("ok")`);
  return password;
}

function clearAuthenticators() {
  shell(`
from allauth.mfa.models import Authenticator
from django.contrib.auth import get_user_model
u = get_user_model().objects.get(email=${JSON.stringify(EMAIL)})
Authenticator.objects.filter(user=u).delete()
print("cleared")`);
}

/**
 * A virtual security key, attached over CDP.
 *
 * internalUid + residentCredential is what makes it a *passkey* — one the
 * browser can offer without being told which account it belongs to, which is
 * the whole point of passkey login.
 */
async function attachAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

const password = setPassword();
clearAuthenticators();

const browser = await chromium.launch();

try {
  process.stdout.write("\nWebAuthn, against a virtual authenticator\n");

  await test("a security key can be registered and then used as a second factor", async () => {
    clearAuthenticators();
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${BASE}/sentinel/signin`, { waitUntil: "load" });
    const { cdp } = await attachAuthenticator(page);

    // Sign in with the password first: registering a key needs a session.
    await page.fill("#email-input", EMAIL);
    await page.fill("#password-input", password);
    await page.click(".gate-card button[type=submit]");
    await page.waitForFunction(() => !document.getElementById("topbar")?.hidden, { timeout: 20_000 });

    /**
     * Registration is account management rather than a login flow, so it has
     * no screen yet (that is Phase 7). Driving allauth directly here is
     * deliberate: the point of this test is the *login* half, and it needs a
     * key to exist before it can prove anything about using one.
     */
    const registered = await page.evaluate(async () => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
      const optionsRes = await fetch("/_allauth/browser/v1/account/authenticators/webauthn", {
        credentials: "same-origin",
      });
      const options = (await optionsRes.json())?.data?.creation_options;
      if (!options) return { ok: false, why: `no creation options (${optionsRes.status})` };

      const b64 = (buf) =>
        btoa(String.fromCharCode(...new Uint8Array(buf)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const un = (s) => {
        const p = s.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
      };

      const publicKey = { ...options.publicKey };
      publicKey.challenge = un(publicKey.challenge);
      publicKey.user = { ...publicKey.user, id: un(publicKey.user.id) };
      if (publicKey.excludeCredentials) {
        publicKey.excludeCredentials = publicKey.excludeCredentials.map((c) => ({
          ...c,
          id: un(c.id),
        }));
      }

      const credential = await navigator.credentials.create({ publicKey });
      const payload = {
        id: credential.id,
        rawId: b64(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: b64(credential.response.clientDataJSON),
          attestationObject: b64(credential.response.attestationObject),
        },
      };

      const res = await fetch("/_allauth/browser/v1/account/authenticators/webauthn", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrftoken": csrf },
        body: JSON.stringify({ name: "Test key", credential: payload }),
      });
      return { ok: res.ok, why: `${res.status} ${(await res.text()).slice(0, 160)}` };
    });
    assert(registered.ok, `could not register a key: ${registered.why}`);

    // Now sign out and back in: the password alone should no longer be enough.
    await page.evaluate(() =>
      fetch("/sentinel/api/auth/logout", { method: "POST", credentials: "same-origin" })
    );
    await page.goto(`${BASE}/sentinel/signin?next=%2Fissues`, { waitUntil: "load" });
    await page.fill("#email-input", EMAIL);
    await page.fill("#password-input", password);
    await page.click(".gate-card button[type=submit]");

    await page.waitForURL(/\/sentinel\/mfa/, { timeout: 20_000 });
    const keyButton = page.locator(".gate-card button", { hasText: "Use a security key" });
    assert(await keyButton.count(), "the second-factor screen offered no security key");

    await keyButton.click();
    await page.waitForURL(/\/sentinel\/issues/, { timeout: 20_000 });
    // The URL changes before the guard has finished asking who this is, so
    // the app appearing is a separate wait rather than a same-tick check.
    await page.waitForFunction(() => !document.getElementById("topbar")?.hidden, {
      timeout: 20_000,
    });
    assert(!errors.length, `page errors: ${errors.join("; ")}`);

    await cdp.send("WebAuthn.disable").catch(() => {});
    await context.close();
  });

  await test("a passkey signs in on its own, with no password", async () => {
    // Starts from nothing: the test above leaves a key on this account, and
    // inheriting it would send the password step below to a second-factor
    // screen instead of into the app.
    clearAuthenticators();

    /**
     * The real thing, and it has to happen in one context.
     *
     * A virtual authenticator belongs to the browser context that created
     * it, so a key registered in one and a sign-in attempted in another can
     * never meet. An earlier version of this test did exactly that, watched
     * the button appear, watched the prompt find nothing, and reported a
     * pass — it was testing that a button renders and that cancelling is
     * handled, which is not what its name claimed.
     *
     * So: one context. Register a discoverable credential, throw the session
     * away, and sign in with nothing but the key.
     */
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${BASE}/sentinel/signin`, { waitUntil: "load" });
    const { cdp } = await attachAuthenticator(page);

    await page.fill("#email-input", EMAIL);
    await page.fill("#password-input", password);
    await page.click(".gate-card button[type=submit]");
    await page.waitForFunction(() => !document.getElementById("topbar")?.hidden, { timeout: 20_000 });

    const registered = await page.evaluate(async () => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
      const res = await fetch("/_allauth/browser/v1/account/authenticators/webauthn", {
        credentials: "same-origin",
      });
      const options = (await res.json())?.data?.creation_options;
      if (!options) return { ok: false, why: `no creation options (${res.status})` };

      const b64 = (buf) =>
        btoa(String.fromCharCode(...new Uint8Array(buf)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const un = (s) => {
        const p = s.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
      };

      const publicKey = { ...options.publicKey };
      publicKey.challenge = un(publicKey.challenge);
      publicKey.user = { ...publicKey.user, id: un(publicKey.user.id) };
      // Discoverable, or the browser cannot offer it without being told
      // whose account it is — which is the whole point of a passkey.
      publicKey.authenticatorSelection = {
        ...(publicKey.authenticatorSelection || {}),
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      };

      const credential = await navigator.credentials.create({ publicKey });
      const payload = {
        id: credential.id,
        rawId: b64(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: b64(credential.response.clientDataJSON),
          attestationObject: b64(credential.response.attestationObject),
        },
      };
      const post = await fetch("/_allauth/browser/v1/account/authenticators/webauthn", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrftoken": csrf },
        body: JSON.stringify({ name: "Test passkey", credential: payload }),
      });
      return { ok: post.ok, why: `${post.status} ${(await post.text()).slice(0, 160)}` };
    });
    assert(registered.ok, `could not register a passkey: ${registered.why}`);

    // Throw the session away entirely, so nothing but the key remains.
    await page.evaluate(() =>
      fetch("/sentinel/api/auth/logout", { method: "POST", credentials: "same-origin" })
    );
    await context.clearCookies();
    await page.goto(`${BASE}/sentinel/signin?next=%2Fissues`, { waitUntil: "load" });

    // Waited for, not counted. Whether passkey login is on at all comes from
    // allauth's capability document, which the screen fetches after it
    // paints — so asking the instant the page loads is a race, and one this
    // test lost the moment anything else was added to boot.
    const passkey = page.locator(".gate-card button", { hasText: "Use a passkey instead" });
    await passkey
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => assert(false, "the sign-in screen offered no passkey option"));

    // No email, no password typed. Just the key.
    await passkey.click();
    await page.waitForURL(/\/sentinel\/issues/, { timeout: 20_000 });
    await page.waitForFunction(() => !document.getElementById("topbar")?.hidden, {
      timeout: 20_000,
    });

    const who = await page.evaluate(async () =>
      (await (await fetch("/sentinel/api/auth/me", { credentials: "same-origin" })).json()).email
    );
    assert(who === EMAIL, `signed in as ${who}`);
    assert(!errors.length, `page errors: ${errors.join("; ")}`);

    await cdp.send("WebAuthn.disable").catch(() => {});
    await context.close();
  });

} finally {
  await browser.close();
  clearAuthenticators();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
