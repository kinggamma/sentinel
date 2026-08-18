#!/usr/bin/env node
/**
 * What each organisation role may do.
 *
 * A mirror of GlitchTip's own scope table, so the thing worth testing is
 * that it still says what GlitchTip says — and the thing worth testing
 * hardest is the direction it fails in. A role read as more capable than it
 * is puts buttons on screen that answer 404 with no explanation, because a
 * scope failure there is indistinguishable from a missing route.
 *
 *   node test/roles.test.mjs
 */
import { abilities } from "../src/auth/roles.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
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

function same(got, wanted, message) {
  assert(got === wanted, `${message}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
}

process.stdout.write("\nWhat a role may do\n");

// ------------------------------------------------------- the table itself

const TABLE = [
  // role,     projects, teams, members
  ["member",   false,    false, false],
  ["admin",    true,     true,  false],
  ["manager",  true,     true,  true],
  ["owner",    true,     true,  true],
];

for (const [role, projects, teams, members] of TABLE) {
  test(`${role}`, () => {
    const can = abilities(role);
    same(can.role, role, `${role}: role`);
    same(can.canManageProjects, projects, `${role}: projects`);
    same(can.canManageTeams, teams, `${role}: teams`);
    same(can.canManageMembers, members, `${role}: members`);
  });
}

test("a member cannot create a project, which is the case that was found the hard way", () => {
  assert(!abilities("member").canManageProjects, "a member was granted project writes");
});

test("an admin can make projects and teams but cannot invite anybody", () => {
  const can = abilities("admin");
  assert(can.canManageProjects && can.canManageTeams, "admin should manage projects and teams");
  assert(!can.canManageMembers, "member:write belongs to manager and above");
});

// --------------------------------------------- everything else it might get

test("no role is no permission, not some permission", () => {
  for (const nothing of [null, undefined, ""]) {
    const can = abilities(nothing);
    same(can.role, null, `${JSON.stringify(nothing)}: role`);
    assert(
      !can.canManageProjects && !can.canManageTeams && !can.canManageMembers,
      `${JSON.stringify(nothing)} granted something`
    );
  }
});

test("a role nobody here knows grants nothing, rather than being ranked", () => {
  /**
   * The failure that matters. An unknown string sorted optimistically — or
   * compared as a string against "admin" — is how a future GlitchTip role
   * silently becomes an owner here.
   */
  for (const unknown of ["billing", "superuser", "OWNER_", "zzz", "0", 7, {}]) {
    const can = abilities(unknown);
    same(can.role, null, `${JSON.stringify(unknown)}: role`);
    assert(
      !can.canManageProjects && !can.canManageTeams && !can.canManageMembers,
      `${JSON.stringify(unknown)} was granted something`
    );
  }
});

test("case is not what decides whether somebody may act", () => {
  for (const spelling of ["Owner", "OWNER", "oWnEr"]) {
    const can = abilities(spelling);
    same(can.role, "owner", `${spelling}: role`);
    assert(can.canManageMembers, `${spelling} should manage members`);
  }
});

test("the answer cannot be edited by whoever received it", () => {
  const can = abilities("member");
  try {
    can.canManageProjects = true;
  } catch {
    // Strict mode throws; either way the value must not change.
  }
  same(can.canManageProjects, false, "a frozen answer changed");
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
