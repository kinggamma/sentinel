/**
 * Place at: theme/yourchildtheme/javascript/incident-capture-init.js
 * Loaded (as a module) by moove-theme-injection.php, only for staff/admin
 * sessions on non-excluded pages. Reads window.__INCIDENT_CAPTURE_CONFIG__
 * that the PHP hook already injected.
 *
 * Uses the same shared sdk/incident-capture.js and sdk/report-widget.js
 * from this repo — copy or symlink them alongside this file (or bundle
 * with Moodle's grunt/AMD build if you'd rather ship it that way).
 */
import { initIncidentCapture } from "./incident-capture.js";
import { mountReportWidget } from "./report-widget.js";

const cfg = window.__INCIDENT_CAPTURE_CONFIG__;

if (cfg && cfg.dsn) {
  const { excluded } = initIncidentCapture({
    dsn: cfg.dsn,
    receiverUrl: cfg.receiverUrl,
    staffToken: cfg.staffToken,
    appName: cfg.appName,
    userEmail: cfg.userEmail,
    environment: cfg.environment,
    extraTags: cfg.extraTags,
    excludedPaths: [/\/grade\//i, /\/user\/profile/i, /\/user\/editadvanced/i],
  });

  if (!excluded) {
    mountReportWidget();
  }
}
