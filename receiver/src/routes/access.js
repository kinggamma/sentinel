import { Router } from "express";
import { STATES } from "../auth/state.js";
import {
  clearRequest,
  decide,
  findById,
  listRequests,
  myRequest,
  requestAccess,
} from "../access-requests.js";
import { inviteToOrg } from "../glitchtip.js";

export const accessRouter = Router();

/**
 * Who may see and decide these.
 *
 * The queue holds the email address and words of somebody asking to be let
 * in, and acting on it invites them with Sentinel's service token — a
 * credential far more privileged than any person's. Membership was the only
 * guard, so any member could read all of it and let anybody in. It asks for
 * manager now, the same role GlitchTip asks for its own invitations.
 *
 * A viewer authenticated by the staff token is not a person and holds no
 * role, so it is refused here too: it has no organisation to vouch for and
 * nothing to attribute a decision to.
 */
function mayDecide(req, res, next) {
  const roles = req.viewer?.orgRoles || {};
  const anywhere = Object.values(roles).some((one) => one?.canManageMembers);
  if (!anywhere) {
    return res.status(403).json({
      error: "deciding who gets in needs the manager role",
      needsRole: true,
    });
  }
  return next();
}

/** Manager in this particular organisation, not merely somewhere. */
function mayDecideFor(req, org) {
  return Boolean(req.viewer?.orgRoles?.[org]?.canManageMembers);
}

/**
 * Where the person asking stands. Answers for members too — they have no
 * request, which is how the viewer knows not to offer one.
 */
accessRouter.get("/me", async (req, res) => {
  const viewer = req.viewer || {};
  if (!viewer.email) return res.json({ pending: false, request: null, organisations: [] });

  // "Pending" is a state now rather than a boolean on a frozen cookie, which
  // is why somebody approved into an organisation used to keep being told
  // they belonged to none: the cookie still said so until it expired.
  const waiting = viewer.state === STATES.PENDING || viewer.state === STATES.DENIED;

  // Someone who has since been let in doesn't need their request any more.
  if (!waiting) {
    await clearRequest(viewer.email);
    return res.json({ pending: false, request: null, organisations: viewer.orgs || [] });
  }

  res.json({
    pending: true,
    email: viewer.email,
    name: viewer.user?.name || null,
    request: await myRequest(viewer.email),
    organisations: [],
  });
});

accessRouter.post("/request", async (req, res) => {
  const viewer = req.viewer || {};
  if (!viewer.email) {
    return res.status(400).json({ error: "we don't know who you are — sign in to GlitchTip first" });
  }
  if (viewer.state !== STATES.PENDING && viewer.state !== STATES.DENIED) {
    return res.status(400).json({ error: "you already have access" });
  }

  try {
    const request = await requestAccess({
      email: viewer.email,
      name: viewer.user?.name || null,
      note: req.body?.note,
    });
    console.log(`access requested by ${viewer.email}`);
    res.status(201).json({ request });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * The queue, and deciding on it. Only members get this far — the guard on
 * this router refuses a pending session — and approving needs somewhere to
 * put them, which is one of the approver's own organisations.
 */
accessRouter.get("/requests", mayDecide, async (req, res) => {
  if (req.viewer?.pending) return res.status(403).json({ error: "awaiting access" });
  res.json({
    requests: await listRequests(),
    // What the approver may add someone to: their own organisations, never
    // one they don't belong to.
    organisations: req.viewer?.orgs || [],
  });
});

accessRouter.post("/requests/:id/approve", mayDecide, async (req, res) => {
  if (req.viewer?.pending) return res.status(403).json({ error: "awaiting access" });

  const org = String(req.body?.organisation || "").trim();
  if (!org) return res.status(400).json({ error: "which organisation?" });

  // Staff-token sessions have no organisations of their own, so they can't
  // vouch for one. A person approving must be a member of where they're
  // sending someone.
  const mine = req.viewer?.orgs;
  if (!Array.isArray(mine) || !mine.includes(org)) {
    return res.status(403).json({ error: `you're not a member of ${org}` });
  }

  // Manager somewhere is not manager here. Approving into an organisation is
  // an act inside that organisation, so the role is checked against it.
  if (!mayDecideFor(req, org)) {
    return res.status(403).json({ error: `you're not a manager of ${org}`, needsRole: true });
  }

  const request = await findById(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });

  try {
    const { inviteLink } = await inviteToOrg({ org, email: request.email });
    const updated = await decide(request.id, {
      status: "approved",
      decidedBy: req.viewer.email || null,
      organization: org,
      inviteLink,
    });
    console.log(`${request.email} approved for ${org} by ${req.viewer.email || "staff token"}`);
    res.json({ request: updated });
  } catch (err) {
    // 409 means GlitchTip already has them as a member or invitee: the
    // outcome we wanted, so record it rather than reporting a failure.
    if (err.status === 409) {
      const updated = await decide(request.id, {
        status: "approved",
        decidedBy: req.viewer.email || null,
        organization: org,
        inviteLink: null,
      });
      return res.json({ request: updated, note: "they were already invited" });
    }
    res.status(err.status === 501 ? 501 : 502).json({ error: err.message });
  }
});

accessRouter.post("/requests/:id/decline", mayDecide, async (req, res) => {
  if (req.viewer?.pending) return res.status(403).json({ error: "awaiting access" });

  const request = await findById(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });

  const updated = await decide(request.id, {
    status: "declined",
    decidedBy: req.viewer?.email || null,
  });
  res.json({ request: updated });
});
