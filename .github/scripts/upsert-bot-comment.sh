#!/usr/bin/env bash
# Upsert a marker-identified bot comment on a PR/issue.
#
# One implementation of the marker+author upsert protocol, shared by the
# docs-only relay and the stale-badge supersede step in
# qwen-code-pr-review.yml (the previous per-step copies had already drifted:
# one had retry/null-guards/dynamic login, the other none). The lookup is
# author-scoped — only comments by the authenticated login are upsert
# targets, so a participant posting the marker can never capture the upsert.
#
# A FAILED lookup is never treated as an EMPTY result: posting on a failed
# listing is how a transient 5xx mints a permanent duplicate (later runs
# PATCH only the `last` match), so every prerequisite — the authenticated
# login and the listing — is re-resolved inside the retry loop, and an
# attempt whose prerequisites failed retries instead of falling through to
# POST. On --update-only, a failed lookup exits 1 (the caller's warning
# path), never the no-op success reserved for a lookup that genuinely
# found nothing.
#
# Usage: upsert-bot-comment.sh <owner/repo> <issue-number> <marker> <body-file> [--update-only]
#   --update-only: PATCH an existing bot-authored marker comment if present;
#                  succeed as a no-op when none exists (never POSTs). For
#                  superseding a badge without minting one where none was.
# Exit codes: 0 posted/updated/no-op; 1 all attempts failed.
set -euo pipefail

repo="${1:?usage: upsert-bot-comment.sh <owner/repo> <issue-number> <marker> <body-file> [--update-only]}"
number="${2:?missing issue number}"
marker="${3:?missing marker}"
body_file="${4:?missing body file}"
update_only="${5:-}"

body="$(cat "${body_file}")"

for _attempt in 1 2 3; do
  if bot_login="$(gh api user --jq '.login')" \
    && [ -n "${bot_login}" ] \
    && listing="$(gh api "repos/${repo}/issues/${number}/comments" \
      --method GET \
      --paginate \
      -F per_page=100)" \
    && existing_id="$(printf '%s' "${listing}" \
      | jq -sr --arg bot "${bot_login}" --arg marker "${marker}" '[.[][]
          | select((.user.login // "") == $bot)
          | select((.body // "") | contains($marker))]
        | last | .id // empty')"; then
    if [ -n "${existing_id}" ]; then
      if gh api --method PATCH \
        "repos/${repo}/issues/comments/${existing_id}" \
        -f body="${body}" >/dev/null; then
        echo "updated comment ${existing_id}"
        exit 0
      fi
    elif [ "${update_only}" = "--update-only" ]; then
      echo "no existing comment; nothing to update"
      exit 0
    elif gh api "repos/${repo}/issues/${number}/comments" \
      -f body="${body}" >/dev/null; then
      echo "posted new comment"
      exit 0
    fi
  fi
  sleep 10
done
echo "all attempts failed" >&2
exit 1
