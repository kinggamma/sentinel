/**
 * Which organisation you are looking at.
 *
 * Sentinel used to answer this with `orgs[0]` and nothing else, which is
 * correct exactly when somebody belongs to one organisation. For anyone in
 * two it was wrong in a way that hid data rather than announcing itself: the
 * issue list quietly showed one organisation's errors, the sidebar named
 * that organisation as though it were the only one, and the other's issues
 * had no address at all.
 *
 * So it is a choice now, and the choice lives in three places in order of
 * authority:
 *
 *   1. the URL, because a link to an issue list should open the same list
 *      for whoever follows it;
 *   2. what this browser last chose, so switching survives a reload;
 *   3. the first organisation, for somebody who has never chosen.
 *
 * Every one of those is checked against the organisations the server says
 * this account belongs to. A slug in a URL is a request, not a fact.
 */

const REMEMBERED = "sentinel-org";

export function remembered() {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    // Storage disabled; the URL and the first organisation still work.
    return null;
  }
}

export function remember(slug) {
  try {
    if (slug) localStorage.setItem(REMEMBERED, slug);
  } catch {
    // Nothing to do: the choice lasts as long as the address does.
  }
}

/**
 * @param {object} options
 * @param {string[]} options.orgs - what the account actually belongs to.
 * @param {object} [options.query] - the current route's query.
 * @returns {string|null}
 */
export function activeOrg({ orgs = [], query = {} } = {}) {
  if (!orgs.length) return null;

  const asked = query.org;
  if (asked && orgs.includes(asked)) return asked;

  const last = remembered();
  if (last && orgs.includes(last)) return last;

  return orgs[0];
}

/**
 * The same address, pointed at a different organisation.
 *
 * Only ever written when there is a choice to express: on the common
 * single-organisation install every link stays as short as it was.
 */
export function withOrg(path, slug, { orgs = [] } = {}) {
  if (!slug || orgs.length < 2) return path;
  const [base, hash = ""] = path.split("#");
  const [route, existing = ""] = base.split("?");
  const params = new URLSearchParams(existing);
  params.set("org", slug);
  return `${route}?${params}${hash ? `#${hash}` : ""}`;
}
