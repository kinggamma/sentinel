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
# only in $SESSION, passed to the smoke process by environment. Borrowing a
# real account's identity is still the weak point here rather than the key
# handling: concurrent runs each mint their own session key (no collision on
# that front), but they do both act as the same borrowed human, which a
# dedicated smoke-test user would remove. That user doesn't exist yet — this
# script is the guard until it does.
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="$(./scripts/seed-smoke-session.sh)"
if [ -z "$SESSION" ]; then
  echo "seed-smoke-session.sh returned no session key" >&2
  exit 1
fi

cleanup() {
  ./scripts/seed-smoke-session.sh --clear "$SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

GLITCHTIP_SESSION="$SESSION" bash -c 'cd receiver && npm run smoke'
