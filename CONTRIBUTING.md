# Contributing

Thanks for taking a look. This is a small, self-hosted alternative to
error-tracking SaaS — bug reports, integrations for new app types, and
documentation fixes are all welcome.

## Getting it running

```bash
git clone https://github.com/kinggamma/sentinel.git
cd sentinel
cp .env.example .env
```

Fill in `POSTGRES_PASSWORD`, `GLITCHTIP_SECRET_KEY`, and `STAFF_API_TOKEN`
with long random strings (`openssl rand -hex 32`), then:

```bash
docker compose up -d
```

`docs/LOCAL-TESTING.md` walks through the whole loop, including wiring a
local app to it. `docs/INTEGRATING.md` is the guide for adding an app.

## Layout

| Path | What lives there |
|---|---|
| `docker-compose.yml` | GlitchTip, Postgres, Redis, receiver, Caddy |
| `receiver/src/` | The Sentinel receiver API (Node/Express) |
| `receiver/public/` | Sentinel's UI — plain HTML/CSS/JS, no framework |
| `sdk/` | The shared browser SDK apps embed |
| `moodle/` | Moodle-specific integration assets |
| `docs/` | Integration guide, local testing, privacy checklist |

The UI takes dependencies only where the alternative is worse than the
dependency, and there are two: the replay player, and a QR generator for
authenticator enrolment — hand-rolling that one badly locks somebody out of
their own account. Both are bundled at image build with esbuild, never
fetched at runtime.

That last part is the rule to actually keep. Everything the browser loads
comes from this origin, because the CSP is `script-src 'self'` and there is
no CDN. A dependency that has to be fetched to work cannot be used here
whatever its merits; one that can be bundled is a judgement call, and the
default answer is still no.

## Making a change

1. Branch off `main`.
2. Make the change. Match the surrounding style; comments should explain
   *why*, not restate the code.
3. Run the suites, and say in the PR what you exercised beyond them.

   ```bash
   cd receiver && npm test
   ```

   Pure logic, no stack needed: the router, the auth state machine, the idle
   window, and active-organisation resolution.

   The rest need the stack up (`docker compose up -d`) and a seeded
   organisation, and they sign a dedicated test account in rather than
   borrowing a real one:

   ```bash
   ./scripts/run-smoke.sh
   ```

   Every endpoint, over HTTP, including the shapes the screens read fields
   out of. Then, from the repository root — `npm install` once, for the
   browser driver:

   ```bash
   npm run test:browser && npm run test:issues && npm run test:webauthn
   npm run test:orgs && npm run test:manage && npm run test:phase67
   npm run test:releases && npm run test:performance
   npm run test:logs && npm run test:uptime && npm run test:flip
   ```

   These are the regressions no HTTP call can see: the embedded viewer
   booting in a real iframe, the issue screen writing and deleting notes with
   a CSRF token and reporting a facet that will not load, passkey sign-in
   against a virtual authenticator, and every screen at 390px.

   The later ones cover a screen each. `test:phase67` is single sign-on,
   authenticator enrolment and API tokens; `test:releases`, `test:logs` and
   `test:uptime` each drive their screen and then ask GlitchTip whether the
   write actually landed, which is the only way to catch the endpoints whose
   update replaces every field it was not sent. `test:flip` walks the
   addresses GlitchTip's own interface used to answer and checks each lands
   on the screen that replaced it, with its organisation intact.

   `test:manage` presses the buttons that write: making a project, renaming
   it, adding and revoking keys, creating an alert and editing, testing and
   deleting it, hiding and showing an environment, building a team, pointing
   it at a project and deleting it from its own screen, and — on People —
   inviting somebody, promoting them, removing them, and declining a request
   somebody really made.

   Everything it touches is its own. The project, team, alert, environment,
   the invited member and the applicant who asks for access are all created
   by the run, named after it, and removed again; its last check is that
   nothing was left, and it sweeps what an earlier run stranded. It asks the
   API which organisation it is in rather than assuming one.

   It touches no shared account at all: it makes its own manager, member,
   guest and applicants, signs each in once, and deletes them. Run the
   suites one at a time — several of them sign the shared smoke account in,
   and that resets its password, which invalidates any session another suite
   is holding.

   `test:orgs` is the one that reconfigures things. Belonging to two
   organisations is unreachable on a single-organisation install, so it
   builds the situation: a second organisation, a real project moved into
   it, and the receiver restarted with `GLITCHTIP_ORG` empty. It puts all
   three back, and checks that it did. If it is killed part-way,
   `docker compose up -d` restores the pin.

   Browser-level tests live in the root package rather than `receiver/`, on
   purpose: the image's assets stage installs that package's dev
   dependencies, and a browser driver in there would make every image build
   download one.
4. If you touched `sdk/`, rebuild the bundle apps consume:
   ```bash
   ./sdk/build-moodle-bundle.sh <path-to-your-plugin>
   ```
5. Open a PR describing the problem first and the fix second.

## Things worth knowing before you change them

- **The staff token is a shared secret, not a login.** Anything that puts it
  somewhere new (a URL, a log line, a query string) needs a good reason.
- **Capture is gated server-side.** Apps decide who gets the SDK and simply
  don't render it for anyone else. Client-side checks are a backstop, never
  the boundary.
- **Replay masks all inputs by default.** Don't loosen defaults; add opt-ins.
- **Reports expire.** Retention (age and size) is a privacy feature as much
  as a disk one.

## Reporting security issues

Please don't open a public issue for a vulnerability — see `SECURITY.md`.

## License

By contributing you agree your contributions are licensed under the MIT
License, same as the rest of the project.
