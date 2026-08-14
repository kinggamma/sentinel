#!/usr/bin/env bash
# Mint a session for the smoke suite, by signing a dedicated test account in
# through allauth exactly as a browser would.
#
#   ./scripts/run-smoke.sh                      # the wrapper; prefer this
#   read KEY ORG < <(./scripts/seed-smoke-session.sh)
#   ./scripts/seed-smoke-session.sh --clear "$KEY"
#   ./scripts/seed-smoke-session.sh --destroy   # remove the account entirely
#
# Two things changed here, and both were load-bearing.
#
# It no longer borrows the first real account it finds. That was always a
# stated weakness — every run acted as a real person — and it becomes an
# outright break the moment that person turns on MFA or registers a passkey,
# because the login stops completing and every session-authenticated test
# starts failing for a reason that has nothing to do with the code.
#
# And it no longer writes a session into the store by hand. A hand-made
# session is a valid *Django* login with no allauth record, and allauth
# reports on the login it performed rather than on the cookie it was handed —
# so /api/0/ answers 200 for it while /_allauth/ answers 401. Sentinel's
# identity now derives from allauth, so a hand-made session would read as
# anonymous and the suite would test nothing. Signing in properly is the only
# way to get a session that both backends agree about.
#
# The password is generated per run, used immediately, and never stored. It
# reaches the container by environment rather than argv, so it does not appear
# in a process list. The session key is printed on stdout because the caller
# needs it; run-smoke.sh keeps it in a variable and clears it on any exit.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:8000}"
# example.com, not the .invalid TLD that RFC 2606 reserves for exactly this.
# GlitchTip validates the email in its *response* schema, and that validator
# rejects reserved TLDs — so the textbook-correct choice made /api/0/users/me/
# return 500 for its own user. example.com is reserved too, and passes.
SMOKE_EMAIL="${SMOKE_EMAIL:-sentinel-smoke@example.com}"

gt() { docker compose exec -T "$@"; }

# --------------------------------------------------------------- clear

if [ "${1:-}" = "--clear" ]; then
  gt glitchtip-web ./manage.py shell -c "
from importlib import import_module
from django.conf import settings
import_module(settings.SESSION_ENGINE).SessionStore(session_key='${2:?session key required}').delete()
print('cleared')" 2>/dev/null | tail -1
  exit 0
fi

if [ "${1:-}" = "--destroy" ]; then
  SMOKE_EMAIL="$SMOKE_EMAIL" gt -e SMOKE_EMAIL glitchtip-web ./manage.py shell -c "
import os
from django.contrib.auth import get_user_model
removed = get_user_model().objects.filter(email=os.environ['SMOKE_EMAIL']).delete()
print('destroyed', removed)" 2>/dev/null | tail -1
  exit 0
fi

# ---------------------------------------------------------------- seed

# Sign-in through the receiver is narrowed to one organisation when
# GLITCHTIP_ORG is set, so the account has to be a member of that one
# specifically — any other organisation would be refused before it got
# anywhere. Read from the running receiver rather than from .env, because the
# running process is what actually decides.
ORG="$(gt feedback-receiver printenv GLITCHTIP_ORG 2>/dev/null | tr -d '\r' || true)"

PASSWORD="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"

ORG_SLUG="$(
  SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PASSWORD="$PASSWORD" SMOKE_ORG="$ORG" \
  gt -e SMOKE_EMAIL -e SMOKE_PASSWORD -e SMOKE_ORG glitchtip-web ./manage.py shell -c "
import os
from django.apps import apps
from django.contrib.auth import get_user_model

# Looked up through the app registry rather than imported by module path:
# the models live under the organizations_ext app label but not at an
# importable organizations_ext.models, and the registry is stable either way.
Organization = apps.get_model('organizations_ext', 'Organization')
MEMBER = 0  # role choices: 0 Member, 1 Admin, 2 Manager, 3 Owner

email = os.environ['SMOKE_EMAIL']
User = get_user_model()

user, _ = User.objects.get_or_create(email=email, defaults={'is_active': True})
user.is_active = True
# Fresh every run, so a leaked one is worthless by the next. This also resets
# the session auth hash, which signs out any session left over from a run that
# died before it could clean up.
user.set_password(os.environ['SMOKE_PASSWORD'])
user.save()

# This account exists to be signed in by a script. A second factor on it would
# be nobody's intention and would silently break every run, so it is removed
# rather than worked around.
try:
    from allauth.mfa.models import Authenticator
    Authenticator.objects.filter(user=user).delete()
except Exception:
    pass

wanted = os.environ.get('SMOKE_ORG') or ''
org = Organization.objects.filter(slug=wanted).first() if wanted else Organization.objects.order_by('id').first()
if org is None:
    raise SystemExit('SEED_ERROR no organisation to join')

# Lowest role there is: this account signs in and reads, and should never be
# able to approve anyone or change what an organisation is.
if not org.organization_users.filter(user=user).exists():
    org.organization_users.create(user=user, role=MEMBER)

print('SEED_ORG=' + org.slug)
" 2>/dev/null | grep '^SEED_ORG=' | cut -d= -f2
)"

if [ -z "$ORG_SLUG" ]; then
  echo "could not prepare the smoke account — is the stack up?" >&2
  exit 1
fi

# --- sign in the way a browser does ------------------------------------
#
# allauth wants the CSRF cookie it just issued echoed back on the POST, so the
# session it creates is one it has a record of. That record is the entire
# point: it is what makes /_allauth/ and /api/0/ agree about this cookie.
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

curl -s -c "$JAR" -o /dev/null "$BASE_URL/_allauth/browser/v1/auth/session" || true
CSRF="$(awk '$6 == "csrftoken" { print $7 }' "$JAR" | tail -1)"

STATUS="$(
  curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' \
    -X POST "$BASE_URL/_allauth/browser/v1/auth/login" \
    -H "content-type: application/json" \
    -H "x-csrftoken: ${CSRF:-}" \
    -H "referer: $BASE_URL/" \
    --data "$(printf '{"email":%s,"password":%s}' \
      "$(printf '%s' "$SMOKE_EMAIL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$PASSWORD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
)"

KEY="$(awk '$6 == "sessionid" { print $7 }' "$JAR" | tail -1)"

if [ -z "$KEY" ]; then
  echo "allauth login did not return a session (HTTP $STATUS)" >&2
  exit 1
fi

printf '%s %s\n' "$KEY" "$ORG_SLUG"
