import { Router } from "express";
import {
  integrationStatus,
  setIntegration,
  fixedOrigins,
  forgetApp,
  listGlobalOrigins,
  normaliseOrigin,
  registeredApps,
  setAppOrigins,
  setGlobalOrigins,
} from "../settings.js";

export const settingsRouter = Router();

/**
 * Where each app runs, which is what decides whether its browser code may
 * post reports.
 *
 * Anyone who can read reports can change this. That's deliberate: the list
 * can't be used to read anything — cross-origin requests here carry no
 * credentials, so naming an origin doesn't let it see reports — and the
 * alternative was editing a file on the server and restarting a container
 * every time an app moved.
 */
/** The global list, applying to every app. */
settingsRouter.get("/settings/origins", (_req, res) => {
  res.json({ origins: listGlobalOrigins(), fixed: fixedOrigins() });
});

settingsRouter.put("/settings/origins", async (req, res) => {
  const submitted = req.body?.origins;
  if (!Array.isArray(submitted)) {
    return res.status(400).json({ error: "origins must be an array" });
  }
  const bad = submitted.filter((value) => !normaliseOrigin(value));
  if (bad.length) {
    return res.status(400).json({
      error: `Not a valid address: ${bad[0]}. Use a scheme and host, like http://example.org:5173`,
    });
  }
  const origins = await setGlobalOrigins(submitted);
  console.log(`allowed origins updated: ${origins.join(", ") || "(none)"}`);
  res.json({ origins, fixed: fixedOrigins() });
});

/** Per-app: where one app is allowed to report from. */
settingsRouter.get("/settings/apps", (_req, res) => {
  res.json({ apps: registeredApps(), fixed: fixedOrigins() });
});

settingsRouter.put("/settings/apps/:appName", async (req, res) => {
  const submitted = req.body?.origins;
  if (!Array.isArray(submitted)) {
    return res.status(400).json({ error: "origins must be an array" });
  }

  // Reject the whole list rather than silently dropping entries: a typo that
  // disappears looks like it was accepted.
  const bad = submitted.filter((value) => !normaliseOrigin(value));
  if (bad.length) {
    return res.status(400).json({
      error: `Not a valid address: ${bad[0]}. Use a scheme and host, like http://example.org:5173`,
    });
  }

  try {
    const apps = await setAppOrigins(req.params.appName, submitted);
    console.log(
      `${req.params.appName} may now report from: ${submitted.join(", ") || "(nowhere)"}`
    );
    res.json({ apps, fixed: fixedOrigins() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

settingsRouter.delete("/settings/apps/:appName", async (req, res) => {
  const apps = await forgetApp(req.params.appName);
  res.json({ apps, fixed: fixedOrigins() });
});


/**
 * The GlitchTip service credential. Set here or in the environment; the
 * environment wins, and either way the token itself is never sent back —
 * the viewer only learns whether one exists.
 */
settingsRouter.get("/settings/integration", (_req, res) => {
  res.json(integrationStatus());
});

settingsRouter.put("/settings/integration", async (req, res) => {
  const status = integrationStatus();
  if (req.body?.serviceToken !== undefined && status.tokenFromEnv) {
    return res.status(409).json({
      error: "The service token is set in this deployment's environment, so it can't be changed here.",
    });
  }
  if (req.body?.team !== undefined && status.teamFromEnv) {
    return res.status(409).json({
      error: "The team is set in this deployment's environment, so it can't be changed here.",
    });
  }

  const updated = await setIntegration({
    serviceToken: req.body?.serviceToken,
    team: req.body?.team,
  });
  console.log(`glitchtip service credential ${updated.hasToken ? "set" : "cleared"}`);
  res.json(updated);
});
