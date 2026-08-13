import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Which GlitchTip project an app reports to.
 *
 * Apps name themselves, and that name needn't match a GlitchTip project
 * slug, so something has to hold the mapping. Two sources, in order:
 *
 *   1. GLITCHTIP_PROJECT_MAP — set by hand, always wins. Existing installs
 *      already have one, and an operator overriding a guess should stay
 *      overridden.
 *   2. What Sentinel worked out itself when an app first reported and its
 *      project was created for it. Kept on disk beside the reports, since a
 *      container restart shouldn't mean re-creating projects.
 */
const DATA_DIR = process.env.DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "projects.json");

let manual = {};
try {
  manual = JSON.parse(process.env.GLITCHTIP_PROJECT_MAP || "{}");
} catch {
  console.warn("GLITCHTIP_PROJECT_MAP is not valid JSON — ignoring it.");
}

/** appName -> { slug, dsn, createdAt } */
let learned = {};
let loaded = false;

/**
 * GlitchTip project slug -> organisation slug.
 *
 * Links into GlitchTip are per-organisation (`/<org>/issues`), so building
 * one needs to know which organisation a project belongs to. Nothing here is
 * configured: every sign-in already lists the projects that person can see,
 * each carrying its organisation, so the answer arrives as a side effect of
 * people using the viewer. Kept in its own file so an older projects.json
 * needs no migration.
 */
const ORGS_PATH = path.join(DATA_DIR, "project-orgs.json");
let projectOrgs = {};
let orgsLoaded = false;

async function loadOrgs() {
  if (orgsLoaded) return;
  try {
    projectOrgs = JSON.parse(await readFile(ORGS_PATH, "utf8"));
  } catch {
    projectOrgs = {};
  }
  orgsLoaded = true;
}

/** Record project->organisation pairs seen during a sign-in. */
export async function rememberProjectOrgs(pairs) {
  await loadOrgs();
  let changed = false;
  for (const { slug, org } of pairs) {
    if (!slug || !org || projectOrgs[slug] === org) continue;
    projectOrgs[slug] = org;
    changed = true;
  }
  if (!changed) return;

  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${ORGS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(projectOrgs, null, 2));
  await rename(tmp, ORGS_PATH);
}

/** Which organisation a project belongs to, if anyone has told us. */
export async function orgForProject(slug) {
  if (!slug) return null;
  await loadOrgs();
  return projectOrgs[slug] || null;
}

async function load() {
  if (loaded) return;
  try {
    learned = JSON.parse(await readFile(STORE_PATH, "utf8"));
  } catch {
    // No store yet, or it's unreadable. Either way we start empty and
    // rewrite it on the next successful provision.
    learned = {};
  }
  loaded = true;
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  // Write-then-rename, so a crash mid-write can't leave a truncated file
  // that would look like "no projects known" on the next boot.
  const tmp = `${STORE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(learned, null, 2));
  await rename(tmp, STORE_PATH);
}

/** The GlitchTip project slug for an app, or null if we don't know one. */
export async function slugForApp(appName) {
  if (manual[appName]) return manual[appName];
  await load();
  return learned[appName]?.slug || null;
}

/** The DSN we were handed when the project was created, if we created it. */
export async function dsnForApp(appName) {
  await load();
  return learned[appName]?.dsn || null;
}

/** True when this app is already accounted for and needs no provisioning. */
export async function isKnown(appName) {
  return Boolean(await slugForApp(appName));
}

export async function remember(appName, { slug, dsn }) {
  await load();
  learned[appName] = { slug, dsn: dsn || null, createdAt: new Date().toISOString() };
  await persist();
}

/** Everything we know, for the viewer. Synchronous read after a load(). */
export async function all() {
  await load();
  const names = new Set([...Object.keys(manual), ...Object.keys(learned)]);
  const out = {};
  for (const name of names) {
    out[name] = {
      slug: manual[name] || learned[name]?.slug || null,
      dsn: learned[name]?.dsn || null,
      // Worth telling apart in the UI: a hand-mapped project may well not
      // have been created by us, so we have no DSN to show for it.
      source: manual[name] ? "configured" : "created",
    };
  }
  return out;
}
