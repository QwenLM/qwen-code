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

# `jq -e` without -s evaluates each document of a multi-document file in turn
# and its exit status reflects only the LAST one, so a second document can
# hide findings from these gates or smuggle them past. Require exactly one.
single_doc() {
  local n
  n="$(jq -s 'length' "$1" 2> /dev/null)" || return 1
  [[ "${n}" == '1' ]]
}
FINDINGS="${WORKDIR}/deferred-findings.json"
# Both temp files are released by ONE EXIT trap: a later `trap ... EXIT`
# would replace an earlier one and leak the first file.
MERGED=''
KNOWN_FILE=''
GH_ERR=''
EMPTY_RESOLVED=''
trap 'rm -f "${MERGED}" "${KNOWN_FILE}" "${GH_ERR}" "${EMPTY_RESOLVED}"' EXIT
# Every gh call writes its stderr here so the warnings can NAME the cause:
# a rate limit, an expired/rotated PAT, a transport error and a 404 are
# indistinguishable when stderr goes to /dev/null, and these warnings are
# the feature's only signal. Best-effort: with no sink the calls still run,
# they just report "no stderr captured".
GH_ERR="$(mktemp 2> /dev/null || true)"
gh_reason() {
  local r=''
  [[ -n "${GH_ERR}" && -s "${GH_ERR}" ]] &&
    r="$(tr '\r\n\t' '   ' < "${GH_ERR}" | head -c 200)"
  # `::` neutralized like every other agent/API-derived echo: an API error
  # body is not trusted to be free of workflow-command syntax.
  r="$(printf '%s' "${r}" | sed 's/::/;;/g')"
  [[ -n "${r// /}" ]] && printf '%s' "${r}" || printf 'no stderr captured'
}
gh_err_reset() { [[ -n "${GH_ERR}" ]] && : > "${GH_ERR}"; }
# A repair re-run rebuilds the workspace: 'Repair deterministic rejection'
# moves run 1's deferrals to this sidecar so they are not lost when run 2
# writes its own file. Both are unioned below (the line builder dedupes).
CARRY="${WORKDIR}/deferred-findings.carry.json"
# This round's own file, kept under its own name: FINDINGS is repointed at the
# merged set below, and the shape gate needs a valid fallback to retry with.
OWN_FINDINGS="${WORKDIR}/deferred-findings.json"

# Every abort below is PERMANENT for these findings: the eval watermark
# filters this round's feedback out of every later round, and the next run's
# workspace reset deletes the file — nothing re-derives them. So each abort
# says so and dumps what it had, for manual recovery from the run log.
# `::` is neutralized in the dump: the content is agent-influenced and a
# raw `::` at line start would be parsed as a workflow command (same reason
# `<!--` is neutralized at every publish site).
dump_file() {
  [[ -s "$1" ]] || return 0
  local size
  size="$(wc -c < "$1" 2> /dev/null | tr -d ' ')"
  if [[ -n "${size}" ]] && (( size > 4000 )); then
    if [[ "$1" == "${WORKDIR}/"* ]]; then
      echo "--- $1 (first 4000 of ${size} bytes — TRUNCATED; the full file is in this run's artifact dump)"
    else
      # A merge temp lives outside WORKDIR, so it is NOT uploaded — say so
      # rather than point at an artifact that will not contain it.
      echo "--- $1 (first 4000 of ${size} bytes — TRUNCATED; this file is a temporary merge product and is NOT in the artifact dump)"
    fi
  else
    echo "--- $1"
  fi
  head -c 4000 "$1" | sed 's/::/;;/g'
  echo
}
lost() {
  echo "::warning::$1 — these findings are LOST (watermark-gated — no later round re-derives them). Raw deferrals follow for manual recovery:"
  dump_file "${FINDINGS}"
  dump_file "${CARRY}"
}

# A bad OWN file is a total abort; a bad CARRY only costs the carry — the
# same asymmetry the merge-failure path settled on, because this round's
# verified findings must not go down with a corrupt sidecar.
if [[ -s "${FINDINGS}" ]] && ! single_doc "${FINDINGS}"; then
  lost "this round's deferred findings are not a single JSON document"
  exit 0
fi
CARRY_SKIP=''
if [[ -s "${CARRY}" ]] && ! single_doc "${CARRY}"; then
  echo "::warning::the carried deferrals are not a single JSON document; persisting only this round's. The carried set is LOST — raw content follows:"
  dump_file "${CARRY}"
  CARRY_SKIP=1
