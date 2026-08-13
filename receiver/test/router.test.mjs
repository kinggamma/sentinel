#!/usr/bin/env node
/**
 * The router's path matcher, on its own.
 *
 * Everything else in the router is browser plumbing that only a browser can
 * exercise, but the pattern compiler is real logic and fails silently: a
 * pattern that never matches shows an empty screen rather than an error. The
 * first version did exactly that — it escaped regex metacharacters and then
 * looked for an escaped slash, which the escaping never produced, so every
 * route with a parameter matched nothing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "public", "lib", "router.js"), "utf8");

// Lifted out rather than imported: the module reaches for document and
// window at import time, and this needs neither.
const compileSource = source.match(/function compile[\s\S]*?\n}/)[0];
const compile = new Function(`${compileSource}\nreturn compile;`)();

const cases = [
  ["/", "/", {}],
  // currentPath() normalises an empty path to "/", so the matcher never
  // sees "" and isn't asked to handle it.
  ["/issues", "/issues", {}],
  ["/issues", "/issues/", {}],
  ["/issues", "/issue", null],
  ["/issues/:id", "/issues/42", { id: "42" }],
  ["/issues/:id", "/issues", null],
  ["/issues/:id", "/issues/42/extra", null],
  ["/issues/:id", "/issues/a%20b", { id: "a b" }],
  ["/reports/:app", "/reports/e-library-admin", { app: "e-library-admin" }],
  ["/reports/:app", "/reports/", null],
  ["/settings/teams/:slug", "/settings/teams/just-me", { slug: "just-me" }],
  ["/settings/teams/:slug/members", "/settings/teams/x/members", { slug: "x" }],
];

let passed = 0;
const failures = [];

for (const [pattern, input, expected] of cases) {
  const { regex, names } = compile(pattern);
  const found = regex.exec(input);
  const got = found
    ? Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])]))
    : null;

  if (JSON.stringify(got) === JSON.stringify(expected)) {
    passed += 1;
    process.stdout.write(`  ✓ ${pattern} vs ${input || "(empty)"}\n`);
  } else {
    failures.push(`${pattern} vs ${input}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(expected)}`);
    process.stdout.write(`  ✗ ${pattern} vs ${input}\n      ${JSON.stringify(got)} != ${JSON.stringify(expected)}\n`);
  }
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
