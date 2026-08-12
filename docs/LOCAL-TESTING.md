# Running & testing this locally

Covers starting the pipeline on your own machine, wiring in a local
JavaScript app, and wiring in a local Dockerized Moodle. For the full
per-stack integration guide, see `INTEGRATING.md`.

## 1. Start the pipeline

```bash
cp .env.example .env
```

Edit `.env` and set real values for `POSTGRES_PASSWORD`,
`GLITCHTIP_SECRET_KEY`, and `STAFF_API_TOKEN` (any long random strings —
`openssl rand -hex 32`). Leave `GLITCHTIP_DOMAIN=http://localhost:8000` as-is
for local use. Set `ALLOWED_ORIGINS` to every local dev server you'll test
from, comma-separated:

```
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8080
```

Then:

```bash
docker compose up -d
docker compose ps        # everything should show "healthy" / "running"
```

Visit `http://localhost:8000`, create your org + admin account. Then create
one GlitchTip **project per app you're testing** — each gives you a DSN that
looks like `http://<key>@localhost:8000/<project-id>`.

Sanity check the receiver directly:

```bash
curl -i http://localhost:4000/health
curl -i -X POST http://localhost:4000/api/reports \
  -H "Authorization: Bearer <STAFF_API_TOKEN>" \
  -F "appName=smoke-test" -F "note=hello" -F "source=staff-report"
```

The second call should return `201` with an `id`. Check
`docker compose logs feedback-receiver` if not, and confirm your webhook
fired if you set `NOTIFY_WEBHOOK_URL`.

Then open `http://localhost:4000` — the report viewer. Paste
`STAFF_API_TOKEN` once (kept in that browser's localStorage) and you get the
report list, session replays, and breadcrumb trail per report. That
smoke-test report should be the first row.

Did an event actually reach the pipeline? The proxy logs every request:

```bash
docker compose logs --tail 40 caddy | grep -o '"uri":"[^"]*"'
```

A `/api/<project-id>/envelope/` line means a browser's error got in.

## 2. Wire up a local JavaScript app

Example: a Vite dev server on `:5173`. Because Vite env vars ship in the
client bundle, `STAFF_API_TOKEN` will be visible to anyone who opens devtools
on that app. That's an acceptable tradeoff for local testing or a staff-only
admin panel — don't reuse the pattern for a public-facing app. Use the
server-injected `window.__INCIDENT_CAPTURE_CONFIG__` pattern instead
(`INTEGRATING.md` → *Server-rendered apps*).

```bash
npm install @sentry/browser rrweb
mkdir -p src/incident-capture
cp <pipeline>/sdk/incident-capture.js src/incident-capture/
cp <pipeline>/sdk/report-widget.js src/incident-capture/
```

`.env` (gitignored):

```
VITE_GLITCHTIP_DSN=http://<key>@localhost:8000/<project-id>
VITE_FEEDBACK_RECEIVER_URL=http://localhost:4000/api
VITE_STAFF_API_TOKEN=<same STAFF_API_TOKEN as the pipeline .env>
```

`src/incident-capture/setup.js`:

```js
import { initIncidentCapture } from "./incident-capture.js";
import { mountReportWidget } from "./report-widget.js";

export function setupIncidentCapture(userEmail) {
  if (!userEmail) return; // only run for logged-in (i.e. staff) users

  const { excluded } = initIncidentCapture({
    dsn: import.meta.env.VITE_GLITCHTIP_DSN,
    receiverUrl: import.meta.env.VITE_FEEDBACK_RECEIVER_URL,
    staffToken: import.meta.env.VITE_STAFF_API_TOKEN,
    appName: "your-app",
    environment: "development",
    userEmail,
    excludedPaths: [], // add any PII-bearing routes this app has
  });

  if (!excluded) mountReportWidget();
}
```

Call `setupIncidentCapture(currentUser.email)` once, after your auth state
resolves.

Test it: `npm run dev`, log in, then run `setTimeout(() => { throw new
Error("test") }, 0)` in the console. Confirm it shows up in that GlitchTip
project with breadcrumbs, and that a "Report Issue" submission — with its
replay — appears at `http://localhost:4000`.

Restart the dev server after changing `.env`: Vite reads env at boot, not on
hot reload. If `window.__SENTRY__` is undefined in the console, that's
usually why.

## 3. Wire up a local Dockerized Moodle

Two different network paths matter, since Moodle runs in its own container:

- **Client-side JS** (replay, report widget) runs in the browser on your
  machine, so it reaches the pipeline like any local app:
  `http://localhost:8000` / `http://localhost:4000`.
- **Server-side PHP** (fatal errors via the Sentry PHP SDK) runs *inside* the
  container, where `localhost` means the container itself. Use
  `http://host.docker.internal:8000` — Docker Desktop resolves that to the
  host automatically.

Steps:

1. Add the Sentry PHP SDK to the Moodle image (`composer require sentry/sdk`,
   or vendor it in your Dockerfile and rebuild).
2. Set `GLITCHTIP_DSN_MOODLE=http://<key>@host.docker.internal:8000/<id>` as
   an environment variable on the Moodle service.
3. Copy `moodle/config-snippet.php` into your Moodle `config.php`, adjusting
   the `vendor/autoload.php` path for that container.
4. Install a `local_` plugin that injects the client SDK for staff sessions
   (see `INTEGRATING.md` → *Moodle*). Its receiver URL and DSN render into
   the page for the browser, so they use `localhost`, not
   `host.docker.internal`.
5. Restart the container or purge caches (*Site administration > Development
   > Purge caches*), log in as an admin/grader, and confirm the "Report
   Issue" widget appears — and does **not** appear on a gradebook or profile
   page, or for a student account.
6. Trigger a PHP fatal (temporarily) to confirm it lands in the right
   GlitchTip project, and a client-side JS error to confirm breadcrumbs and
   replay arrive too.
