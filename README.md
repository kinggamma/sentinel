# Sentinel

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A small, self-hosted alternative to error-tracking SaaS. Your apps report
crashes, session replays, and staff bug reports to infrastructure you run —
one dashboard, no third party, no per-seat pricing, and nobody else holding
recordings of your users' sessions.

Works with anything that can make an HTTP request: browser apps, Node,
Python, PHP, Moodle, mobile. Each app integrates on its own, in its own
repo, in about ten lines.

**What it gives you**

- **Error tracking** — uncaught exceptions with stack traces, grouped into
  issues (GlitchTip, which speaks the Sentry protocol, so you use the
  ordinary Sentry SDKs).
- **Session replay** — the last ~30s before a problem, recorded as DOM
  mutations with rrweb rather than screenshots. Tens of KB, scrubbable
  frame by frame, and it survives page navigations.
- **A "Report Issue" button** — staff describe what went wrong; the replay
  and breadcrumbs are attached automatically.
- **One viewer for every app** — Sentinel opens on a card per app that has
  reported; click through for that app's reports. Readable standalone, or
  embedded in each app's own admin, scoped to that app.
- **Sign-in you don't have to administer** — no user database. People sign
  in with their own GlitchTip auth token, and belonging to your GlitchTip
  organisation *is* the permission.
- **Privacy by default** — inputs masked, sensitive pages excluded, PII
  scrubbed before anything leaves the browser, and reports deleted on a
  retention schedule.

Runs on plain IP and ports — no domain or DNS needed, locally or on a
server.

## What's in here

```
docker-compose.yml       GlitchTip + Postgres + Redis + Sentinel receiver + Caddy
caddy/Caddyfile          Reverse proxy — IP/port based (localhost:8000 / :4000), no DNS needed
receiver/                Sentinel receiver service (Node/Express)
receiver/public/          Sentinel viewer UI served at http://localhost:4000
sdk/                     Shared browser SDK (incident-capture.js, report-widget.js)
moodle/                  Moodle integration assets (PHP snippet + JS injection)
docs/INTEGRATING.md      How to add an app — by language and framework
docs/LOCAL-TESTING.md    Running the whole thing on your own machine
docs/PRIVACY-CHECKLIST.md  Verify an integration before calling it done
docs/ISSUES.md           Suggested GitHub milestones/labels/issues
.env.example              All required environment variables
```

## Setup (Phase 1 — Foundation)

No domain or DNS required — this runs on plain IP:port, both locally and
once you move it to the server.

**Run it locally first:**

The defaults already point at `localhost`, so only the secrets need
filling in:

```bash
cp .env.example .env
```

```bash
for k in POSTGRES_PASSWORD GLITCHTIP_SECRET_KEY STAFF_API_TOKEN SESSION_SECRET; do sed -i '' "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env; done
```

On Linux that's `sed -i` without the `''`.

```bash
docker compose up -d && docker compose logs -f glitchtip-web
```

Visit `http://localhost:8000`, create the first account and an
organisation, then record its slug — membership of that organisation is
what lets someone read reports:

```bash
sed -i '' 's|^GLITCHTIP_ORG=.*|GLITCHTIP_ORG=<org-slug>|' .env && docker compose up -d feedback-receiver
```

Point GlitchTip's sidebar back at Sentinel. A patched copy is committed so
that a fresh clone starts at all — Docker would otherwise create a
*directory* at that mount path and break GlitchTip — but it was generated
against whichever GlitchTip build was current then, so regenerate it
against yours:

```bash
./scripts/patch-glitchtip-index.sh
```

Then hand `STAFF_API_TOKEN` to each app's **server-side** config. It is
what an app's SDK sends when it posts a report. Treat it as a secret: it
reads every report from every app connected to this pipeline, so an app
that serves it to a browser hands that access to whoever loads the page.

```bash
grep '^STAFF_API_TOKEN=' .env
```

You don't need to create a GlitchTip project per app by hand — set
`GLITCHTIP_SERVICE_TOKEN` and `GLITCHTIP_TEAM` and the first report from a
new app creates its project and reads back its DSN. See *New apps create
their own GlitchTip project* below.

**Later, moving it to the server:**

Nothing here is specific to a machine — `caddy/Caddyfile` binds ports
rather than hostnames, so the whole move is `.env` values. Substitute your
server's address for `<server-ip>` throughout.

