/**
 * What this browser's session is, asked once and shared.
 *
 * Every guard and every auth screen needs the same answer, and each fetching
 * it for itself would mean four requests per navigation and four chances to
 * disagree about what is on screen. This holds one answer until something
 * happens that could change it.
 *
 * The server decides; nothing here re-derives. `can` arrives already worked
 * out (src/auth/state.js), so a screen asks "may I" rather than assembling a
 * verdict from a state name and a list of organisations — which is how two
 * screens end up disagreeing about the same person.
 */
import { sentinel } from "./api.js";

let inFlight = null;
let cached = null;

/**
 * The state, from cache if it was already asked for.
 *
 * Concurrent callers share the one request: a guard and the view behind it
 * both want this in the same tick, and two identical requests would be
 * answered by two round trips for the same fact.
 */
export function session({ fresh = false } = {}) {
  if (fresh) forget();
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  inFlight = sentinel
    /**
     * Never signals unauthorized: this *is* the question of whether anyone is
     * signed in, and answering it by triggering the signed-out handler would
     * be a loop.
     *
     * `fresh` reaches the receiver too. Forgetting only this side leaves the
     * receiver's own few seconds of cached identity to answer, which is how
     * somebody who has just accepted an invitation is told for the next ten
     * seconds that they belong to nothing.
     */
    .get(fresh ? "/auth/me?fresh=1" : "/auth/me", { signalUnauthorized: false })
    .then((body) => {
      cached = body;
      return body;
    })
    .catch(() => ({
      // Unreachable is not anonymous, and must not silently become it: a
      // screen that reads this as "signed out" would throw someone to the
      // sign-in form because a request timed out.
      state: "unreachable",
      email: null,
      orgs: [],
      can: {},
    }))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** After anything that changes who this browser is. */
export function forget() {
  cached = null;
  inFlight = null;
}
