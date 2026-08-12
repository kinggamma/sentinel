# Running & testing this locally

Covers: starting the pipeline on your Mac, wiring in a local Vite/React
app (e-library_admin), and wiring in a local Dockerized Moodle.

## 1. Start the pipeline

```bash
cd ~/Github/error-monitoring-pipeline
cp .env.example .env
```

Edit `.env` and set real values for `POSTGRES_PASSWORD`,
`GLITCHTIP_SECRET_KEY`, and `STAFF_API_TOKEN` (any long random strings —
e.g. `openssl rand -hex 32`). Leave `GLITCHTIP_DOMAIN=http://localhost:8000`
as-is for local use. Set `ALLOWED_ORIGINS` to every local dev server
you'll be testing from, comma-separated, e.g.:

```
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
```

Then:

```bash
docker compose up -d
docker compose ps        # everything should show "healthy" / "running"
```

Visit `http://localhost:8000`, create your org + admin account. Then
create one GlitchTip **project per app you're testing** (e.g.
`e-library-admin`, `moodle-lms`) — each gives you a DSN that looks like
`http://<key>@localhost:8000/<project-id>`.

Sanity check the receiver directly:

```bash
curl -i http://localhost:4000/health
curl -i -X POST http://localhost:4000/api/reports \
  -H "Authorization: Bearer <STAFF_API_TOKEN>" \
  -F "appName=smoke-test" -F "note=hello" -F "source=staff-report"
```

The second call should return `201` with an `id`. Check
`docker compose logs feedback-receiver` if not, and confirm your Slack
webhook fired if you set `NOTIFY_WEBHOOK_URL`.

## 2. Wire up a local Vite/React app (e-library_admin)

This app is a SPA (no server-rendered page), and it's an admin-only
panel, so unlike the general staff-gating pattern in the main README,
gating here is just "user is logged in" rather than a server-injected
config. **Caveat:** because Vite env vars ship in the client bundle,
`STAFF_API_TOKEN` will be visible to anyone who opens devtools on this
app. That's an acceptable tradeoff for local testing / an already
staff-only admin panel, but don't reuse this pattern for a
public-facing app — use the server-injected `window.__INCIDENT_CAPTURE_CONFIG__`
pattern from the main README instead.

```bash
cd ~/Github/e-library/e-library_admin
npm install @sentry/browser html2canvas
mkdir -p src/incident-capture
cp ~/Github/error-monitoring-pipeline/sdk/incident-capture.js src/incident-capture/
cp ~/Github/error-monitoring-pipeline/sdk/report-widget.js src/incident-capture/
```

`.env.local` (Vite picks this up automatically, and it's gitignored by
default in Vite projects — double check):

```
VITE_GLITCHTIP_DSN=http://<key>@localhost:8000/<project-id>
VITE_FEEDBACK_RECEIVER_URL=http://localhost:4000/api
VITE_STAFF_API_TOKEN=<same STAFF_API_TOKEN as the pipeline .env>
```

`src/incident-capture/setup.ts`:

```ts
import { initIncidentCapture } from "./incident-capture.js";
import { mountReportWidget } from "./report-widget.js";

export function setupIncidentCapture(userEmail?: string) {
  if (!userEmail) return; // only run for logged-in (i.e. staff) users

  const { excluded } = initIncidentCapture({
    dsn: import.meta.env.VITE_GLITCHTIP_DSN,
    receiverUrl: import.meta.env.VITE_FEEDBACK_RECEIVER_URL,
    staffToken: import.meta.env.VITE_STAFF_API_TOKEN,
    appName: "e-library-admin",
    environment: "development",
    userEmail,
    excludedPaths: [], // add any PII-bearing routes this app has
  });

  if (!excluded) mountReportWidget();
}
```

Call `setupIncidentCapture(currentUser.email)` once, after your auth
state resolves (wherever `e-library_admin` knows who's logged in —
likely in `App.tsx` or wherever the current user is loaded).

Test it: `npm run dev`, log in, throw a `throw new Error("test")`
somewhere temporarily (or open the browser console and run one), and
confirm it shows up in GlitchTip's `e-library-admin` project with
breadcrumbs and a linked screenshot in
`GET http://localhost:4000/api/reports`. Click the red "Report Issue"
button in the corner and confirm that also lands.

## 3. Wire up local Dockerized Moodle

Two different network paths matter here, since Moodle runs in its own
container:

- **Client-side JS** (breadcrumbs, screenshot buffer, report widget)
  runs in the browser on your Mac, so it reaches the pipeline the same
  way any local app does: `http://localhost:8000` / `http://localhost:4000`.
- **Server-side PHP** (fatal errors via the Sentry PHP SDK) runs
  *inside* the Moodle container, where `localhost` means the container
  itself, not your Mac. Use `http://host.docker.internal:8000` instead
  — Docker Desktop on Mac resolves that to the host automatically.

Steps:

1. In your Moodle container/image, add the Sentry PHP SDK. If Moodle's
   image already uses Composer, `docker exec` in and run
   `composer require sentry/sentry`; otherwise vendor it in via your
   Dockerfile and rebuild.
2. Add `GLITCHTIP_DSN_MOODLE=http://<key>@host.docker.internal:8000/<project-id>`
   as an environment variable on the Moodle service in whatever
   `docker-compose.yml` runs it.
3. Copy `moodle/config-snippet.php` from this repo into your Moodle
   install's `config.php` (adjust the `vendor/autoload.php` path to
   wherever Composer put it in that container).
4. Copy `moodle/moove-theme-injection.php`,
   `moodle/incident-capture-init.js`, and this repo's
   `sdk/incident-capture.js` + `sdk/report-widget.js` into your Moove
   child theme (`theme/yourchildtheme/`). In
   `moove-theme-injection.php`, set the theme config values
   (`glitchtip_dsn_js`, `feedback_receiver_url`, `feedback_staff_token`)
   to `http://localhost:8000/...`, `http://localhost:4000/api`, and
   your `STAFF_API_TOKEN` respectively — these render into the page for
   the browser, so they use `localhost`, not `host.docker.internal`.
5. Restart Moodle's container (or purge caches:
   *Site administration > Development > Purge caches*), log in as an
   admin/grader, and confirm the "Report Issue" widget appears — and
   does **not** appear on a gradebook or profile page.
6. Trigger a PHP fatal (temporarily) to confirm it lands in the
   `moodle-lms` GlitchTip project, and a client-side JS error to
   confirm breadcrumbs + screenshot show up too.

If you want commands tailored exactly to your Moodle compose file
(image, volume mounts, existing Composer setup), share that
`docker-compose.yml` and I'll write the precise steps instead of the
generic ones above.