Install Docker if it isn't there, then clone:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 && sudo usermod -aG docker $USER
```

```bash
git clone <this-repo> ~/sentinel && cd ~/sentinel
```

Write `.env`, generating the three secrets as you go. `ALLOWED_ORIGINS`
is every **browser** origin that posts reports or embeds the viewer:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
GLITCHTIP_SECRET_KEY=$(openssl rand -hex 32)
STAFF_API_TOKEN=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
GLITCHTIP_DOMAIN=http://<server-ip>:8000
SENTINEL_URL=http://<server-ip>:4000
GLITCHTIP_PORT=8000
SENTINEL_PORT=4000
ALLOWED_ORIGINS=http://<an-app-host>:<port>
EMAIL_URL=consolemail://
DEFAULT_FROM_EMAIL=errors@example.org
NOTIFY_WEBHOOK_URL=
GLITCHTIP_ORG=
SESSION_HOURS=12
GLITCHTIP_SERVICE_TOKEN=
GLITCHTIP_TEAM=
GLITCHTIP_PROJECT_MAP={}
RETENTION_DAYS=90
RETENTION_MAX_MB=5120
RETENTION_SWEEP_MINUTES=360
EOF
```

An app whose *server* forwards reports needs no entry in
`ALLOWED_ORIGINS`: that list drives CORS and CSP `frame-ancestors`, which
are browser rules. Such an app needs network access to port 4000 and
nothing more.

Start it, and watch the first boot — GlitchTip migrates its database
before it answers:

```bash
docker compose up -d && docker compose logs -f glitchtip-web
```

```bash
curl -s localhost:4000/health && curl -s -o /dev/null -w ' glitchtip %{http_code}\n' localhost:8000/
```

Open `http://<server-ip>:8000`, create the first account and the
organisation, then record its slug — that organisation is who may read
reports:

```bash
sed -i 's|^GLITCHTIP_ORG=.*|GLITCHTIP_ORG=<org-slug>|' .env && docker compose up -d feedback-receiver
```

Add the Sentinel link to GlitchTip's sidebar. This bakes `SENTINEL_URL`
into GlitchTip's shell, so it runs *after* that value is right — and again
whenever it changes, or after a GlitchTip upgrade:

```bash
./scripts/patch-glitchtip-index.sh
```

Finally, hand each app the token it will send with reports:

```bash
grep '^STAFF_API_TOKEN=' .env
```

If the server already runs something else, check the two ports are free
before any of the above:

```bash
sudo ss -tlnp | grep -E ':(4000|8000)'
```

If either is taken, don't move the other service — publish this one
elsewhere. `GLITCHTIP_PORT` and `SENTINEL_PORT` change only what is
published on the host; inside the network everything still talks on 8000
and 4000, so the Caddyfile is untouched. Change the matching
`GLITCHTIP_DOMAIN` / `SENTINEL_URL` at the same time: GlitchTip builds
DSNs from the domain, so a mismatch hands apps a DSN that resolves to
nothing.

`EMAIL_URL=consolemail://` prints invitation emails to the container log
instead of sending them, which is enough to get started — but inviting
someone to the organisation is how you grant access, so real SMTP is
needed before anyone else can be let in.

**Two things worth deciding before you expose it.**

Keep GlitchTip and Sentinel on the same host. Signing in to Sentinel
silently relies on GlitchTip's session cookie, which is host-only and
port-blind — same host on different ports is fine, two hosts is not.
Split them and silent sign-in and linked sign-out both stop working, and
everyone falls back to pasting auth tokens. Apps may live wherever they
like; this is only about these two.

Plain HTTP means the staff token crosses the network in cleartext on every
report. On a private network that may be fine; facing the internet it
isn't. Open the two ports only to what needs them:

```bash
sudo ufw allow from <app-server-ip> to any port 4000 proto tcp
```

```bash
sudo ufw allow from <staff-address> to any port 8000 proto tcp
```

A bare IP can't hold a browser-trusted certificate, so TLS needs a
domain. Once you have one, point it at the server and swap to the
automatic-HTTPS block at the bottom of `caddy/Caddyfile` — Caddy obtains
and renews the certificate itself. Then tell the receiver its cookies are
travelling over TLS, so they stop being sent over plain HTTP at all:

