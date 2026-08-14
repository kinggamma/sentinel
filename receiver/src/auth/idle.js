/**
 * Signing out a session nobody is using.
 *
 * GlitchTip's sessions are absolute: fourteen days from the moment you sign
 * in, whether you used it constantly or walked away from an unlocked laptop
 * in the first minute. Django can slide that window on activity — that is
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
 * browser, which is the only party that knows, through a small endpoint whose
 * whole job is to say "still here".
 *
 * That makes the signal trustworthy only as far as the browser is: a script
 * could keep its own session alive indefinitely. So could a person wiggling a
 * mouse. This protects an unattended machine, not against the account's
 * owner, and it is worth being clear which of those it is.
 *
 * Last-seen lives in memory. A restart forgets it and every session gets a
 * fresh window, which is the forgiving direction — the absolute cap is what
 * actually bounds a session's life, and that one GlitchTip enforces itself.
 */

const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 0);
export const idleEnabled = Number.isFinite(IDLE_MINUTES) && IDLE_MINUTES > 0;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

/** sessionId -> epoch ms of the last sign of life. */
const lastSeen = new Map();

/**
 * Somebody is still there.
 *
 * Refuses to revive a session that has already been left too long, and that
 * refusal is the whole difference between a working timeout and a decorative
 * one. Coming back to a tab is activity, the browser reports it, and taking
 * that report at face value means the report itself rescues the session that
 * had already gone stale — leave a tab open overnight, glance at it in the
 * morning, and the window has never once elapsed.
 *
 * Past the window is a one-way door. Only the next look at the session can
 * open it, by ending it.
 */
export function touch(sessionId) {
  if (!idleEnabled || !sessionId) return;

  const seen = lastSeen.get(sessionId);
  if (seen !== undefined && Date.now() - seen > IDLE_MS) return;

  lastSeen.set(sessionId, Date.now());

  // Bounded without a timer: sessions that went idle long ago cannot become
  // un-idle, so their entries say nothing that the absence of an entry
  // doesn't.
  if (lastSeen.size > 1000) {
    const cutoff = Date.now() - IDLE_MS;
    for (const [key, seen] of lastSeen) {
      if (seen < cutoff) lastSeen.delete(key);
    }
  }
}

/**
 * Whether this session has been left alone for too long.
 *
 * A session we have never seen before is not idle — it has just arrived, from
 * a browser that was signed in before this process started, or before idling
 * was switched on. Treating "unknown" as "expired" would sign everybody out
 * on every deploy.
 */
export function isIdle(sessionId) {
  if (!idleEnabled || !sessionId) return false;
  const seen = lastSeen.get(sessionId);
  if (seen === undefined) {
    touch(sessionId);
    return false;
  }
  return Date.now() - seen > IDLE_MS;
}

/**
 * After it has been dealt with — and only then.
 *
 * An unknown session is treated as newly arrived rather than idle, so
 * forgetting one that is still alive at GlitchTip hands it a fresh window
 * and undoes the very thing that was being attempted. This is called when
 * the session has actually been destroyed, never merely when we tried.
 */
export function forgetIdle(sessionId) {
  lastSeen.delete(sessionId);
}

export function idleWindowMs() {
  return idleEnabled ? IDLE_MS : 0;
}
