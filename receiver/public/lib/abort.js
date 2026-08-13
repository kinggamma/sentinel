/**
 * One place to check "did the router move on without me."
 *
 * Every view is async because every view fetches, and the router aborts a
 * view's signal the moment a newer navigation supersedes it — but a fetch
 * finishing mid-flight only cancels the network call. Anything after that
 * `await` (a second fetch, building DOM from what came back) still runs
 * unless something checks. Call this after every await in a view; it throws
 * the same AbortError a cancelled fetch throws, so the router's existing
 * "an aborted view isn't a failure" handling covers it for free.
 */
export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}
