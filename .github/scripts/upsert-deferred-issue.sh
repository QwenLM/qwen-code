#!/usr/bin/env bash
set -uo pipefail

# Upserts the round's verified-but-out-of-footprint findings into one
# per-PR tracking issue. Invoked from the review-address report AND
# failure/handoff paths (a failed round must not lose verified findings),
# with WORKDIR/PR/REPO/AUTOFIX_BOT in env and the PAT on gh. Best-effort
# throughout: every failure path warns and exits 0 — persistence must
# never fail a round — but success is only LOGGED when the write call
# actually succeeded.
#
# Durability design: the tracking issue's BODY is written once at
# creation; every later round appends by POSTING A COMMENT — atomic and
# append-only, so no read-modify-write can race a maintainer's edits and
# a lost GET can never be mistaken for an empty history. Deduplication
# reads the body plus the bot's own comments, anchored to the bullet form
# "- rc:<id> " at line start (free-text mentions of an id do not count).

FINDINGS="${WORKDIR}/deferred-findings.json"
[[ -s "${FINDINGS}" ]] || exit 0

# Shape gate: non-empty array; id numeric; reason string; path, when
# present, a string (one malformed sibling must not drop the batch — it
# fails the whole file loudly instead of being silently formatted away).
if ! jq -e 'type == "array" and length > 0 and all(.[];
    (.id | type == "number" and . == floor and . > 0) and (.reason | type == "string")
    and ((.path // "?") | type == "string"))' "${FINDINGS}" > /dev/null 2>&1; then
  echo "::warning::deferred-findings.json is malformed; skipping the follow-up upsert"
  exit 0
fi

MARKER="<!-- autofix-deferred pr=${PR} -->"

# Locate the tracking issue with structured filtering: never a pull
# request, marker matched against the real body (no line-joining), first
# match wins. A lookup failure is a skip, not "no issue" — creating a
# duplicate is worse than deferring persistence one round.
if ! ISSUE_NUM="$(gh api "repos/${REPO}/issues?state=all&creator=${AUTOFIX_BOT}&per_page=100" \
  --paginate 2> /dev/null |
  jq -rs --arg m "${MARKER}" '
    add // [] | map(select((.pull_request | not)
      and ((.body // "") | contains($m)))) | (.[0].number // "") | tostring')"; then
  echo "::warning::deferred-findings lookup failed; skipping the follow-up upsert this round"
  exit 0
fi

KNOWN_FILE="$(mktemp)"
trap 'rm -f "${KNOWN_FILE}"' EXIT
if [[ -n "${ISSUE_NUM}" && "${ISSUE_NUM}" != 'null' ]]; then
  # Known-id corpus = issue body + every comment. Any fetch failure skips
  # the round: treating it as empty would re-append history (or, under
  # the old PATCH design, erase it).
  if ! BODY_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '.body // ""' 2> /dev/null)"; then
    echo "::warning::could not read deferred-findings issue #${ISSUE_NUM}; skipping this round"
    exit 0
  fi
  # Bot-authored comments only: the tracking issue is public, and an
  # arbitrary commenter posting a line-start "- rc:<id> " bullet must not
  # be able to permanently suppress a deferred finding from the corpus.
  if ! COMMENT_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments?per_page=100" \
    --paginate 2> /dev/null | jq -rs --arg bot "${AUTOFIX_BOT}" \
      'add // [] | map(select((.user.login // "") == $bot) | .body // "") | join("\n")')"; then
    echo "::warning::could not read deferred-findings comments on #${ISSUE_NUM}; skipping this round"
    exit 0
  fi
  printf '%s\n%s' "${BODY_TEXT}" "${COMMENT_TEXT}" > "${KNOWN_FILE}"
fi

# Build this round's lines: intra-batch dedupe by id, drop ids the round
# RESOLVED in code (a finding cannot be both implemented and outstanding),
# drop ids already tracked (line-anchored), sanitize path and flatten
# reason (both agent/branch-influenced), cap the batch. The marker
# neutralization matches every other agent-derived publish site.
RESOLVED_RAW=''
[[ -f "${WORKDIR}/resolved-comments.txt" ]] && RESOLVED_RAW="$(cat "${WORKDIR}/resolved-comments.txt")"
# --rawfile, not --arg: a large corpus in one argv element hits Linux
# MAX_ARG_STRLEN and the exec failure would be swallowed into a silent
# "nothing new" exit.
NEW_LINES="$(jq -r --rawfile known "${KNOWN_FILE}" --arg resolved "${RESOLVED_RAW}" '
  ($resolved | split("\n")
    | map(sub("^rc:"; "") | sub("\r$"; "")
      | select(test("^[0-9]+$")) | tonumber)) as $done
  | ($known | split("\n")) as $klines
  | unique_by(.id)
  | map(.id as $id
    | select(($done | index($id)) | not)
    | select(($klines | any(test("^- rc:" + ($id | tostring) + " "))) | not)
    | "- rc:\($id) `\(.path // "?" | gsub("[^A-Za-z0-9._/ -]"; "?") | .[0:200])`: \(.reason | gsub("[\r\n]+"; " ") | .[0:500])")
  | .[]' "${FINDINGS}" 2> /dev/null |
  sed 's/<!--/<!\\-\\-/g')" || NEW_LINES=''
[[ -n "${NEW_LINES}" ]] || exit 0
# Cap in bash, loudly: clipped items are never retried (the workdir is
# deleted at job end), so a silent clip would read as full persistence.
TOTAL_NEW="$(printf '%s\n' "${NEW_LINES}" | wc -l)"
if (( TOTAL_NEW > 20 )); then
  NEW_LINES="$(printf '%s\n' "${NEW_LINES}" | head -n 20)"
  echo "::warning::deferred-findings cap: persisting 20 of ${TOTAL_NEW} new findings; the remaining $(( TOTAL_NEW - 20 )) are NOT persisted (re-defer them in a later round)"
  KEPT=20
else
  KEPT="${TOTAL_NEW}"
fi

if [[ -z "${ISSUE_NUM}" || "${ISSUE_NUM}" == 'null' ]]; then
  BODY="${MARKER}"$'\n\n'"Verified review findings from PR #${PR} whose fixes lie outside that PR's footprint, deferred by the autofix loop for follow-up. A maintainer can turn any item into its own issue/PR (or apply the ready-for-agent flow) — nothing here is scheduled automatically."$'\n\n'"${NEW_LINES}"
  if NUM="$(gh api "repos/${REPO}/issues" \
    -f title="Deferred review findings from PR #${PR}" \
    -f body="${BODY}" --jq '.number' 2> /dev/null)"; then
    echo "🗂 deferred findings tracked in new issue #${NUM} (${KEPT} of ${TOTAL_NEW} new)"
  else
    echo "::warning::could not create the deferred-findings issue for PR #${PR}; findings NOT persisted this round"
  fi
else
  if gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" \
    -f body="${NEW_LINES}" > /dev/null 2>&1; then
    echo "🗂 deferred findings appended to issue #${ISSUE_NUM} (${KEPT} of ${TOTAL_NEW} new)"
  else
    echo "::warning::could not append to deferred-findings issue #${ISSUE_NUM}; findings NOT persisted this round"
  fi
fi
