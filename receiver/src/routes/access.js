import { Router } from "express";
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
 * Where the person asking stands. Answers for members too — they have no
 * request, which is how the viewer knows not to offer one.
 */
accessRouter.get("/access/me", async (req, res) => {
  const viewer = req.viewer || {};
  if (!viewer.email) return res.json({ pending: false, request: null, organisations: [] });

  // Someone who has since been let in doesn't need their request any more.
  if (!viewer.pending) {
    await clearRequest(viewer.email);
    return res.json({ pending: false, request: null, organisations: viewer.orgs || [] });
  }

  res.json({
    pending: true,
    email: viewer.email,
    name: viewer.name || null,
    request: await myRequest(viewer.email),
    organisations: [],
  });
});

accessRouter.post("/access/request", async (req, res) => {
  const viewer = req.viewer || {};
  if (!viewer.email) {
    return res.status(400).json({ error: "we don't know who you are — sign in to GlitchTip first" });
  }
  if (!viewer.pending) {
    return res.status(400).json({ error: "you already have access" });
  }

  try {
    const request = await requestAccess({
      email: viewer.email,
      name: viewer.name,
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
accessRouter.get("/access/requests", async (req, res) => {
  if (req.viewer?.pending) return res.status(403).json({ error: "awaiting access" });
  res.json({
    requests: await listRequests(),
    // What the approver may add someone to: their own organisations, never
    // one they don't belong to.
    organisations: req.viewer?.orgs || [],
  });
});

accessRouter.post("/access/requests/:id/approve", async (req, res) => {
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

accessRouter.post("/access/requests/:id/decline", async (req, res) => {
  if (req.viewer?.pending) return res.status(403).json({ error: "awaiting access" });

  const request = await findById(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });

  const updated = await decide(request.id, {
    status: "declined",
    decidedBy: req.viewer?.email || null,
  });
  res.json({ request: updated });
});
