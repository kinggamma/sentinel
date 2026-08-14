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

/**
 * A path segment that means "go up" rather than naming anything.
 *
 * Decoded before it is judged, because a browser decodes before it resolves:
 * "%2e%2e", "%2E%2E" and ".%2e" are all "..", and all of them turn
 * "/sentinel/<this>/admin" into "/admin". Matching the literal spellings
 * catches the obvious two and misses the mixed one.
 */
function climbs(pathname) {
  return pathname.split("/").some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed encoding is not something to resolve; judge it as written.
    }
    return decoded === ".." || decoded === ".";
  });
}

export function safeNext(query) {
  const next = query?.next;
  if (typeof next !== "string" || !next) return "/";

  // Must be a path. A scheme ("https://", "javascript:") is not one, and
  // neither is a protocol-relative "//host" — which a browser reads as
  // another origin despite starting with a slash, and which is the form most
  // often missed.
  if (!next.startsWith("/") || next.startsWith("//")) return "/";

  /**
   * Only the path is inspected from here on. A query value may legitimately
   * contain both of the things rejected below, because people type them into
   * a search box.
   */
  const [pathname] = next.split(/[?#]/);

  /**
   * No backslash anywhere in it.
   *
   * A browser treats "\" as "/" when it resolves, and checking only the
   * first character misses every one after it. "/a\..\..\admin" passes a
   * leading-character check, then splits on "/" into a single segment that
   * is not "..", and then resolves to "/admin" regardless — the separator
   * the check was looking for was spelled the other way.
   *
   * Rejecting the character outright is the only version of this that does
   * not depend on my having guessed where it would turn up.
   */
  if (pathname.includes("\\")) return "/";

  /**
   * And it must not climb out.
   *
   * This is the one that looks harmless. "/../admin" starts with a slash,
   * names no host and carries no scheme — and every check above lets it
   * through. What happens next is that the router prepends the mount, and
   * the browser resolves "/sentinel/../admin" to "/admin": GlitchTip's
   * Django admin, outside this app altogether. A crafted sign-in link would
   * have deposited somebody on an unrelated login form the moment they
   * signed in, with the URL looking like it had come from us.
   */
  if (climbs(pathname)) return "/";

  return next;
}
