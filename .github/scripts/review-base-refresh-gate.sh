#!/usr/bin/env bash
# Decide whether an automatic `synchronize` review round may be skipped
# because the push only refreshed the base branch (#10111): an update-branch
# merge fires `synchronize` like any push, but a full automatic round costs
# hours for a head whose PR-side diff is unchanged.
#
# Two facts are certified before any review compute is spent: every
# first-parent commit since the head the last completed automatic round
# reviewed is a two-parent merge of the base branch, and the PR's own
# three-dot diff kept the same canonical digest — every changed and
# context byte is hashed after stripping only unstable diff metadata
# (index lines, hunk offsets), so an upstream edit touching the PR's own
# hunks (whitespace included) fails the equality and the full round runs.
# The reviewed head is the newest SUBMITTED ledger-marked review
# (APPROVED, CHANGES_REQUESTED, or COMMENTED, with a submitted_at) posted
# by the AUTHENTICATED account — resolved live via `gh api user`, same
# norm as the fallback dedup — so a participant posting the marker text
# in their own review, a PENDING draft, or a DISMISSED review can never
# certify a head this gate would skip.
#
# Fail-open contract: every probe error or unmatched shape records
# skip=false and the full round runs, and the script never exits non-zero —
# the caller treats a step failure as a pipeline failure worth a fallback
# comment, which a skipped gate is not.
#
# Outputs (GITHUB_OUTPUT): skip=true|false, reviewed_sha, reason.
set -uo pipefail

# Required environment, restated so a misconfigured caller dies naming the
# missing input instead of probing git with empty arguments.
PR_NUMBER="${PR_NUMBER:?}"
EVENT_HEAD_SHA="${EVENT_HEAD_SHA:?}"
BASE_REF="${BASE_REF:?}"
RUN_URL="${RUN_URL:?}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:?}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:?}"

SKIP=false
REVIEWED_SHA=''
REASON=''

# Canonical digest of the diff between two commits: every changed and
# context byte is hashed, stripping only unstable metadata (index lines,
# hunk offsets). `git patch-id` is whitespace-insensitive and would
# certify an indentation-only rewrite of PR-owned lines.
diff_digest() {
  local diff
  diff="$(git diff "$1" "$2" 2>/dev/null)" || return 1
  [[ -n "${diff}" ]] || return 0
  printf '%s\n' "${diff}" |
    sed -E '/^index [0-9a-f]+\.\.[0-9a-f]+/d; /^@@ /d' |
    git hash-object --stdin
}

