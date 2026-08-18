import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { orgSlug } from "./glitchtip.js";

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

/** appName -> { slug, org, dsn, createdAt } */
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

/**
 * What a slug turns out to mean, when it turns out to mean two things.
 *
 * A project slug is unique inside its organisation and nowhere else —
 * GlitchTip's own constraint is (organization, slug) — so two organisations
 * may each own a project called "admin". This file keyed organisations by
 * slug alone, so the second one seen overwrote the first, and the answer to
 * "which organisation owns this project" became whichever was looked at
 * last. Authorization then compared against that answer: one organisation's
 * members could be granted another's reports, and the rightful owners denied
 * their own.
 *
 * A slug that has been seen in more than one organisation is recorded as
 * ambiguous instead of as the newer of the two, and answering for it is
 * refused. Refusing is safe in the direction that matters — an app whose
 * organisation cannot be established is not shown to people at all — and the
 * app's own record carries its organisation now, so nothing that has been
 * provisioned since depends on this map to answer.
 */
const AMBIGUOUS = Symbol("more than one organisation owns this slug");

/** Record project->organisation pairs seen during a sign-in. */
export async function rememberProjectOrgs(pairs) {
  await loadOrgs();
  let changed = false;
  for (const { slug, org } of pairs) {
    if (!slug || !org) continue;
    const known = projectOrgs[slug];
    if (known === org) continue;
    /**
     * Seen somewhere else before. That is either two organisations using
     * one name or a project that has moved, and a slug cannot tell those
     * apart — so this stops claiming to know, rather than believing the
     * older answer or the newer one.
     *
     * It is only ever a hint now. Authorization asks the app's own record
     * and the configured organisation first, and falls back to what the
     * viewer can see; this map exists to build links, where being unsure
     * costs a link rather than an answer about who may read what.
     */
    projectOrgs[slug] = known === undefined ? org : "?";
    changed = true;
  }
  if (!changed) return;

  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${ORGS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(projectOrgs, null, 2));
  await rename(tmp, ORGS_PATH);
}

/**
 * Which organisation a project belongs to, if that can be answered at all.
 *
 * Null covers two different situations on purpose: nobody has told us, and
 * more than one organisation has. Both mean the same thing to a caller
 * deciding whether somebody may read something — it cannot be established,
 * so it is not granted.
 */
export async function orgForProject(slug) {
  if (!slug) return null;
  await loadOrgs();
  const known = projectOrgs[slug];
  return !known || known === "?" ? null : known;
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

export async function remember(appName, { slug, org = null, dsn }) {
  await load();
  learned[appName] = {
    slug,
    // Recorded with the app rather than looked up by slug later. This is the
    // authoritative answer for anything provisioned since: the slug map can
    // only say what a slug means when exactly one organisation uses it.
    org: org || null,
    dsn: dsn || null,
    createdAt: new Date().toISOString(),
  };
  await persist();
}

/**
 * The organisation an app reports into, from the app's own record first.
 *
 * Falls back to the slug map for apps recorded before organisations were
 * stored here, which answers for every slug only one organisation uses and
 * refuses for the rest.
 */
export async function orgForApp(appName) {
  await load();

  // What provisioning recorded when it made the project. Authoritative.
  const recorded = learned[appName]?.org;
  if (recorded) return recorded;

  /**
   * Nothing recorded — an app mapped by GLITCHTIP_PROJECT_MAP, or one
   * provisioned before organisations were stored here.
   *
   * The configured organisation answers for those: Sentinel creates every
   * project it provisions there, and that variable names projects for this
   * same install. It is also the answer that closes the leak, because it
   * does not move when somebody elsewhere makes a project with the same
   * name.
   *
   * Unset — a deployment serving several organisations — this returns null
   * and the caller falls back to what the viewer can actually see, which is
   * the only remaining evidence and is handled there because it depends on
   * who is asking.
   */
  return orgSlug() || null;
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
