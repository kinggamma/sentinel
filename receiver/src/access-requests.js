import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * People asking to be let in.
 *
 * GlitchTip has no concept of requesting access: somebody with an account but
 * no organisation can sign in, see nothing, and has no way to say so. Their
 * only route is finding an administrator out-of-band and asking to be
 * invited, which is exactly the sort of errand that doesn't get done.
 *
 * So a request lives here. Approving one is still GlitchTip's decision to
 * carry out — we ask it to invite them, and it issues the invitation — but
 * the asking, the queue, and the answer live in Sentinel, which is the part
 * that was missing.
 *
 * Keyed by email, because the point of a request is the person: asking twice
 * updates the same request rather than making a queue of duplicates.
 */
const DATA_DIR = process.env.DATA_DIR || "/data";
const STORE = path.join(DATA_DIR, "access-requests.json");

/** email -> request */
let requests = {};
let loaded = false;

async function load() {
  if (loaded) return;
  try {
    requests = JSON.parse(await readFile(STORE, "utf8"));
  } catch {
    requests = {};
  }
  loaded = true;
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE}.tmp`;
  await writeFile(tmp, JSON.stringify(requests, null, 2));
  await rename(tmp, STORE);
}

function key(email) {
  return String(email || "").trim().toLowerCase();
}

/** Raise or refresh a request. Returns the stored request. */
export async function requestAccess({ email, name, note }) {
  const id = key(email);
  if (!id) throw new Error("an email address is required");

  await load();
  const existing = requests[id];

  // An approved request stays approved: the invitation is already out, and
  // clicking again shouldn't withdraw it.
  if (existing?.status === "approved") return existing;

  requests[id] = {
    id: existing?.id || crypto.randomUUID(),
    email: id,
    name: name || existing?.name || null,
    note: String(note || "").slice(0, 500) || existing?.note || null,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    organization: null,
    inviteLink: null,
  };
  await persist();
  return requests[id];
}

export async function myRequest(email) {
  await load();
  return requests[key(email)] || null;
}

export async function listRequests() {
  await load();
  return Object.values(requests).sort((a, b) =>
    String(b.requestedAt).localeCompare(String(a.requestedAt))
  );
}

export async function findById(id) {
  await load();
  return Object.values(requests).find((r) => r.id === id) || null;
}

/**
 * Record the outcome. The invitation link is kept because with email
 * disabled it is the only way the person can act on being approved — and
 * showing it to them beats an administrator copying it out of a log.
 */
export async function decide(id, { status, decidedBy, organization, inviteLink }) {
  await load();
  const request = Object.values(requests).find((r) => r.id === id);
  if (!request) return null;

  request.status = status;
  request.decidedAt = new Date().toISOString();
  request.decidedBy = decidedBy || null;
  request.organization = organization || null;
  request.inviteLink = inviteLink || null;
  await persist();
  return request;
}

/** Once someone is a member, their request has served its purpose. */
export async function clearRequest(email) {
  await load();
  const id = key(email);
  if (!requests[id]) return;
  delete requests[id];
  await persist();
}
