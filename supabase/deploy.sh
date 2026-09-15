#!/usr/bin/env bash
#
# Deploy the one Edge Function every AI feature goes through.
#
# Until this runs, the extension has no AI at all: ads are never watched, so
# they are never scored, and Discover falls back to counting words in the
# caption. All three look like separate broken features; they are one missing
# deployment.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... bash supabase/deploy.sh
#
# Optional, for the testing phase - lets the extension work with nobody signed
# in. Read the ALLOW_ANON section of supabase/README.md before using it: while
# it is on, anyone holding the publishable key can spend your Anthropic budget,
# and the per-user meter does not apply.
#   ALLOW_ANON=true ANTHROPIC_API_KEY=sk-ant-... bash supabase/deploy.sh

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-jkshbnmqyyrafszagxiq}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "The Supabase CLI is not installed."
  echo "  macOS:  brew install supabase/tap/supabase"
  echo "  other:  https://supabase.com/docs/guides/local-development/cli/getting-started"
  exit 1
fi

# `supabase link` needs an authenticated CLI, and its failure message when you
# are not logged in is not obvious.
if ! supabase projects list >/dev/null 2>&1; then
  echo "The Supabase CLI is not logged in. Run this first, then re-run me:"
  echo "  supabase login"
  exit 1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set."
  echo "Get one at https://console.anthropic.com/settings/keys, then:"
  echo "  ANTHROPIC_API_KEY=sk-ant-... bash supabase/deploy.sh"
  exit 1
fi

cd "$(dirname "$0")/.."

echo "==> Linking project $PROJECT_REF"
supabase link --project-ref "$PROJECT_REF" >/dev/null

echo "==> Setting the Anthropic key as a secret"
# The key is set server-side and read from the environment. It is never
# returned, logged, or echoed in an error, and it never enters the extension.
supabase secrets set "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >/dev/null

if [ "${ALLOW_ANON:-}" = "true" ]; then
  echo "==> Allowing signed-out use (see supabase/README.md for what this costs)"
  supabase secrets set ALLOW_ANON=true >/dev/null
  VERIFY_FLAG="--no-verify-jwt"
else
  VERIFY_FLAG=""
fi

echo "==> Deploying the function"
# shellcheck disable=SC2086
supabase functions deploy claude $VERIFY_FLAG

URL="https://${PROJECT_REF}.supabase.co/functions/v1/claude"
echo
echo "==> Checking it answers"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H 'content-type: application/json' -d '{}' --max-time 25 || echo "000")

case "$CODE" in
  404) echo "FAILED: still 404. The deploy did not take; re-read the output above." ; exit 1 ;;
  000) echo "Could not reach it. Check the network and try the curl by hand." ; exit 1 ;;
  # 400 or 401 both mean the function is live and rejected an empty body, which
  # is exactly what it should do.
  *)   echo "Deployed. It answers HTTP $CODE to an empty request, which is correct." ;;
esac

echo "Now open the dashboard. It re-queues every unscored ad on load, so the"
echo "ads you have already saved will be watched and scored without re-saving."
echo
echo "Settings should now show a green 'AI function deployed' row. If it does"
echo "not, the extension is holding a stale service worker: reload it at"
echo "chrome://extensions and reopen the dashboard."
