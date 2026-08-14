/**
 * Signing out a session nobody is using.
 *
 * GlitchTip's sessions are absolute: seven days from the moment you sign in,
 * whether you used it constantly or walked away from an unlocked laptop in
 * the first minute. Django can slide that window on activity — that is
 * SESSION_SAVE_EVERY_REQUEST — but GlitchTip does not read it from the
 * environment, and the image stays stock, so a sliding session has to be
 * ours.
 *
 * Two things make this less obvious than it sounds.
 *
 * The receiver cannot see most of what a person does. Issues, projects and
 * everything else under /api/0 are proxied straight to GlitchTip by Caddy and
 * never reach this process, so "no requests here" does not mean "idle" — it
 * frequently means "reading an issue". Activity is therefore reported by the
 * browser, which is the only party that knows.
 *
 * And that report arrives before anyone has established what it refers to.
 * The endpoint behind it reads a cookie; a cookie is whatever the sender
 * says it is. So the map below has one rule that everything else follows
 * from: **a report can refresh an entry, and can never create one.** Entries
 * are created only when a session has been resolved against GlitchTip and
 * found to be real. A stranger's invented session id touches nothing,
 * occupies nothing, and evicts nothing.
 *
 * The signal is trustworthy only as far as the browser is: a script could
 * keep its own session alive indefinitely, and so could a person wiggling a
 * mouse. This protects an unattended machine, not against the account's
 * owner, and it is worth being clear which of those it is.
 */

const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 0);
export const idleEnabled = Number.isFinite(IDLE_MINUTES) && IDLE_MINUTES > 0;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

/**
 * How long a session could possibly live, whatever it does. Past this,
 * GlitchTip refuses it on its own, so a record of it can no longer change
 * any answer and is safe to drop. Matches SESSION_COOKIE_AGE, in seconds.
 */
const ABSOLUTE_MS = Number(process.env.SESSION_COOKIE_AGE || 604800) * 1000;

/** sessionId -> epoch ms of the last sign of life. */
const lastSeen = new Map();

/**
 * A session that has been resolved against GlitchTip and found to be real.
 *
 * The only way into the map. Everything else may update what is already
 * there and nothing else may add to it, which is what stops an endpoint that
 * reads an unverified cookie from being a way to fill it.
 */
export function begin(sessionId) {
  if (!idleEnabled || !sessionId) return;
  if (!lastSeen.has(sessionId)) lastSeen.set(sessionId, Date.now());
}

/**
 * Somebody is still there.
 *
 * Two refusals, and each closes a way of talking this out of firing.
 *
 * It will not create an entry, so an invented session id does nothing at
 * all — no timeout to reset, no room taken in the map.
 *
 * And it will not revive a session already past the window. Coming back to a
 * tab is activity, the browser reports it, and taking that report at face
 * value means the report itself rescues the session that had gone stale:
 * leave a tab open overnight, glance at it in the morning, and the window
 * has never once elapsed. Past it is a one-way door — only the next look at
 * the session can open it, by ending it.
 */
export function touch(sessionId) {
  if (!idleEnabled || !sessionId) return;

  const seen = lastSeen.get(sessionId);
  if (seen === undefined) return;
  if (Date.now() - seen > IDLE_MS) return;

  lastSeen.set(sessionId, Date.now());
  sweep();
}

/**
 * Whether this session has been left alone for too long.
 *
 * A session we have never seen before is not idle — it has just arrived,
 * from a browser signed in before this process started, or before idling was
 * switched on. Treating "unknown" as "expired" would sign everybody out on
 * every deploy.
 */
export function isIdle(sessionId) {
  if (!idleEnabled || !sessionId) return false;
  const seen = lastSeen.get(sessionId);
  if (seen === undefined) {
    begin(sessionId);
    return false;
  }
  return Date.now() - seen > IDLE_MS;
}

/**
 * After the session has actually been destroyed — and only then.
 *
 * An unknown session is treated as newly arrived rather than idle, so
 * forgetting one that is still alive at GlitchTip hands it a fresh window
 * and undoes the very thing that was being attempted.
 */
export function forgetIdle(sessionId) {
  lastSeen.delete(sessionId);
}

/**
 * Housekeeping, and the one thing it must not do.
 *
 * An entry past the idle window is not junk: it is the record that keeps
 * that session refused, and dropping it says "newly arrived" about a session
 * that was anything but. An earlier version swept exactly those, on the
 * reasoning that a long-idle entry says nothing the absence of an entry
 * doesn't — true when it was written, false the moment absence came to mean
 * something. That made the sweep a way to resurrect any session by filling
 * the map until it ran.
 *
 * So the only records dropped are ones older than a session can possibly
 * live. By then GlitchTip refuses the session itself, and the entry cannot
 * change any answer.
 */
function sweep() {
  if (lastSeen.size <= 1000) return;
  const cutoff = Date.now() - ABSOLUTE_MS;
  for (const [key, seen] of lastSeen) {
    if (seen < cutoff) lastSeen.delete(key);
  }
}

export function idleWindowMs() {
  return idleEnabled ? IDLE_MS : 0;
}

/** For tests: how many sessions are being tracked. */
export function trackedCount() {
  return lastSeen.size;
}