fi
if [[ -s "${CARRY}" && -z "${CARRY_SKIP}" ]]; then
  if [[ -s "${FINDINGS}" ]]; then
    if ! MERGED="$(mktemp)"; then
      lost 'could not create a temp file to merge the carried deferrals'
      exit 0
    fi
    # This round FIRST: jq's unique_by keeps the first element of each group
    # in original order, so a finding re-emitted by run 2 wins over run 1's
    # carried copy. Swapping these two arguments silently pins the stale text.
    # Both inputs must BE arrays: `add` on two non-arrays yields whatever
    # they add to (or null), which the gate would then judge on its own.
    if jq -se 'if (map(type == "array") | all) then add else empty end' \
      "${FINDINGS}" "${CARRY}" > "${MERGED}" 2> /dev/null; then
      FINDINGS="${MERGED}"
    else
      echo "::warning::could not merge this round's deferrals with the carried sidecar (one of the two is unparseable); persisting only this round's. The carried set is LOST — raw content follows:"
      dump_file "${CARRY}"
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
shape_ok() {
  jq -e 'type == "array" and length > 0 and all(.[];
    (.id | type == "number" and . == floor and . > 0 and . < 9007199254740992
      and (tostring | test("^[0-9]+$")))
    and (.reason | type == "string")
    and ((.source | type) as $t | $t == "null"
      or ($t == "string"
        and (.source | IN("review_comment", "review", "issue_comment"))))
    and (.path | type | . == "null" or . == "string"))' "$1" > /dev/null 2>&1
}
if ! shape_ok "${FINDINGS}"; then
  # A carried sidecar that parses but fails the gate must not take THIS
  # round's valid deferrals down with it — the unparseable-carry branch above
  # already persists this round only, and this is the same situation one step
  # later. Retry with this round's own file when the merged set is the one at
  # fault.
  if [[ "${FINDINGS}" != "${OWN_FINDINGS}" ]] && shape_ok "${OWN_FINDINGS}"; then
    echo "::warning::the carried deferrals are malformed; persisting only this round's. The carried set is LOST — raw content follows:"
    dump_file "${CARRY}"
    FINDINGS="${OWN_FINDINGS}"
  else
  # `.path | type` (not `.path // "?"`): `//` treats false as absent, so a
  # present-but-non-string `false` would otherwise be coerced to "?" against
  # this gate's own "fail loudly" contract.
    lost 'deferred findings are malformed (this round and/or the carried sidecar)'
    exit 0
  fi
fi

MARKER="<!-- autofix-deferred pr=${PR} -->"
TITLE="Deferred review findings from PR #${PR}"

