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
| `receiver/public/` | The report viewer UI — plain HTML/CSS/JS, no framework |
| `sdk/` | The shared browser SDK apps embed |
| `moodle/` | Moodle-specific integration assets |
| `docs/` | Integration guide, local testing, privacy checklist |

The viewer is deliberately dependency-free apart from the bundled replay
player. Please keep it that way — it has to work behind a strict CSP with no
network access beyond its own origin.

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
   npm run test:orgs && npm run test:manage
   ```

   These are the regressions no HTTP call can see: the embedded viewer
   booting in a real iframe, the issue screen writing and deleting notes with
   a CSRF token and reporting a facet that will not load, passkey sign-in
   against a virtual authenticator, and every screen at 390px.

   `test:manage` presses the buttons that write: making a project, renaming
   it, adding and revoking keys, creating an alert and testing it, hiding an
   environment, building a team and pointing it at a project, and the role
   rules on People. It is safe by construction — every object it touches is
   one it made, named after the run, and removed again — with two stated
   exceptions: it raises the smoke account's role and puts it back, and it
   hides one existing environment and unhides it. It sweeps anything a
   previous run stranded, and its last check is that it left nothing.

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
