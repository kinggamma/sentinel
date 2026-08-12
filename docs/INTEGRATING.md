# Adding an app to the pipeline

How to wire an app into this error monitoring and bug reporting pipeline.
Each app integrates independently — they don't have to share a repo, a
language, or a deployment.

Find your stack:

- [Concepts, and what it costs](#concepts-and-what-it-costs)
- [Before you start](#before-you-start)
- [JavaScript — single-page apps (React, Vue, Svelte, Angular)](#javascript--single-page-apps)
- [Server-rendered apps (PHP, Django, Rails, Laravel, Express + templates)](#server-rendered-apps)
- [Node.js backends and workers](#nodejs-backends-and-workers)
- [Python backends (Django, FastAPI, Flask, Celery)](#python-backends)
- [PHP backends (Laravel, Symfony, plain PHP)](#php-backends)
- [Moodle](#moodle)
- [Mobile (React Native, Flutter, native)](#mobile)
- [Showing reports inside your app's admin](#showing-reports-inside-your-apps-admin)
- [Configuration reference](#configuration-reference)
- [Before you call it done](#before-you-call-it-done)
- [Troubleshooting](#troubleshooting)

---

## Concepts, and what it costs

Two kinds of thing land in two different places. Knowing which is which saves
a lot of confusion:

| What | Where it goes | Where you read it |
|---|---|---|
| Uncaught errors + stack traces | GlitchTip | `http://<pipeline-host>:8000` → Issues |
| "Report Issue" submissions, session replays, breadcrumbs | Feedback receiver | `http://<pipeline-host>:4000` |

A staff report is **not** an error — it never appears in GlitchTip. And
GlitchTip only sees *uncaught* errors; anything your app catches and renders
as a friendly notice has to be sent deliberately with
`captureException(err)`.

The cost per app is small and mostly one-time: install a package or two, set
three environment variables, call one function once. Every app that joins
gets the same viewer, retention policy, and privacy rules.

**Browser apps get everything** — errors, breadcrumbs, session replay, and
the "Report Issue" widget. **Backend services get errors and stack traces**;
there's no DOM to record and nobody sitting in front of them to click a
button.

## Before you start

You need three values from whoever runs the pipeline:

1. **Pipeline host** — `localhost` locally, or the server's IP or domain.
2. **A GlitchTip DSN for your app.** In GlitchTip, create one *project per
   app*. Each project gives you a DSN like
   `http://<key>@<pipeline-host>:8000/<project-id>`. A frontend and its
   backend are usually two separate projects.
3. **`STAFF_API_TOKEN`** — the shared secret apps send to the feedback
   receiver. It lives in the pipeline's `.env`. It is not a per-user login.

Then add your app's origin to the pipeline's `.env`:

```
ALLOWED_ORIGINS=http://localhost:5173,https://app.example.org
```

That one list controls both which origins may POST reports (CORS) and which
may embed the viewer (CSP `frame-ancestors`). Restart the receiver after
changing it. **Symptom of forgetting:** reports fail with a CORS error in the
console and the embedded viewer refuses to frame.

Pick an **app name** now — a stable slug like `admin-panel` or `billing-api`.
It labels every report and the viewer filters on it. Renaming it later
orphans older reports under the old name.

---

## JavaScript — single-page apps

React, Vue, Svelte, Angular, or plain ES modules with a bundler.

**Install:**

```bash
npm install @sentry/browser rrweb
```

**Copy the SDK** into your app — two files, no build step of their own:

```bash
mkdir -p src/incident-capture
cp <pipeline>/sdk/incident-capture.js src/incident-capture/
cp <pipeline>/sdk/report-widget.js src/incident-capture/
```

On TypeScript projects with `allowJs: false`, add a `.d.ts` beside each file
rather than flipping that flag for the whole project.

**Configure.** With Vite, in a gitignored `.env`:

```
VITE_GLITCHTIP_DSN=http://<key>@<pipeline-host>:8000/<project-id>
VITE_FEEDBACK_RECEIVER_URL=http://<pipeline-host>:4000/api
VITE_STAFF_API_TOKEN=<STAFF_API_TOKEN>
```

(Create React App uses `REACT_APP_`; Next.js uses `NEXT_PUBLIC_`. Same idea.)

> **Read this before shipping to a public app.** Anything in a client bundle
> is readable by anyone who opens devtools, `STAFF_API_TOKEN` included. That
> is acceptable for an internal admin panel only staff can reach. For an app
> the public can load, don't put the token in the bundle — render the config
> server-side for staff sessions only, as in
> [Server-rendered apps](#server-rendered-apps).

**Wire it up.** One module, called once after auth resolves:

```js
import { initIncidentCapture } from "./incident-capture.js";
import { mountReportWidget } from "./report-widget.js";

export const APP_NAME = "your-app";
let started = false;

export function setupIncidentCapture(userEmail) {
  if (started || !userEmail) return; // signed-in staff only

  const dsn = import.meta.env.VITE_GLITCHTIP_DSN;
  const receiverUrl = import.meta.env.VITE_FEEDBACK_RECEIVER_URL;
  const staffToken = import.meta.env.VITE_STAFF_API_TOKEN;
  if (!dsn || !receiverUrl || !staffToken) return; // no pipeline, no noise

  started = true;

  const { excluded } = initIncidentCapture({
    dsn,
    receiverUrl,
    staffToken,
    appName: APP_NAME,
    environment: import.meta.env.MODE,
    userEmail,
    excludedPaths: [/\/profile/i, /\/billing/i], // capture nothing here
    capture: { minSeconds: 5, maxSeconds: 30 },
  });

  if (!excluded) mountReportWidget();
}
```

Call it where your app first learns who is logged in — an effect on auth
state, a router guard, a store subscription. Calling it twice is harmless.

**Check it worked.** Run the app, sign in, then in the browser console:

```js
setTimeout(() => { throw new Error("integration test") }, 0);
```

`setTimeout` matters: it guarantees the throw reaches `window.onerror`, which
is what the SDK hooks. Confirm the issue in GlitchTip, then click "Report
Issue" and confirm the report — with a replay — at `:4000`.

## Server-rendered apps

PHP, Django, Rails, Laravel, Express with templates — anything where the
server renders HTML. Same SDK as above with one important change: **the
server decides who gets capture and simply doesn't render the script for
anyone else.** That, not any client-side check, is the real access control.

Serve the two SDK files as static assets, then, for staff sessions only:

```html
<script>
  window.__INCIDENT_CAPTURE_CONFIG__ = {
    dsn: "http://<key>@<pipeline-host>:8000/<project-id>",
    receiverUrl: "http://<pipeline-host>:4000/api",
    staffToken: "<STAFF_API_TOKEN>",
    appName: "your-app",
    userEmail: "<current user email>",
    capture: { minSeconds: 5, maxSeconds: 30 }
  };
</script>
<script type="module" src="/assets/incident-capture-init.js"></script>
```

`incident-capture-init.js` reads that global and calls
`initIncidentCapture` — `moodle/incident-capture-init.js` in this repo is a
complete example you can copy for any framework.

Browsers can't resolve bare imports like `"rrweb"`, and most server-rendered
apps have no bundler in the request path. Pre-bundle the SDK into one file:

```bash
<pipeline>/sdk/build-moodle-bundle.sh <your-static-assets-dir>
```

Rerun it whenever the SDK changes. Don't hand-edit the output.

**Excluding sensitive pages.** Check twice — server-side (don't render the
config at all) and client-side (`excludedPaths`). Anything with grades,
health data, payment details, or personal profiles. A page excluded
server-side costs nothing at all; the client check is the backstop.

**If your framework sets a Content-Security-Policy**, an inline `<script>`
will be blocked. Put the handshake in an external file and pass values on
`data-` attributes instead.

## Node.js backends and workers

APIs, queue workers, cron jobs. No DOM, so no replay and no widget — you want
stack traces. GlitchTip speaks the Sentry protocol, so use the ordinary
Sentry SDK.

```bash
npm install @sentry/node
```

```js
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.GLITCHTIP_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.01,        // 1% is plenty; keeps disk use sane
  autoSessionTracking: false,    // GlitchTip has no sessions
  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  },
});

// Express 4: after your routes, before any other error middleware
app.use(Sentry.Handlers.errorHandler());
```

Express 5 and Fastify have their own integrations; the `init` call is the
same.

## Python backends

Django, FastAPI, Flask, Celery.

```bash
pip install "sentry-sdk[fastapi]"   # or [django], [flask], [celery]
```

```python
import os
import sentry_sdk

sentry_sdk.init(
    dsn=os.environ["GLITCHTIP_DSN"],
    environment=os.getenv("ENVIRONMENT", "production"),
    traces_sample_rate=0.01,
    auto_session_tracking=False,
    send_default_pii=False,   # don't ship cookies/headers/user data
)
```

Put it as early as possible — `settings.py` for Django, before `app =
FastAPI()` for FastAPI, in the worker bootstrap for Celery. The framework
integrations pick up unhandled exceptions automatically.

## PHP backends

Laravel, Symfony, or plain PHP.

```bash
composer require sentry/sdk
```

```php
\Sentry\init([
    'dsn' => getenv('GLITCHTIP_DSN'),
    'environment' => getenv('APP_ENV') ?: 'production',
    'traces_sample_rate' => 0.01,
    'send_default_pii' => false,
]);
```

Call it as early as the framework allows — a bootstrap file, a service
provider, or the top of `index.php`. Laravel and Symfony each have a bundle
that wires the handlers for you.

## Moodle

Install a small `local_` plugin rather than editing core or a theme — it
survives upgrades and needs no theme switch. The plugin should:

- inject the SDK from a `before_standard_head_html_generation` hook
  (Moodle 4.4+), gated on a capability like `moodle/grade:manage`;
- skip grade and profile page types entirely;
- keep DSN, receiver URL, and token in plugin settings, not in code;
- add its own `local/<plugin>:viewreports` capability so support staff can
  read reports without full site configuration rights.

`moodle/moove-theme-injection.php` and `moodle/incident-capture-init.js` in
this repo are working starting points, and `moodle/config-snippet.php` covers
server-side PHP fatals via the Sentry PHP SDK in `config.php`.

Two network paths to keep straight when Moodle runs in a container: the
browser reaches the pipeline at `localhost`, but PHP inside the container
does not — use `host.docker.internal` or the real host there.

## Mobile

There is no rrweb and no report widget on mobile — rrweb records a DOM, and
there isn't one. Use the platform's Sentry SDK (`@sentry/react-native`,
`sentry_flutter`, `sentry-android`, `sentry-cocoa`) pointed at a GlitchTip
project DSN.

For in-app bug reports, post to the receiver directly:

```
POST http://<pipeline-host>:4000/api/reports
Authorization: Bearer <STAFF_API_TOKEN>
Content-Type: multipart/form-data

appName, url, note, reporterEmail, source=staff-report,
breadcrumbs (JSON), screenshots (optional image files)
```

Anything that arrives shows up in the viewer like any other report.

---

## Showing reports inside your app's admin

Staff shouldn't need to know a second URL exists. Frame the viewer inside
your own admin, scoped to your app:

```
http://<pipeline-host>:4000/?app=<appName>&embed=1&accent=%231677ff&theme=dark
```

- `app` locks the list to your app and hides the app picker
- `embed=1` drops the viewer's own page chrome so it sits flush in your layout
- `accent` (hex) and `theme` (`light` / `dark`) match your palette

Don't put the token in that URL. The frame asks for it once loaded:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== RECEIVER_ORIGIN) return;
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type !== "incident-viewer-ready") return;
  event.source.postMessage(
    { type: "incident-viewer-token", token: STAFF_API_TOKEN, theme, accent },
    RECEIVER_ORIGIN
  );
});
```

Probe `GET /health` before rendering the iframe — if the pipeline is down,
show your own message rather than the browser's connection-error page.

The standalone `:4000` remains the all-apps view for whoever needs everything
at once.

## Configuration reference

Passed to `initIncidentCapture({ ... })`:

| Key | Required | |
|---|---|---|
| `dsn` | yes | GlitchTip DSN for this app's project |
| `receiverUrl` | yes | `http://<host>:4000/api` |
| `staffToken` | yes | shared `STAFF_API_TOKEN` |
| `appName` | yes | label on every report; the viewer filters on it |
| `userEmail` | — | "reported by"; never sent to GlitchTip |
| `environment` | — | `development` / `production` tag |
| `excludedPaths` | — | regexes; capture nothing at all on these paths |
| `extraTags` | — | extra GlitchTip tags (tenant, course, region …) |
| `capture.minSeconds` | — | keep at least this much replay (default 5) |
| `capture.maxSeconds` | — | never keep more (default 30) |
| `capture.carryAcrossPages` | — | stitch in the previous page's tail (default true) |
| `capture.maskAllInputs` | — | default `true` — never records typing |
| `capture.maskAllText` | — | `true` masks every string on the page |

`mountReportWidget({ ... })`:

| Key | |
|---|---|
| `label` | button text |
| `position` | starting anchor: `top`/`bottom` × `left`/`center`/`right` |
| `offset` | `{ x, y }` margin from the viewport edge |
| `accent` | button colour |
| `draggable` | staff can drag it to another anchor (default true, remembered per browser) |
| `container` | render inline in a toolbar instead of floating |

## Before you call it done

- [ ] A test error reaches this app's GlitchTip project.
- [ ] A "Report Issue" submission reaches `:4000` with a replay attached.
- [ ] Someone **without** staff rights loads the app, and the page source
      contains no config, no token, and no SDK.
- [ ] Sensitive pages capture nothing — confirmed on the real pages, not just
      in the config.
- [ ] The replay masks typed input: type into a field, file a report, search
      the stored replay for what you typed. It must not be there.
- [ ] The app degrades gracefully with the pipeline stopped — a plain
      message, no stack trace in the user's face.
- [ ] Secrets are in gitignored env files or server config, not committed.

`docs/PRIVACY-CHECKLIST.md` is the fuller version of this list.

## Troubleshooting

**Nothing in GlitchTip.** Is the error actually uncaught? Caught errors need
an explicit `captureException()`. Then check whether the request even left
the browser:

```bash
docker compose logs --tail 40 caddy | grep -o '"uri":"[^"]*"'
```

A `/api/<project-id>/envelope/` line means it arrived.

**CORS errors when posting a report.** The app's origin isn't in
`ALLOWED_ORIGINS`. Add it and restart the receiver.

**401 from the receiver.** The app's token doesn't match the pipeline's
`STAFF_API_TOKEN`. Rotating it means changing it everywhere at once.

**Replay is only a second long.** Expected on a first page load — there's
nothing older to show. If it stays that way after navigating,
`carryAcrossPages` is off or `sessionStorage` is blocked.

**The embedded viewer won't frame.** Same `ALLOWED_ORIGINS` list — it drives
CSP `frame-ancestors` too. The browser console will say so explicitly.

**Works locally, breaks on the server.** Almost always a `localhost` left in
a config that now runs elsewhere. Inside a container, `localhost` is the
container itself — use the real host or `host.docker.internal`.
