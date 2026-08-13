/**
 * GlitchTip paginates with a Link header rather than page numbers, so the
 * only way forward or back is to keep the URLs it hands out.
 */
export function parseLinks(header) {
  const links = { previous: null, next: null };
  if (!header) return links;

  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"(?:;\s*results="([^"]+)")?/);
    if (!match) continue;
    const [, url, rel, results] = match;
    // results="false" means the link exists but leads nowhere; treating it as
    // a page would show an empty list and look like data loss.
    links[rel] = results === "false" ? null : url;
  }
  return links;
}
