/**
 * Telling the receiver somebody is still here.
 *
 * An idle timeout needs to know about activity, and the receiver can only see
 * a fraction of it: issues, projects and everything else under /api/0 go
 * straight to GlitchTip and never reach it. Measuring idleness from what
 * arrives there would sign out a person in the middle of reading an issue,
 * which is the exact opposite of the intent.
 *
 * So the browser says so. Real input only — a pointer moving, a key, a
 * scroll, a touch — and at most once a minute, because the point is to
 * distinguish "somebody is at this machine" from "a tab is open on it".
 *
 * A background tab is silent on purpose. Leaving Sentinel open in a window
 * you are not looking at is precisely the case an idle timeout exists for,
 * and a heartbeat that fired anyway would defeat the whole feature while
 * appearing to work.
 */
import { sentinel } from "./api.js";

const EVENTS = ["pointerdown", "keydown", "scroll", "touchstart", "pointermove"];

let stop = null;

/**
 * @param {object} [options]
 * @param {number} [options.everyMs] - the floor between two reports. One
 *   minute is comfortably below any idle window worth setting, and means a
 *   busy screen costs one tiny request a minute rather than one per event.
 */
export function reportPresence({ everyMs = 60_000 } = {}) {
  stopReportingPresence();

  let last = 0;
  let pending = false;

  const send = () => {
    if (pending) return;
    pending = true;
    // Nothing waits on this and nothing reads the answer; a failure means the
    // next movement tries again a minute later.
    sentinel
      .post("/auth/touch", null)
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  };

  const onActivity = () => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - last < everyMs) return;
    last = now;
    send();
  };

  // Coming back to the tab is itself a sign of life, and the most likely
  // moment for somebody to have been away longer than the window.
  const onVisible = () => {
    if (document.visibilityState === "visible") onActivity();
  };

  for (const event of EVENTS) {
    document.addEventListener(event, onActivity, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", onVisible);

  // Once at the start, so a session that has just signed in is not judged on
  // whatever came before it.
  send();
  last = Date.now();

  stop = () => {
    for (const event of EVENTS) {
      document.removeEventListener(event, onActivity, { capture: true });
    }
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function stopReportingPresence() {
  if (stop) stop();
  stop = null;
}
