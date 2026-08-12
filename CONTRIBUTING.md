# Contributing

Thanks for taking a look. This is a small, self-hosted alternative to
error-tracking SaaS — bug reports, integrations for new app types, and
documentation fixes are all welcome.

## Getting it running

```bash
git clone https://github.com/kinggamma/error-monitoring-pipeline.git
cd error-monitoring-pipeline
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
3. Test it against a running stack — there is no automated suite yet, so say
   in the PR what you actually exercised.
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
