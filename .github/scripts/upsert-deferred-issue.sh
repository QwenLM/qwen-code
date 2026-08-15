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

# Defensive: a $GITHUB_ENV-planted SHELLOPTS=noclobber is imported by every
# child bash and is read-only (no unset removes it), which would make the
# KNOWN_FILE `>` redirect below fail and silently empty the dedupe corpus.
# The workflow runs this via a clean `env -i` child (SHELLOPTS dropped), but
# clear it here too so the script is safe under any caller.
set +C

FINDINGS="${WORKDIR}/deferred-findings.json"
# Both temp files are released by ONE EXIT trap: a later `trap ... EXIT`
# would replace an earlier one and leak the first file.
MERGED=''
KNOWN_FILE=''
trap 'rm -f "${MERGED}" "${KNOWN_FILE}"' EXIT
# A repair re-run rebuilds the workspace: 'Repair deterministic rejection'
# moves run 1's deferrals to this sidecar so they are not lost when run 2
# writes its own file. Both are unioned below (the line builder dedupes).
CARRY="${WORKDIR}/deferred-findings.carry.json"

# Every abort below is PERMANENT for these findings: the eval watermark
# filters this round's feedback out of every later round, and the next run's
# workspace reset deletes the file — nothing re-derives them. So each abort
# says so and dumps what it had, for manual recovery from the run log.
# `::` is neutralized in the dump: the content is agent-influenced and a
# raw `::` at line start would be parsed as a workflow command (same reason
# `<!--` is neutralized at every publish site).
lost() {
  echo "::warning::$1 — these findings are LOST (watermark-gated — no later round re-derives them). Raw deferrals follow for manual recovery:"
  for f in "${FINDINGS}" "${CARRY}"; do
    [[ -s "${f}" ]] || continue
    echo "--- ${f}"
    head -c 4000 "${f}" | sed 's/::/;;/g'
    echo
  done
}

if [[ -s "${CARRY}" ]]; then
  if [[ -s "${FINDINGS}" ]]; then
    if ! MERGED="$(mktemp)"; then
      lost 'could not create a temp file to merge the carried deferrals'
      exit 0
    fi
    if jq -s 'add' "${FINDINGS}" "${CARRY}" > "${MERGED}" 2> /dev/null; then
      FINDINGS="${MERGED}"
    else
      echo "::warning::could not merge the carried deferrals; persisting only this round's (the carried ones are dumped below)"
      head -c 4000 "${CARRY}" | sed 's/::/;;/g'
      echo
    fi
  else
    FINDINGS="${CARRY}"
  fi
fi
[[ -s "${FINDINGS}" ]] || exit 0

# An empty array is the contract-valid "nothing to defer" rendering (SKILL
# defines the file as a JSON array): a clean no-op, not a corruption alarm.
if jq -e 'type == "array" and length == 0' "${FINDINGS}" > /dev/null 2>&1; then
  exit 0
fi

# Shape gate: non-empty array; id a positive integer that renders as PLAIN
# digits; reason string; path, when present, a string (one malformed sibling
# must not drop the batch — it fails the whole file loudly instead of being
# silently formatted away). The `tostring | test("^[0-9]+$")` belt rejects
# integer-valued floats that jq renders in scientific notation past 2^53
# (e.g. 1e21 -> "1e+21"): the "+" is a regex-active byte in the line-anchored
# dedupe below and never index-matches an integer resolved id. Comment ids
# are ~10 digits, far under the bound.
if ! jq -e 'type == "array" and length > 0 and all(.[];
    (.id | type == "number" and . == floor and . > 0 and . < 9007199254740992
      and (tostring | test("^[0-9]+$")))
    and (.reason | type == "string")
    and ((.source | type) as $t | $t == "null"
      or ($t == "string"
        and (.source | IN("review_comment", "review", "issue_comment"))))
    and (.path | type | . == "null" or . == "string"))' "${FINDINGS}" > /dev/null 2>&1; then
  # `.path | type` (not `.path // "?"`): `//` treats false as absent, so a
  # present-but-non-string `false` would otherwise be coerced to "?" against
  # this gate's own "fail loudly" contract.
  lost 'deferred findings are malformed (this round and/or the carried sidecar)'
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
  lost 'the tracking-issue lookup failed'
  exit 0
fi

if ! KNOWN_FILE="$(mktemp)"; then
  # A silent exit here would violate the header contract (every failure
  # warns) and is exactly when visibility matters — /tmp exhaustion is a
  # known CI state.
  lost 'could not create a temp file for the dedupe corpus'
  exit 0
