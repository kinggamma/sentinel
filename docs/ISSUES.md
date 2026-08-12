# GitHub project scaffold

Once the repo is pushed, create these milestones, labels, and issues.
(The GitHub connector isn't authorized in this session, so this is a
paste-in checklist rather than API-created issues — see the note at the
bottom on wiring up gh CLI or the GitHub MCP connector to create them
directly next time.)

## Labels

`infra`, `moodle`, `js-app`, `privacy`, `docs`

## Milestones

1. Foundation
2. First integration
3. Moodle integration
4. Remaining apps
5. Privacy hardening pass
6. Session replay (optional)

## Issues

### Milestone 1 — Foundation
- [ ] Provision VPS, DNS (`errors.<domain>`, `feedback.<domain>`), TLS — `infra`
- [ ] Deploy GlitchTip via Docker Compose — `infra`
- [ ] Build feedback/incident receiver service — `infra`
- [ ] Build shared `incident-capture.js` module — `infra`, `docs`

### Milestone 2 — First integration
- [ ] Reference integration: pick one JS app, wire errors + breadcrumbs + screenshot buffer + feedback widget end to end — `js-app`
- [ ] Confirm error → GlitchTip → linked screenshot bundle round trip — `js-app`
- [ ] Confirm "Report Issue" → Slack notification round trip — `js-app`

### Milestone 3 — Moodle integration
- [ ] Moodle: PHP SDK in `config.php` (server-side fatals) — `moodle`
- [ ] Moodle: Moove theme JS injection + staff gating — `moodle`
- [ ] Moodle: verify gradebook/profile pages are excluded — `moodle`, `privacy`

### Milestone 4 — Remaining apps
- [ ] Roll out `sdk/incident-capture.js` pattern to remaining MERN/NestJS apps — `js-app`
- [ ] Roll out to Python/PHP services (server-side SDK only, no screenshot buffer) — `infra`

### Milestone 5 — Privacy hardening pass
- [ ] Run `docs/PRIVACY-CHECKLIST.md` against every app — `privacy`
- [ ] Verify PII scrub actually holds (no emails/phones/etc leaking into GlitchTip) — `privacy`

### Milestone 6 — Session replay (optional, later)
- [ ] Revisit OpenReplay only if the lightweight screenshot buffer proves insufficient — `infra`

### Always
- [ ] Write team runbook: how to read an error, how to file feedback, how to jump from error to screenshots — `docs`

---

## Creating these on GitHub directly (next time)

This session couldn't authenticate to GitHub, so the repo below was
prepared locally instead of pushed. To create the repo + these issues
programmatically in a future session, either:

- Authorize the GitHub connector via `claude mcp` / `/mcp` (interactive
  session), then ask Claude to create the repo, push, and file these
  issues via the GitHub MCP tools, or
- Run `gh auth login` in a shell you control, then:
  ```
  gh repo create <org>/sentinel --private --source=. --remote=origin --push
  gh label create infra --color 1D76DB
  gh label create moodle --color 5319E7
  gh label create js-app --color 0E8A16
  gh label create privacy --color D93F0B
  gh label create docs --color FBCA04
  gh milestone create "Foundation" --repo <org>/sentinel
  # ...then gh issue create for each item above
  ```
