/**
 * Where a sign-in returns you to.
 *
 * A guard turns somebody away from the screen they asked for and carries the
 * address along so they arrive back at it. That address comes from the URL,
 * which means it comes from whoever wrote the link — and "sign in, then get
 * sent wherever this says" is the shape of a phishing primitive. The
 * attacker's version points at a copy of this sign-in screen on a host that
 * looks close enough.
 *
 * So only a path inside this app is honoured, and everything else quietly
 * becomes the home screen. It lives here, apart from the view that uses it,
 * because it is a security control and belongs somewhere a test can reach
 * without a browser.
 */
export function safeNext(query) {
  const next = query?.next;
  if (typeof next !== "string") return "/";

  // Must be a path. A scheme ("https://", "javascript:") is not one, and
  // neither is a protocol-relative "//host" — which a browser reads as
  // another origin despite starting with a slash, and which is the form
  // most often missed.
  if (!next.startsWith("/") || next.startsWith("//")) return "/";

  // A backslash is treated as a slash by some browsers when resolving, so
  // "/\evil.example" can escape the same way "//" does.
  if (next.startsWith("/\\")) return "/";

  return next;
}