fi
if [[ -n "${ISSUE_NUM}" && "${ISSUE_NUM}" != 'null' ]]; then
  # Known-id corpus = issue body + every comment. Any fetch failure skips
  # the round: treating it as empty would re-append history (or, under
  # the old PATCH design, erase it).
  if ! BODY_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '.body // ""' 2> /dev/null)"; then
    lost "could not read deferred-findings issue #${ISSUE_NUM}"
    exit 0
  fi
  # Bot-authored comments only: the tracking issue is public, and an
  # arbitrary commenter posting a line-start "- rc:<id> " bullet must not
  # be able to permanently suppress a deferred finding from the corpus.
  if ! COMMENT_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments?per_page=100" \
    --paginate 2> /dev/null | jq -rs --arg bot "${AUTOFIX_BOT}" \
      'add // [] | map(select((.user.login // "") == $bot) | .body // "") | join("\n")')"; then
    lost "could not read the deferred-findings comments on #${ISSUE_NUM}"
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
#
# The reason is agent-influenced prose published under the bot identity, so
# it is mention-defused before rendering: `@` gets a trailing ZWSP, and the
# entity spellings GitHub decodes BEFORE its mention filter (&#64; &#x40;
# &#0064; &commat;) get their `&` escaped — both measured inert against the
# real renderer; `\@` and bare entity-escaping are NOT. Paths are already
# reduced to a safe charset (no `@` survives).
if ! NEW_LINES="$(jq -r --rawfile known "${KNOWN_FILE}" --arg resolved "${RESOLVED_RAW}" '
  ($resolved | split("\n")
    | map(sub("^rc:"; "") | sub("\r$"; "")
      | select(test("^[0-9]+$")) | tonumber)) as $done
  | ($known | split("\n")) as $klines
  | unique_by([(.source // "review_comment"), .id])
  | map(.id as $id
    | ((.source // "review_comment")) as $src
    | (if $src == "review" then "rv"
       elif $src == "issue_comment" then "ic"
       else "rc" end) as $pfx
    | select(($src != "review_comment") or (($done | index($id)) | not))
    | select(($klines | any(test("^- " + $pfx + ":" + ($id | tostring) + " "))) | not)
    | "- \($pfx):\($id) `\(.path // "?" | gsub("[^A-Za-z0-9._/ -]"; "?") | .[0:200])`: \(.reason
        | gsub("[\r\n]+"; " ")
        | gsub("&(?<ent>#0*(?:64|[xX]0*40);|commat;)"; "&amp;\(.ent)")
        | gsub("@"; "@\u200b")
        | .[0:500])")
  | .[]' "${FINDINGS}" 2> /dev/null |
  sed 's/<!--/<!\\-\\-/g')"; then
  # The only remaining silent-exit path: a jq/sed failure here would leave
  # NEW_LINES empty and read as "nothing new". Warn, per the header contract.
  lost 'could not build the deferred-findings lines'
  exit 0
fi
[[ -n "${NEW_LINES}" ]] || exit 0
# Cap in bash, loudly. Clipped items are NOT recoverable automatically: the
# eval-watermark permanently filters this round's evaluated feedback out of
# every later round, so the agent never re-derives the clipped ids. The
# warning names them for a maintainer to persist by hand (or raise the cap);
# it must not imply a later round will re-defer them.
TOTAL_NEW="$(printf '%s\n' "${NEW_LINES}" | wc -l)"
if (( TOTAL_NEW > 20 )); then
  DROPPED="$(printf '%s\n' "${NEW_LINES}" | tail -n +21)"
  NEW_LINES="$(printf '%s\n' "${NEW_LINES}" | head -n 20)"
  echo "::warning::deferred-findings cap: persisting 20 of ${TOTAL_NEW} new findings; the remaining $(( TOTAL_NEW - 20 )) will NOT be re-evaluated (watermark-gated) — a maintainer should persist them or raise the cap. Dropped:"
  printf '%s\n' "${DROPPED}"
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
    # Not "this round": the eval watermark filters this round's feedback out
    # of every later round, so nothing retries. Name the lost items.
    echo "::warning::could not create the deferred-findings issue for PR #${PR}; these findings are LOST (watermark-gated — no later round re-derives them). A maintainer should file them:"
    printf '%s\n' "${NEW_LINES}"
  fi
else
  if gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" \
    -f body="${NEW_LINES}" > /dev/null 2>&1; then
    echo "🗂 deferred findings appended to issue #${ISSUE_NUM} (${KEPT} of ${TOTAL_NEW} new)"
  else
    echo "::warning::could not append to deferred-findings issue #${ISSUE_NUM}; these findings are LOST (watermark-gated — no later round re-derives them). A maintainer should add them:"
    printf '%s\n' "${NEW_LINES}"
  fi
fi