```bash
echo 'SECURE_COOKIES=true' >> .env && docker compose up -d feedback-receiver
```

## Where things end up

Two stores, two UIs — worth knowing which one to open:

| What | Lands in | Look at it |
|---|---|---|
| Uncaught JS/PHP errors, stack traces | GlitchTip | http://localhost:8000 → Issues |
| "Report Issue" clicks + session replays + breadcrumbs | Sentinel | http://localhost:4000 |

Sentinel opens on one card per app that has reported — how many reports,
how many were staff-filed against auto-captured, how many carry a replay,
and when the last one arrived — and clicking a card drills into that app's
reports. Where an app's errors also live in GlitchTip, each card and each
report links straight across.

Going the other way, GlitchTip's sidebar carries a **Sentinel** item, below
its own nav. GlitchTip ships as a prebuilt image with nowhere to configure
one, so it's added by mounting a patched copy of its own SPA shell. The
sidebar is built by Angular at runtime, so the injected script clones a nav
item that's already there and retargets the copy — which means it picks up
whatever styling that build uses instead of guessing at class names, and it
is restored if Angular re-renders. Where no sidebar exists (the login page,
or a build that restructured it) a small corner link is shown instead, so
the link is never simply missing.

```bash
./scripts/patch-glitchtip-index.sh
```

> **After every GlitchTip upgrade, re-run that script.** The patched shell
> names GlitchTip's hash-named JS bundles, so once the image moves on, the
> mount serves a shell pointing at bundles that no longer exist and
> GlitchTip won't load at all. `./scripts/patch-glitchtip-index.sh --check`
> compares the copy against the current image and exits non-zero when it has
> gone stale — worth running straight after `docker compose pull`.

## New apps create their own GlitchTip project

Adding an app used to mean creating its GlitchTip project by hand, copying
the DSN out, and telling Sentinel which project belonged to which app. Set
`GLITCHTIP_SERVICE_TOKEN` and `GLITCHTIP_TEAM` and none of that is
necessary: the first report from an app Sentinel hasn't seen creates the
project, reads its DSN back, and remembers the mapping. The DSN then shows
up on that app's card, ready to paste into the app's config.

The mapping lives in `projects.json` beside the reports, so a restart
doesn't re-create anything. `GLITCHTIP_PROJECT_MAP` still works and still
wins — use it for apps whose project already existed under a different
name.

Provisioning happens after the report is saved and is never awaited, so an
app filing a bug can't be failed by GlitchTip being slow or down; a failure
is logged and the next report from that app tries again.

**Give that token `project:write` and not `project:admin`.** Creating a
project needs the first and deleting one needs the second, so a token
without it can add projects and never remove one. The account does have to
hold the organisation's Admin role — GlitchTip checks that by role and no
scope substitutes for it — which is why it should be a dedicated account
used only by the receiver. Don't sign in to GlitchTip as it in a browser:
scopes only constrain token requests, and a browser session would carry the
Admin role in full.

## Who can read reports

There is no user database to administer. GlitchTip holds the accounts, and
Sentinel asks it who you are. **Most of the time there is nothing to sign
in to:** if you're already signed in to GlitchTip in that browser, opening
Sentinel signs you in silently — GlitchTip's session cookie is host-only,
and cookies ignore ports, so it reaches the receiver on `:4000` too.
Sentinel hands it back to GlitchTip to ask whose it is.

Signing out of Sentinel signs you out of GlitchTip, and signing out of
GlitchTip locks Sentinel on the next click — a silent session is bound to
the GlitchTip session it came from, so it can't outlive it.

**First, once per installation:** open GlitchTip at `:8000`, create your
account and your organisation, and put that organisation's slug in
`GLITCHTIP_ORG`. Everyone else who needs to read reports gets invited to
that organisation in GlitchTip — the invitation *is* their Sentinel access.

After that there are two ways in, and both are fine.

**1. Already signed in to GlitchTip → just open Sentinel.** Nothing to
type. This is the usual one.

**2. Sign in to Sentinel directly with an auth token.** Useful when you
don't want to visit GlitchTip at all, or you're on a machine or browser
that isn't signed in there. Do this once:

