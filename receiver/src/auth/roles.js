/**
 * What an organisation role lets somebody do, as GlitchTip decides it.
 *
 * These are not Sentinel's rules. GlitchTip maps each role to a set of
 * scopes (organizations_ext/constants.py) and every write endpoint declares
 * the scopes it needs, so the answers below are a mirror of that table,
 * checked against the running instance rather than assumed:
 *
 *   member   project:read, event:*, member:read        — reads, nothing else
 *   admin    + project:write, project:admin, team:write
 *   manager  + member:write, org:write
 *   owner    everything
 *
 * The mirror exists because the alternative is finding out by pressing the
 * button. A member who is shown "New project" gets a 404 from an endpoint
 * that will not say why — GlitchTip answers a scope failure by pretending
 * the route is not there — and there is no way to turn that into a sentence
 * worth showing anybody. Every create attempted as a member during this
 * work came back exactly that way, including after joining a team, which is
 * how the role turned out to be the thing that mattered.
 *
 * Kept in one place, so a screen never works out for itself what a role
 * means, and so the day this drifts from GlitchTip there is a single file
 * to correct.
 */

/** Ordered by how much each can do, which is what makes comparison possible. */
const RANK = ["member", "admin", "manager", "owner"];

/** Anything unrecognised is treated as the least it could be. */
function rank(role) {
  const at = RANK.indexOf(String(role || "").toLowerCase());
  return at === -1 ? 0 : at;
}

const atLeast = (role, floor) => rank(role) >= rank(floor);

/**
 * @param {string|null} role - as GlitchTip names it on a member record.
 * @returns {{role: string|null, canManageProjects: boolean,
 *   canManageTeams: boolean, canManageMembers: boolean}}
 */
export function abilities(role) {
  const known = RANK.includes(String(role || "").toLowerCase())
    ? String(role).toLowerCase()
    : null;

  return Object.freeze({
    role: known,

    // project:write / project:admin — creating a project, renaming one,
    // adding and revoking its keys, and its alert rules.
    canManageProjects: Boolean(known) && atLeast(known, "admin"),

    // team:write — creating a team, and who is in it.
    canManageTeams: Boolean(known) && atLeast(known, "admin"),

    /**
     * member:write — inviting somebody, changing a role, removing them.
     *
     * Deliberately not what approving an access request needs: that is
     * performed with Sentinel's own service token rather than the
     * approver's credentials, so GlitchTip never checks the approver's role
     * at all. The two look like one question and are not, and canManageAccess
     * stays the answer to the other one.
     */
    canManageMembers: Boolean(known) && atLeast(known, "manager"),
  });
}
