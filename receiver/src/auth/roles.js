/**
 * What an organisation role lets somebody do, as GlitchTip decides it.
 *
 * These are not Sentinel's rules. GlitchTip maps each role to a set of
 * scopes (organizations_ext/constants.py) and every write endpoint declares
 * the scopes it needs, so the answers below are a mirror of that table,
 * checked against the running instance rather than assumed:
 *
 *   member   project:read, event:*, member:read        — reads, nothing else
 *            ...and project:releases, which is not a read: it is the whole
 *            of what the release endpoints ask for, delete included
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

    /**
     * Putting a project in a team, or taking it out.
     *
     * Manager, not admin, and it is worth saying why since the two look
     * identical from outside. GlitchTip declares that endpoint as needing
     * project:admin — which an admin has — and then looks the project up
     * with a query that also requires the caller be manager or above. The
     * decorator and the query disagree, and the query is the one that runs
     * last, so an admin gets a 404 from an endpoint its own scope check
     * would have allowed.
     *
     * Found by pressing the button: as admin the call answered 404, as
     * manager the same call answered 201. Mirroring the decorator would
     * have shipped a control that fails for exactly one role, which is the
     * hardest kind of gap to notice.
     */
    canLinkProjectsToTeams: Boolean(known) && atLeast(known, "manager"),

    /**
     * The organisation's own settings, and how people sign into it.
     *
     * org:write, which is manager and above — the same scope covers renaming
     * the organisation and configuring single sign-on, so they are one
     * answer rather than two that would drift apart. A member cannot even
     * read the social-app list, which is why the whole section is hidden
     * rather than shown empty.
     */
    canManageOrganisation: Boolean(known) && atLeast(known, "manager"),

    /**
     * Releases, including deleting one.
     *
     * Every role, member included. That is not an oversight here: GlitchTip
     * puts project:releases in the member scope set alongside project:read,
     * and the release endpoints ask for nothing else — so an ordinary member
     * may edit and delete any release in the organisation, which is more than
     * they may do to a single project setting.
     *
     * Written out as its own answer rather than folded into canRead, because
     * it is the one place where "can see it" and "can destroy it" are the
     * same scope, and a screen reading canRead for a delete button would be
     * right today by accident.
     */
    canManageReleases: Boolean(known),

    /**
     * Uptime monitors, including creating and deleting them.
     *
     * Every role again, and for a weaker reason than releases: those
     * endpoints at least name a scope. The monitor endpoints declare no
     * permission at all — create, update and delete are gated on being in
     * the organisation and nothing else — so a member can point a monitor
     * anywhere and delete anybody else's.
     *
     * Recorded rather than corrected. Hiding the controls would take away
     * something GlitchTip permits, and the same person could do it from
     * GlitchTip's own screen a click away; what this can do is make the
     * looseness visible in the one file that answers "what may this role
     * do", instead of leaving each screen to assume.
     */
    canManageUptime: Boolean(known),
  });
}
