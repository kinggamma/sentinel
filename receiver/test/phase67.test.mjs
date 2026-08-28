#!/usr/bin/env node
/** Pure contracts behind the Phase 6 and 7 browser forms. */
import {
  environmentRows,
  socialAppPayload,
  tokenCreatedAt,
  validWizardHash,
} from "../public/lib/phase67.js";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function same(got, wanted, message) {
  assert(JSON.stringify(got) === JSON.stringify(wanted),
    `${message}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
}

process.stdout.write("\nPhase 6/7 contracts\n");
await test("organisation environments are deduplicated and sorted", () => {
  same(environmentRows([{ id: 2, name: "production" }, { id: 1, name: "staging" }, { id: 2, name: "production" }]),
    [{ id: 2, name: "production" }, { id: 1, name: "staging" }], "environment rows");
});
await test("SSO create carries issuer and secret", () => {
  same(socialAppPayload({ name: "Acme", provider: "openid_connect", clientId: "client", clientSecret: "secret", serverUrl: "https://id.example.com/" }),
    { name: "Acme", provider: "openid_connect", clientID: "client", clientSecret: "secret", serverUrl: "https://id.example.com" }, "create payload");
});
await test("SSO edit omits an unchanged blank secret", () => {
  same(socialAppPayload({ name: "Acme", clientId: "new-client", clientSecret: "", serverUrl: "https://id.example.com/" }, { editing: true }),
    { name: "Acme", clientID: "new-client", serverUrl: "https://id.example.com" }, "edit payload");
});
await test("token timestamps use the pinned API's created field", () => {
  same(tokenCreatedAt({ created: "2026-08-20T10:00:00Z" }), "2026-08-20T10:00:00Z", "created");
  same(tokenCreatedAt({ dateCreated: "legacy" }), "legacy", "legacy fallback");
});
await test("setup wizard accepts exactly the backend's 64 lower-case letters and digits", () => {
  assert(validWizardHash("a".repeat(64)), "64 lowercase letters should be accepted");
  assert(validWizardHash("1".repeat(64)), "64 digits should be accepted");
  assert(!validWizardHash("A".repeat(64)), "uppercase should be refused");
  assert(!validWizardHash("a".repeat(63)), "short hashes should be refused");
  assert(!validWizardHash("../" + "a".repeat(61)), "path material should be refused");
});
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
