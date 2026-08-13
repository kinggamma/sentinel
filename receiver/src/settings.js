import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Where each app runs.
 *
 * An app's browser code may only post reports from an address the receiver
 * has been told about, and that address changes — localhost while it's being
 * built, a server address when it goes live, a domain later. Keeping one
 * flat list of every allowed origin made that a guessing game: no way to
 * tell which app a URL belonged to, or which entry to change when one of
 * them moved.
 *
 * So origins can hang off an app as well as standing on their own. The
 * global list is still there — it's the quickest way to get something
 * reporting, and the right home for an address that isn't tied to one app —
 * and per-app entries answer the question people actually have when an app
 * moves: where does *this* one run? The receiver uses the union of all of
 * them for CORS and frame-ancestors, since a browser preflight arrives
 * before anything identifies which app sent it.
 *
 * Apps can be registered before they report. They have to be: an app posting
 * from a browser can't get a report in until its origin is allowed, so
 * waiting for a first report would deadlock.
 *
 * ALLOWED_ORIGINS still works and still applies to everything. It's the
 * deployment's own floor, so nothing set there can be removed from a
 * browser.
 */
const DATA_DIR = process.env.DATA_DIR || "/data";
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const ENV_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Origins that apply to everything, however they were added. */
let globalOrigins = [];
/** appName -> { origins: string[] } */
let apps = {};
let loaded = false;

async function load() {
  if (loaded) return;
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    apps = parsed.apps && typeof parsed.apps === "object" ? parsed.apps : {};
    globalOrigins = Array.isArray(parsed.origins) ? parsed.origins : [];
  } catch {
    apps = {};
    globalOrigins = [];
  }
  loaded = true;
}

/**
 * Read at boot so the CORS and CSP checks can stay synchronous — they run on
 * every request, including the preflight that decides whether an app may
 * report at all.
 */
export async function initSettings() {
  await load();
}

/** An origin is a scheme and a host, nothing else. */
export function normaliseOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Everything allowed right now, across every app plus the environment. */
export function allowedOrigins() {
  const fromApps = Object.values(apps).flatMap((app) => app.origins || []);
  return [...new Set([...ENV_ORIGINS, ...globalOrigins, ...fromApps])];
}

/**
 * The global list: origins that apply whatever the app. Still the right
 * place for something that isn't tied to one app, or for getting a new app
 * reporting before you've decided how to organise it.
 */
export function listGlobalOrigins() {
  return [...new Set([...ENV_ORIGINS, ...globalOrigins])];
}

export async function setGlobalOrigins(origins) {
  await load();
  globalOrigins = [...new Set(origins.map(normaliseOrigin).filter(Boolean))]
    // Anything the environment already fixes is implied, not stored.
    .filter((origin) => !ENV_ORIGINS.includes(origin));
  await persist();
  return listGlobalOrigins();
}

/** Set in the deployment's configuration, so not removable from the viewer. */
export function fixedOrigins() {
  return [...ENV_ORIGINS];
}

/** Every app we've been told about, whether or not it has reported yet. */
export function registeredApps() {
  return Object.entries(apps).map(([appName, value]) => ({
    appName,
    origins: value.origins || [],
  }));
}

export function originsForApp(appName) {
  return apps[appName]?.origins || [];
}

/**
 * Replace one app's origins. An app with no origins is still worth keeping:
 * it reports from a server, or hasn't been given an address yet.
 */
export async function setAppOrigins(appName, origins) {
  const name = String(appName || "").trim();
  if (!name) throw new Error("an app name is required");

  await load();
  apps[name] = {
    origins: [...new Set(origins.map(normaliseOrigin).filter(Boolean))],
  };
  await persist();
  return registeredApps();
}

/** Forget an app's settings. Its reports are untouched. */
export async function forgetApp(appName) {
  await load();
  delete apps[appName];
  await persist();
  return registeredApps();
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify({ origins: globalOrigins, apps }, null, 2));
  await rename(tmp, SETTINGS_PATH);
}
