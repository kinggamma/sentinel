/**
 * example-integration.js
 * -----------------------------------------------------------------------
 * Reference wiring for Roadmap Phase 2 ("First integration" — pick one
 * MERN/NestJS app and wire it end to end). Copy this pattern into that
 * app's entrypoint (e.g. src/index.jsx for a React app).
 *
 * Server side, when rendering the page shell, only inject the config
 * object below (dsn/receiverUrl/staffToken/userEmail) for sessions you've
 * already confirmed are staff/admin. Everyone else gets no incident
 * capture at all — this file being loaded is not, by itself, an access
 * control decision.
 * -----------------------------------------------------------------------
 */

import { initIncidentCapture } from "./incident-capture.js";
import { mountReportWidget } from "./report-widget.js";

// In a real app this comes from a server-rendered <script> tag, e.g.:
//   window.__INCIDENT_CAPTURE_CONFIG__ = { ...server injects this... }
const cfg = window.__INCIDENT_CAPTURE_CONFIG__;

if (cfg) {
  const { excluded } = initIncidentCapture({
    dsn: cfg.dsn, // https://<key>@errors.<domain>/<project-id>
    receiverUrl: cfg.receiverUrl, // https://feedback.<domain>/api
    staffToken: cfg.staffToken,
    appName: "example-js-app",
    environment: cfg.environment || "production",
    release: cfg.release,
    userEmail: cfg.userEmail,
    excludedPaths: [
      /\/billing\b/i,
      /\/account\/profile\b/i,
    ],
  });

  if (!excluded) {
    mountReportWidget();
  }
}
