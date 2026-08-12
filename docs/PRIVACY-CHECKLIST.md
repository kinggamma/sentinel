# Privacy hardening checklist (Roadmap Phase 5)

Run this against every app before calling its integration done.

## Per-app

- [ ] `excludedPaths` (JS) / page-type exclusion (Moodle PHP) actually
      matches every gradebook, profile, and other PII-bearing route —
      test by navigating to each and confirming `initIncidentCapture`
      returns `{ excluded: true }` and no network request to the
      receiver fires.
- [ ] Config injection (`window.__INCIDENT_CAPTURE_CONFIG__` /
      Moodle's `has_capability` check) is only rendered for confirmed
      staff/admin sessions — verify by loading the same page as a
      non-staff user and confirming the script isn't even present in
      the page source.
- [ ] Trigger a real error containing a fake email/phone/card number in
      a form field or console log; confirm the event that lands in
      GlitchTip has `[redacted]` in place of it, in both the exception
      payload and breadcrumbs.
- [ ] Screenshot buffer: confirm elements marked
      `data-incident-capture-ignore` (e.g. the report widget itself, and
      any known PII widget) are excluded from captured frames.
- [ ] `STAFF_API_TOKEN` / per-app tokens are not visible in any public
      JS bundle for non-staff sessions (they should only ever be
      injected server-side into staff-gated pages).
- [ ] Screenshot retention: confirm `receiver_data` volume has a
      retention/cleanup policy (not indefinite storage) — add a cron/
      systemd timer if not already present.

## Pipeline-wide

- [ ] GlitchTip admin/dashboard access is restricted to staff/admin
      accounts (not open registration — `ENABLE_OPEN_USER_REGISTRATION`
      is `false` in `docker-compose.yml`).
- [ ] `feedback.<domain>` only accepts requests bearing a valid
      `STAFF_API_TOKEN` (verify a request without the header gets a 401).
- [ ] TLS is actually terminating correctly on both `errors.<domain>`
      and `feedback.<domain>` (no plain-HTTP fallback).
- [ ] `.env` is not committed to git (`.gitignore` covers it) and secrets
      aren't reused across apps.
