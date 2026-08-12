# error-monitoring-pipeline

Self-hosted error tracking + bug reporting pipeline. Every internal app
(Moodle LMS, MERN apps, NestJS services, Python/PHP services) reports
errors and staff feedback here — one dashboard, no SaaS, no third-party
data sharing.

See `docs/ARCHITECTURE.md`-equivalent context (or the original design doc)
for the full rationale. This repo is Phase 1 + Phase 2 of the roadmap:
the infra foundation and a reference JS integration.

## What's in here

```
docker-compose.yml       GlitchTip + Postgres + Redis + feedback receiver + Caddy
caddy/Caddyfile          Reverse proxy / TLS for errors.<domain> and feedback.<domain>
receiver/                Feedback/incident receiver service (Node/Express)
sdk/                     Shared client-side module (incident-capture.js, report-widget.js)
                          + example-integration.js (Phase 2 reference wiring)
moodle/                  Phase 3: PHP SDK snippet + Moove theme JS injection
docs/ISSUES.md           GitHub milestones/labels/issues to create for this project
docs/PRIVACY-CHECKLIST.md  Phase 5 verification checklist
.env.example              All required environment variables
```

## Setup (Phase 1 — Foundation)

1. Point DNS `errors.<domain>` and `feedback.<domain>` at the VPS.
2. `cp .env.example .env` and fill in real values (passwords, secret key,
   webhook URL, allowed origins).
3. Edit `caddy/Caddyfile` and replace `<domain>` with your real domain.
4. `docker compose up -d`
5. Visit `https://errors.<domain>`, create the first GlitchTip org/admin
   account, then create one GlitchTip **project per app** (moodle-lms,
   app1, app2, ...). Each project gives you a DSN to put in that app's
   config.
6. Generate a long random `STAFF_API_TOKEN` (already in `.env`) and give
   it to each app's server-side config — this is the token the SDK sends
   to the feedback receiver. Treat it like a secret; it is not meant to
   be public.

## Setup (Phase 2 — first JS app integration)

1. `npm install @sentry/browser html2canvas` in that app.
2. Copy `sdk/incident-capture.js` and `sdk/report-widget.js` into the
   app (or publish them as a small internal npm package once you're
   integrating more than one app — see Phase 4).
3. Server-side, when rendering the page for a **staff/admin session
   only**, inject:
   ```html
   <script>
     window.__INCIDENT_CAPTURE_CONFIG__ = {
       dsn: "https://<key>@errors.<domain>/<project-id>",
       receiverUrl: "https://feedback.<domain>/api",
       staffToken: "<STAFF_API_TOKEN>",
       userEmail: currentUser.email,
     };
   </script>
   ```
   For everyone else, don't render that script at all — that's the real
   access control. `sdk/example-integration.js` shows the client wiring
   that reads this config.
4. Confirm: trigger a test error, see it in GlitchTip with breadcrumbs
   and a linked screenshot bundle in `receiver_data` / via
   `GET /api/reports`. Click "Report Issue" and confirm a Slack
   notification fires.

## Setup (Phase 3 — Moodle)

See `moodle/config-snippet.php` (server-side PHP fatals via Sentry PHP
SDK) and `moodle/moove-theme-injection.php` +
`moodle/incident-capture-init.js` (client-side, staff-gated via Moodle
capability checks, with gradebook/profile pages excluded).

## Privacy

- Nothing is captured on gradebook or profile pages — enforced twice:
  once server-side (don't even render the config/script), once
  client-side (`excludedPaths` check in `incident-capture.js`).
- Every event and breadcrumb is scrubbed for emails/phone
  numbers/card-like sequences before it leaves the browser or server —
  see `deepScrub()` in `sdk/incident-capture.js` and
  `moodle_incident_capture_scrub()` in the PHP snippet.
- Screenshots are small (0.5x scale, JPEG q=0.5), rolling (last ~8s),
  and only ever uploaded when an error fires or a staff member
  explicitly clicks "Report Issue" — never streamed continuously.
- Before calling any phase "done," run through
  `docs/PRIVACY-CHECKLIST.md` on that app.

## Roadmap

1. Foundation (this repo, Phase 1) — done once `docker compose up -d`
   is running and reachable.
2. First integration (this repo, Phase 2) — one JS app wired end to end.
3. Moodle integration (this repo, Phase 3 assets, needs to be installed
   into your Moove child theme).
4. Remaining apps — repeat the Phase 2 pattern.
5. Privacy hardening pass — `docs/PRIVACY-CHECKLIST.md` on every app.
6. (Optional, later) full session replay via OpenReplay, only if needed.

See `docs/ISSUES.md` for this broken into GitHub issues/milestones/labels.