1. In GlitchTip, click your avatar → **Profile**.
2. Go to **Auth Tokens** → **Create New Token**.
3. Tick **`org:read`** and create it. GlitchTip's `/api/0/organizations/`
   requires that scope, and a token without it is refused no matter who
   owns it — this is the one step worth getting right.
4. Copy the token and **save it somewhere you'll find again** (a password
   manager). GlitchTip shows it once.

From then on, open Sentinel, paste the token, and you're in — the account
behind it still has to belong to `GLITCHTIP_ORG`. The session lasts
`SESSION_HOURS`, so it's not something you paste daily.

Keep GlitchTip's `ENABLE_OPEN_USER_REGISTRATION=false` (the default here)
so nobody can create their own account and walk in.

Sessions are an HMAC-signed, httpOnly cookie — no server-side store, and no
credential kept in the browser's localStorage. Set `SESSION_SECRET` or
everyone is signed out whenever the receiver restarts.

**`STAFF_API_TOKEN` is not a way to sign in.** It's how apps' SDKs post
reports and how the embedded viewer reads them, which means it ships inside
client-rendered admin panels and anyone who can open one can read it. If it
also signed people in, viewing source would be enough to browse every
report and every session replay. So it doesn't — a person signing in brings
a GlitchTip account. (The one exception: with no GlitchTip configured there
would be no way in at all, so it stays the credential of last resort for
that setup.)

Only the static page is unauthenticated; every byte of report data still
goes through the guarded `/api` routes.

### Embedding the viewer in an app's own admin

Staff shouldn't have to know a second URL exists. Each app frames the same
viewer inside its own admin area, scoped to that app's reports:

```html
<iframe src="http://localhost:4000/?app=<appName>&embed=1"></iframe>
```

`?app=` locks the view to one app and skips the landing page; `embed=1`
drops Sentinel's own page chrome so it sits flush in your layout. The host
page — which already holds the staff token — hands it over by postMessage,
so the token stays out of the URL, browser history, referrer headers, and
access logs:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== RECEIVER_ORIGIN) return;
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type !== "incident-viewer-ready") return;
  event.source.postMessage(
    { type: "incident-viewer-token", token: STAFF_API_TOKEN },
    RECEIVER_ORIGIN
  );
});
```

Embedded, the viewer does *not* persist the token — the host re-supplies
it on every load. Only origins in `ALLOWED_ORIGINS` may frame the viewer
(CSP `frame-ancestors`), so add each app's origin there.

`docs/INTEGRATING.md` has copy-pasteable versions for a React admin and for
a Moodle plugin page. The standalone `http://localhost:4000` stays the
cross-app view for whoever needs everything at once.

Note that a staff-initiated report is **not** an error: it never reaches
GlitchTip. And GlitchTip only sees *uncaught* errors — anything the app
catches and renders as a notice has to be sent explicitly with
`Sentry.captureException()`.

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
       dsn: "http://<key>@localhost:8000/<project-id>", // or http://<server-ip>:8000/<project-id>
       receiverUrl: "http://localhost:4000/api",         // or http://<server-ip>:4000/api
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

## Session replay

Apps record the page with **rrweb** rather than taking screenshots: a stream
of DOM mutations against a periodic snapshot. A minute of replay is tens of
KB (screenshots were ~150KB *per frame*), it scrubs frame-perfectly instead
of landing between shots, and it costs a fraction of the CPU `html2canvas`
did.

It runs as a rolling in-memory buffer — the last ~60s, nothing uploaded
until an error fires or someone files a report. By the time a person notices
a problem it's already seconds in the past, which is why recording can't
start when they click the button.

The buffer **survives page navigation**. A full page load destroys the
recorder, so on a multi-page app (Moodle) a report filed just after clicking
through would otherwise show one second of the page you landed on. The tail
of the previous page is handed forward through `sessionStorage` and replayed
ahead of the new page's events — you see the click that navigated, then the
new page, in one scrubbable timeline. Anything older than `maxSeconds` is
dropped at a snapshot boundary, so the stream always stays playable.

Defaults, overridable per app via `initIncidentCapture({ capture: {...} })`:

| Option | Default | |
|---|---|---|
| `minSeconds` | 5 | always keep at least this much, when it exists |
| `maxSeconds` | 30 | never keep more than this |
| `carryAcrossPages` | `true` | stitch in the tail of the previous page |
| `maskAllInputs` | `true` | never records what anyone types |
| `maskAllText` | `false` | set `true` to mask every string on the page |
| `maskTextSelector` | — | or mask only these elements |