decide() {
  REASON='pr head fetch failed'
  git fetch --no-tags --quiet origin "refs/pull/${PR_NUMBER}/head" || return
  REASON='event head not reachable from the PR head ref'
  git cat-file -e "${EVENT_HEAD_SHA}^{commit}" 2>/dev/null || return
  REASON='base branch ref unavailable'
  if ! git rev-parse -q --verify "origin/${BASE_REF}^{commit}" >/dev/null; then
    git fetch --no-tags --quiet origin "${BASE_REF}" || return
    git rev-parse -q --verify "origin/${BASE_REF}^{commit}" >/dev/null || return
  fi

  REASON='reviewed-head lookup failed'
  local bot_login reviews
  bot_login="$(gh api user --jq '.login')" && [[ -n "${bot_login}" ]] || return
  reviews="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" --method GET --paginate -F per_page=100)" || return
  REVIEWED_SHA="$(
    printf '%s' "${reviews}" | jq -sr --arg login "${bot_login}" '
      [.[][]
       | select(.user.login == $login)
       | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED"
                or .state == "COMMENTED")
       | select(.submitted_at != null)
       | select((.body // "") | contains("<!-- qwen-review-ledger"))]
      | last | .commit_id // empty'
  )" || return
  REASON='no completed automatic round on this PR'
  [[ -n "${REVIEWED_SHA}" ]] || return
  REASON='reviewed head not in the fetched history'
  git cat-file -e "${REVIEWED_SHA}^{commit}" 2>/dev/null || return
  REASON='reviewed head is not an ancestor of the pushed head'
  git merge-base --is-ancestor "${REVIEWED_SHA}" "${EVENT_HEAD_SHA}" 2>/dev/null || return

  # Bounded walk: a stale reviewed head must not buy an unbounded ancestry
  # scan, and past ten first-parent steps this is not the cheap shape the
  # gate exists for anyway.
  local count c p2
  REASON='commit walk failed'
  count="$(git rev-list --first-parent --count "${REVIEWED_SHA}..${EVENT_HEAD_SHA}" 2>/dev/null)" || return
  [[ "${count}" =~ ^[0-9]+$ ]] || return
  REASON='no new commits since the reviewed head'
  [[ "${count}" -ge 1 ]] || return
  REASON="too many commits since the reviewed head (${count})"
  [[ "${count}" -le 10 ]] || return
  for c in $(git rev-list --first-parent "${REVIEWED_SHA}..${EVENT_HEAD_SHA}" 2>/dev/null); do
    REASON="non-merge commit since the reviewed head: ${c}"
    p2="$(git rev-parse -q --verify "${c}^2" 2>/dev/null)" || return
    REASON="octopus merge since the reviewed head: ${c}"
    if git rev-parse -q --verify "${c}^3" >/dev/null 2>&1; then return; fi
    REASON="merge of a non-base branch since the reviewed head: ${c}"
    git merge-base --is-ancestor "${p2}" "origin/${BASE_REF}" 2>/dev/null || return
  done

  local mb_r mb_h digest_r digest_h
  REASON='merge-base resolution failed'
  mb_r="$(git merge-base "origin/${BASE_REF}" "${REVIEWED_SHA}" 2>/dev/null)" || return
  mb_h="$(git merge-base "origin/${BASE_REF}" "${EVENT_HEAD_SHA}" 2>/dev/null)" || return
  REASON='PR-side diff computation failed'
  digest_r="$(diff_digest "${mb_r}" "${REVIEWED_SHA}")" || return
  digest_h="$(diff_digest "${mb_h}" "${EVENT_HEAD_SHA}")" || return
  REASON='empty PR-side diff'
  { [[ -n "${digest_r}" ]] && [[ -n "${digest_h}" ]]; } || return
  REASON='the PR-side diff changed'
  [[ "${digest_r}" = "${digest_h}" ]] || return

  REASON=''
  SKIP=true
}
decide

{
  echo "skip=${SKIP}"
  echo "reviewed_sha=${REVIEWED_SHA}"
  echo "reason=${REASON}"
} >> "${GITHUB_OUTPUT}"
if [[ "${SKIP}" != 'true' ]]; then
  echo "Base-refresh gate: full round proceeds (${REASON})." >> "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
echo "Base-refresh gate: head ${EVENT_HEAD_SHA} only merges ${BASE_REF} into reviewed head ${REVIEWED_SHA}; skipping the automatic round." >> "${GITHUB_STEP_SUMMARY}"

# One marker-deduped note per PR, updated in place via the shared upsert
# helper (author-scoped lookup, retried). Blank line after the marker, or
# none of the prose renders — the HTML-block quirk the ack comment documents.
# Note failures only warn: the skip decision is already recorded above.
body_file="$(mktemp "${RUNNER_TEMP:-/tmp}/qwen-review-base-refresh.XXXXXX")" || exit 0
# shellcheck disable=SC2016
printf '<!-- qwen-review-base-refresh -->\n\n🔁 **Base refresh detected** — head `%s` only merges `%s` into the last reviewed head `%s`; the PR-side diff is unchanged, so that review still applies and no new automatic round was spent ([this run](%s)). Comment `@qwen-code /review` for a fresh full review.\n\n<details>\n<summary>中文说明</summary>\n\n🔁 **检测到 base 刷新** —— head `%s` 仅把 `%s` 合入上次已评审的 head `%s`,PR 侧 diff 未变,原有评审结论仍然适用,本次未消耗新的自动评审轮次([本次运行](%s))。如需全新完整评审,请评论 `@qwen-code /review`。\n\n</details>' \
  "${EVENT_HEAD_SHA}" "${BASE_REF}" "${REVIEWED_SHA}" "${RUN_URL}" \
  "${EVENT_HEAD_SHA}" "${BASE_REF}" "${REVIEWED_SHA}" "${RUN_URL}" > "${body_file}"
"$(dirname "${BASH_SOURCE[0]}")/upsert-bot-comment.sh" \
  "${GITHUB_REPOSITORY}" "${PR_NUMBER}" '<!-- qwen-review-base-refresh -->' "${body_file}" \
  || echo "::warning::could not post the base-refresh note"
rm -f "${body_file}"
exit 0