# Locate the tracking issue with structured filtering: never a pull
# request, marker matched against the real body (no line-joining), first
# match wins. A lookup failure is a skip, not "no issue" — creating a
# duplicate is worse than deferring persistence one round.
# Bounded and newest-first, stopping at the first marker match: the
# tracking issue for THIS PR is created during its life, so the common case
# costs ONE request. A full --paginate here re-downloaded every issue the
# bot has ever opened, on every round that defers anything, and that set
# only grows. The page cap bounds the worst case; reaching it without a
# match SKIPS rather than creating a second tracking issue.
LOOKUP_MAX_PAGES=10
ISSUE_NUM=''
lookup_page=1
while (( lookup_page <= LOOKUP_MAX_PAGES )); do
  gh_err_reset
  if ! PAGE_JSON="$(gh api "repos/${REPO}/issues?state=all&creator=${AUTOFIX_BOT}&per_page=100&sort=created&direction=desc&page=${lookup_page}" \
    2> "${GH_ERR:-/dev/null}")"; then
    lost "the tracking-issue lookup failed on page ${lookup_page} ($(gh_reason))"
    exit 0
  fi
  # Two identity anchors: the body marker first, the derived title as a
  # fallback. The marker lives on the one surface maintainers are invited to
  # edit, so an edit that drops it would orphan the issue and the next round
  # would open a duplicate; the title is derived, never authored.
  HIT="$(jq -r --arg m "${MARKER}" --arg t "${TITLE}" '
    (map(select((.pull_request | not)
      and ((.body // "") | contains($m)))) | .[0].number)
    // (map(select((.pull_request | not)
      and ((.title // "") == $t))) | .[0].number)
    // "" | tostring' \
    <<< "${PAGE_JSON}" 2> /dev/null)" || HIT=''
  if [[ -n "${HIT}" && "${HIT}" != 'null' ]]; then
    ISSUE_NUM="${HIT}"
    break
  fi
  # A short page means the corpus is exhausted: no issue exists, so the
  # create path below is correct (not a cap miss).
  PAGE_COUNT="$(jq -r 'length' <<< "${PAGE_JSON}" 2> /dev/null)" || PAGE_COUNT=0
  (( PAGE_COUNT < 100 )) && break
  lookup_page=$(( lookup_page + 1 ))
done
if [[ -z "${ISSUE_NUM}" ]] && (( lookup_page > LOOKUP_MAX_PAGES )); then
  # Scanned the cap without a match and without exhausting the corpus: an
  # older tracking issue may exist beyond it, and a duplicate is worse than
  # deferring persistence.
  lost "the tracking-issue lookup hit its ${LOOKUP_MAX_PAGES}-page cap without finding the marker"
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
  gh_err_reset
  if ! BODY_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '.body // ""' \
    2> "${GH_ERR:-/dev/null}")"; then
    lost "could not read deferred-findings issue #${ISSUE_NUM} ($(gh_reason))"
    exit 0
  fi
  # Bot-authored comments only: the tracking issue is public, and an
  # arbitrary commenter posting a line-start "- rc:<id> " bullet must not
  # be able to permanently suppress a deferred finding from the corpus.
  gh_err_reset
  if ! COMMENT_TEXT="$(gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments?per_page=100" \
    --paginate 2> "${GH_ERR:-/dev/null}" | jq -rs --arg bot "${AUTOFIX_BOT}" \
      'add // [] | map(select((.user.login // "") == $bot) | .body // "") | join("\n")')"; then
    lost "could not read the deferred-findings comments on #${ISSUE_NUM} ($(gh_reason))"
    exit 0
  fi
  printf '%s\n%s' "${BODY_TEXT}" "${COMMENT_TEXT}" > "${KNOWN_FILE}"
fi

# Build this round's lines: intra-batch dedupe by id, drop ids the round
# RESOLVED in code (a finding cannot be both implemented and outstanding),
# drop ids already tracked (line-anchored), sanitize path and flatten
# reason (both agent/branch-influenced), cap the batch. The marker
# neutralization matches every other agent-derived publish site.
# --rawfile for BOTH corpora, not just `known`: resolved-comments.txt grows
# with the round's resolutions and one argv element caps at MAX_ARG_STRLEN,
# the exact failure the note below describes — passing it as --arg left the
# same hole this script already closed once.
RESOLVED_FILE="${WORKDIR}/resolved-comments.txt"
# -f/-r, not just presence: a directory or FIFO planted at this path is
# "there" but unusable as a corpus, and jq --rawfile would fail or block.
if [[ ! -f "${RESOLVED_FILE}" || ! -r "${RESOLVED_FILE}" ]]; then
  if ! RESOLVED_FILE="$(mktemp)"; then
    lost 'could not create a temp file for the resolved-id corpus'
    exit 0
  fi
  EMPTY_RESOLVED="${RESOLVED_FILE}"
fi
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
if ! NEW_LINES="$(jq -r --rawfile known "${KNOWN_FILE}" --rawfile resolved "${RESOLVED_FILE}" '
  # Identity for the multi-finding sources. LOSSLESS on content: only case
  # and PUNCTUATION are normalized, so the tolerance for rewording survives
  # while every letter of every script does too. The earlier form stripped
  # all non-[a-z0-9] bytes and capped at 160 chars, which silently merged
  # CJK siblings (this repo is bilingual) and, on a long path, cut the
  # reason out of the identity altogether — silent loss, the one outcome
  # this feature exists to prevent.
  def normkey:
    ascii_downcase | gsub("[[:punct:]]+"; " ") | gsub("\\s+"; " ")
    | sub("^ "; "") | sub(" $"; "");
  ($resolved | split("\n")
    | map(sub("^\\s+"; "") | sub("\\s+$"; "") | sub("^rc:"; "")
      | select(test("^[0-9]+$")) | tonumber)) as $done
  | ($known | split("\n")) as $klines
  | map(.id as $id
    | ((.source // "review_comment")) as $src
    | (if $src == "review" then "rv"
       elif $src == "issue_comment" then "ic"
       else "rc" end) as $pfx
    | select(($src != "review_comment") or (($done | index($id)) | not))
    | {src: $src, id: $id,
       raw: ((.path // "?") + " " + .reason),
       # The path charset filter already excludes `<`, so the comment opener
       # cannot survive there; the reason is escaped explicitly below.
       line: "- \($pfx):\($id) `\(.path // "?" | gsub("[^A-Za-z0-9._/ -]"; "?") | .[0:200])`: \(.reason
        | gsub("[\r\n]+"; " ")
        | gsub("&(?<ent>#0*(?:64|[xX]0*40);|commat;)"; "&amp;\(.ent)")
        | gsub("@"; "@\u200b")
        # Escape the comment opener HERE, not in a sed after the corpus
        # comparison: the rv/ic identity IS the rendered line, so comparing a
        # raw rendering against the escaped stored form never matches and
        # re-publishes the finding every round.
        | gsub("<!--"; "<!\\-\\-")
        | .[0:500])",
       anchor: ("^- " + $pfx + ":" + ($id | tostring) + " ")}
    # Identity key for the multi-finding sources. NOT the exact line: a
    # reworded re-emission (the repair flow re-runs the agent, so this is
    # routine) would publish a permanent duplicate. NOT the id either — that
    # is what silently ate sibling findings. So: id plus a normalized digest
    # of path+reason — case-folded, punctuation-collapsed, capped — which
    # absorbs whitespace and phrasing churn while keeping genuinely distinct
    # findings apart. Erring toward a visible duplicate over a silent loss.
    # Intra-batch identity from the UNCAPPED text: deriving it from the
    # rendered line let two siblings that differ only past the 500-char reason
    # cap collide and one vanish. The corpus check below still compares
    # rendered forms — that is all the issue stores — so cross-round the cap
    # can cost a duplicate, never a loss.
    | . + {key: (.line | normkey), fullkey: (.raw | normkey)})
  # An inline comment is one finding, so its id IS the identity (and the
  # anchor keeps working across rounds). A review body or an issue-level
  # comment can raise SEVERAL findings under one id, so there the identity —
  # and the corpus check — is the rendered line itself; keying those on the
  # id alone silently ate every sibling but the first.
  | unique_by(if .src == "review_comment" then [.src, .id] else [.src, .id, .fullkey] end)
  | map(. as $r
    | select(if $r.src == "review_comment"
        then ($klines | any(test($r.anchor))) | not
        # Corpus check on the same normalized key, so a reworded sibling of an
        # already-tracked finding is recognised as tracked.
        else ($klines | map(normkey) | index($r.key)) == null end)
    | $r.line)
  | .[]' "${FINDINGS}" 2> /dev/null)"; then
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
# tr -d ' ': BSD/macOS wc pads its count with leading spaces, which would be
# interpolated verbatim into the cap warning and the success message (the
# sibling `wc -c` above already strips it).
TOTAL_NEW="$(printf '%s\n' "${NEW_LINES}" | wc -l | tr -d ' ')"
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
  gh_err_reset
  if NUM="$(gh api "repos/${REPO}/issues" \
    -f title="${TITLE}" \
    -f body="${BODY}" --jq '.number' 2> "${GH_ERR:-/dev/null}")"; then
    echo "🗂 deferred findings tracked in new issue #${NUM} (${KEPT} of ${TOTAL_NEW} new)"
  else
    # Not "this round": the eval watermark filters this round's feedback out
    # of every later round, so nothing retries. Name the lost items.
    echo "::warning::could not create the deferred-findings issue for PR #${PR} ($(gh_reason)); these findings are LOST (watermark-gated — no later round re-derives them). A maintainer should file them:"
    printf '%s\n' "${NEW_LINES}"
  fi
else
  gh_err_reset
  if gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" \
    -f body="${NEW_LINES}" > /dev/null 2> "${GH_ERR:-/dev/null}"; then
    echo "🗂 deferred findings appended to issue #${ISSUE_NUM} (${KEPT} of ${TOTAL_NEW} new)"
  else
    echo "::warning::could not append to deferred-findings issue #${ISSUE_NUM} ($(gh_reason)); these findings are LOST (watermark-gated — no later round re-derives them). A maintainer should add them:"
    printf '%s\n' "${NEW_LINES}"
  fi
fi