Each app owns its own window — a Moodle plugin can expose it as a site
setting, a Vite app as an environment variable. An admin who wants a 10s
minimum and a 5-minute maximum sets that in their own app; nothing changes
in the pipeline.

## When the pipeline can't be reached

Apps never throw a raw error at whoever is filing a report. If the receiver
is down, moved, or the app is pointed at the wrong address, the widget says
so in plain words — naming the host it tried, so a misconfigured `.env` is
obvious — and keeps the typed note on screen rather than discarding it.
Wrong token and too-large-payload get their own messages.

Both admin pages probe `/health` before framing the viewer, so a dead
pipeline shows an explanation instead of the browser's connection-error page.

Anything marked `data-incident-capture-ignore` is dropped from the recording
entirely. Reports made before this change still carry screenshot frames and
still display.

## Retention

Reports hold replays of real sessions, so they expire. Two independent caps
in `.env`, whichever bites first:

| | Default | |
|---|---|---|
| `RETENTION_DAYS` | 90 | delete anything older |
| `RETENTION_MAX_MB` | 5120 | over budget, delete oldest-first until it fits |
| `RETENTION_SWEEP_MINUTES` | 360 | how often to check |

Set either to `0` to disable that cap. Staff can also delete any single
report from the viewer (`DELETE /api/reports/:id`), which removes its
screenshots and replay from disk immediately.

## Privacy

- Nothing is captured on gradebook or profile pages — enforced twice:
  once server-side (don't even render the config/script), once
  client-side (`excludedPaths` check in `incident-capture.js`).
- Every event and breadcrumb is scrubbed for emails/phone
  numbers/card-like sequences before it leaves the browser or server —
  see `deepScrub()` in `sdk/incident-capture.js` and
  `moodle_incident_capture_scrub()` in the PHP snippet.
- The replay buffer is in-memory and rolling (last ~60s), masks every
  input by default, and is only ever uploaded when an error fires or a
  staff member explicitly clicks "Report Issue" — never streamed
  continuously.
- Reports are deleted automatically on the retention schedule above, and
  staff can delete any individual report from the viewer.
- Before calling any phase "done," run through
  `docs/PRIVACY-CHECKLIST.md` on that app.

## Rolling this out

1. **Foundation** — `docker compose up -d`, create your organisation.
   Projects create themselves as apps start reporting.
2. **First app** — wire one app end to end and confirm both halves: an
   error in GlitchTip, a staff report with a replay in the viewer.
3. **The rest** — repeat per app; see `docs/INTEGRATING.md` for the
   per-language recipes.
4. **Privacy pass** — `docs/PRIVACY-CHECKLIST.md` on every app before you
   call it done.
5. **Hardening** — put TLS in front of it (or keep it on a private network),
   and set retention to suit your policy.

Checking a live pipeline, in the order things break:

```bash
docker compose ps
```

```bash
curl -s localhost:4000/health && curl -s -o /dev/null -w ' glitchtip %{http_code}\n' localhost:8000/
```

```bash
curl -s localhost:4000/api/projects -H "Authorization: Bearer $(grep '^STAFF_API_TOKEN=' .env | cut -d= -f2)"
```

That last one answers the question that actually matters — has anything
reported yet, and does each app map to a GlitchTip project. If a report
should have arrived and didn't, see whether it reached the proxy at all:

```bash
docker compose logs --tail 40 caddy | grep -o '"uri":"[^"]*"'
```

`docs/ISSUES.md` breaks this into GitHub issues, milestones, and labels if
you want to track it there.

## Known limits

- No automated test suite yet — changes are verified by hand against a
  running stack.
- Replay needs a DOM, so mobile apps get error tracking only.
- The receiver stores reports on the filesystem; there's no clustering or
  object-storage backend.
- Plain HTTP by default; see `caddy/Caddyfile` for the automatic-HTTPS
  block once you have a domain.

## Contributing

Bug reports, integrations for new stacks, and documentation fixes are all
welcome — see `CONTRIBUTING.md`. Security issues: `SECURITY.md`, privately
please.

## License

MIT — see [LICENSE](LICENSE). GlitchTip, rrweb, and the Sentry SDKs are
separate projects under their own licenses.
