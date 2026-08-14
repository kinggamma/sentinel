#!/usr/bin/env bash
# Seed a session, run the smoke suite, always clear the session after —
# even if the suite fails, or this script is interrupted.
#
#   ./scripts/run-smoke.sh
#   BASE_URL=http://host:8100 ./scripts/run-smoke.sh
#
# The manual three-step version (seed, run, clear) left the borrowed session
# alive whenever the middle step failed or the terminal was closed early.
# `trap` here runs on a normal exit, a failing exit, and Ctrl-C alike, so a
# skipped clear can't happen just because npm run smoke returned non-zero.
#
# The session key itself is never echoed to the terminal or a log — it lives
# only in $SESSION, passed to the smoke process by environment. It now belongs
# to a dedicated account signed in through allauth rather than a borrowed
# human, so a run can no longer act as a real person, and can no longer break
# because that person turned on MFA.
set -euo pipefail
cd "$(dirname "$0")/.."

read -r SESSION ORG < <(./scripts/seed-smoke-session.sh)
if [ -z "${SESSION:-}" ]; then
  echo "seed-smoke-session.sh returned no session key" >&2
  exit 1
fi

cleanup() {
  ./scripts/seed-smoke-session.sh --clear "$SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The organisation travels with the session: the suite writes to one, and
# hardcoding it would name a real installation's own organisation in the repo.
GLITCHTIP_SESSION="$SESSION" GLITCHTIP_ORG="$ORG" bash -c 'cd receiver && npm run smoke'
