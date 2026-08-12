# Security policy

## Reporting a vulnerability

Please report security issues privately — use GitHub's **Report a
vulnerability** button under the repository's Security tab, rather than
opening a public issue.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get an acknowledgement as soon as it's seen; this is a small
project, so please allow a reasonable window for a fix before disclosing.

## What this project assumes

Understanding the intended threat model helps decide whether something is a
bug or the documented design:

- **`STAFF_API_TOKEN` is a shared secret, not an identity.** It proves a
  request came from one of your apps. It does not identify a user and it is
  not an authorisation system. In a client-rendered admin panel it ships in
  the bundle and is therefore visible to anyone who can load that panel —
  which is why capture must be gated to staff sessions server-side.
- **Access control lives in the host app.** The pipeline trusts that an app
  only renders the SDK config for people allowed to be recorded. Nothing the
  receiver does substitutes for that gate.
- **Reading reports is authenticated; being recorded is not.** GlitchTip is
  the authority on who may read reports: Sentinel resolves either the
  caller's GlitchTip session or a personal auth token against membership of
  `GLITCHTIP_ORG`, and removing someone there removes them here. A session
  obtained silently is bound to the GlitchTip session it came from and dies
  with it. Sessions are HMAC-signed httpOnly cookies with no server-side
  store, so `SESSION_SECRET` is a secret: anyone holding it can mint one.
- **`STAFF_API_TOKEN` cannot sign a person in** whenever GlitchTip is
  configured. It is a machine credential — SDKs posting reports, the
  embedded viewer — and it ships in client bundles, so treating it as a
  login would make "can open the admin panel" equivalent to "can read every
  session replay". Being able to sign in with it where GlitchTip *is*
  configured is a bug worth reporting.
- **Plain HTTP is the default.** The stack ships without TLS because it is
  meant to sit on a private network, behind a VPN, or behind a firewall that
  only staff can reach. Exposing port 8000 or 4000 to the public internet
  without TLS in front is a deployment mistake, not a supported setup — see
  the automatic-HTTPS block in `caddy/Caddyfile`.
- **Session replays are sensitive data.** They record real staff sessions.
  Inputs are masked by default, sensitive pages are excluded entirely, and
  retention deletes reports on a schedule. Anything that weakens those
  defaults silently is a security bug.

## Things that are in scope

- Bypassing the receiver's token check.
- Reading or deleting reports without the token or a valid session.
- Forging a session cookie, or getting one issued for a GlitchTip account
  that isn't a member of the configured organisation.
- Escaping the report viewer's origin (XSS, CSP bypass, clickjacking of the
  embedded viewer).
- Path traversal in report or screenshot retrieval.
- Replay content leaking data that masking should have covered.
- Secrets ending up in logs, URLs, or referrer headers.

## Out of scope

- Exposing the stack to the public internet without TLS or a firewall.
- Reading `STAFF_API_TOKEN` from a client bundle you deliberately shipped it
  in (see above).
- Vulnerabilities in GlitchTip itself — report those upstream.
