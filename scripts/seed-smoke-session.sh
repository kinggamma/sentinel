#!/usr/bin/env bash
# Mint a throwaway GlitchTip session so the smoke tests can exercise the
# session and CSRF paths, which are otherwise unreachable without a password.
#
#   export GLITCHTIP_SESSION=$(./scripts/seed-smoke-session.sh)
#   ( cd receiver && npm run smoke )
#   ./scripts/seed-smoke-session.sh --clear "$GLITCHTIP_SESSION"
#
# It borrows the first active account rather than creating one: the point is
# to test the plumbing, not to leave users lying around.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--clear" ]; then
  docker compose exec -T glitchtip-web ./manage.py shell -c "
from importlib import import_module
from django.conf import settings
import_module(settings.SESSION_ENGINE).SessionStore(session_key='${2:?session key required}').delete()
print('cleared')" 2>/dev/null | tail -1
  exit 0
fi

docker compose exec -T glitchtip-web ./manage.py shell -c '
from django.contrib.auth import get_user_model
from importlib import import_module
from django.conf import settings
u = get_user_model().objects.filter(is_active=True).order_by("id").first()
if not u:
    raise SystemExit("no active user to borrow a session from")
S = import_module(settings.SESSION_ENGINE).SessionStore
s = S()
s["_auth_user_id"] = str(u.pk)
s["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
s["_auth_user_hash"] = u.get_session_auth_hash()
s.create()
print("KEY:" + s.session_key)' 2>/dev/null | grep -o 'KEY:.*' | cut -d: -f2
