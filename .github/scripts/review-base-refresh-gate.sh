#!/usr/bin/env bash
# Decide whether an automatic `synchronize` review round may be skipped
# because the push only refreshed the base branch (#10111): an update-branch
# merge fires `synchronize` like any push, but a full automatic round costs
# hours for a head whose PR-side diff is unchanged.
#
# Two facts are certified before any review compute is spent: every
# first-parent commit since the head the last completed automatic round
# reviewed is a two-parent merge of the base branch whose tree equals
# its parents' clean merge (a commit-tree-crafted merge relocating the
# reviewed hunks fails open), and the PR's own three-dot diff kept the
# same canonical digest — every changed and
# context byte is hashed, binary bytes included (--binary renders them as
# content-carrying GIT binary patches, not the content-free "Binary files
# ... differ" marker), after stripping only unstable diff metadata (index
# lines, hunk offsets), so an upstream edit touching the PR's own hunks
# (whitespace included) fails the equality and the full round runs.
#
# The reviewed head is the newest SUBMITTED bot review carrying a ledger
# marker (APPROVED, CHANGES_REQUESTED, or COMMENTED, with a submitted_at)
# posted by the AUTHENTICATED account — resolved live via `gh api user`,
# same norm as the fallback dedup — so a participant posting the marker
# text in their own review, a PENDING draft, or a DISMISSED review can
# never certify a head this gate would skip. The newest marker decides:
# the review pipeline withholds the marker's `sha` anchor on fail-closed
# rounds (an undecided blocker, unproven scope, a truncated finding
# list), so a withheld or malformed anchor fails open instead of falling
# back to an older marker — certifying while the newest round's debt
# stays uncovered — and the marker's recorded `base` must equal the
# current base ref, or a round that reviewed against the old base would
# certify a retargeted one. Markers without a `base` field fail open
# like any unmatched shape.
#
# Scope limit: docs-only-classified PRs never skip — their automatic
# rounds are downgraded to medium with --comment stripped, and medium
# posts no review, so such a PR never gains a ledger-marked review for
# this lookup to resolve.
#
# The git calls below run against a reused self-hosted workspace whose
# .git config and refs an earlier, possibly prompt-injected run can have
# planted, so the whole planted-config class is closed, not entrance by
# entrance: they follow the CLI's sanitizedGitEnv() norm (external diff
# drivers and textconv are disabled — both execute code on a plain
# `git diff` — and GIT_NO_REPLACE_OBJECTS=1 keeps planted refs/replace/*
# from falsifying the digest and ancestry computations), ambient
# system/global gitconfig is masked outright, every call pins
# core.hooksPath=/dev/null so the ref-updating fetch cannot execute a
# planted reference-transaction (or any other) hook, the repo-local keys
# that execute code — merge drivers (no git flag disables one), diff
# command/textconv drivers, core.attributesFile — are scrubbed before
# any call, a planted $GIT_DIR/info/attributes fails the gate open, and
# the digest pins -U3 so a planted diff.context cannot shrink the hashed
# context.
#
# Fail-open contract: every probe error or unmatched shape records
# skip=false and the full round runs, and the script never exits non-zero —
# the caller treats a step failure as a pipeline failure worth a fallback
# comment, which a skipped gate is not.
#
# Outputs (GITHUB_OUTPUT): skip=true|false, reviewed_sha, reason.
set -uo pipefail
export GIT_NO_REPLACE_OBJECTS=1
# Same isolation the suite's harness exports for its children, exported
# here so ambient system/global gitconfig (a prior run's diff.context,
# merge drivers, attributesFile) reaches no gate git call in production.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# The workflow's GIT_SAFE idiom: core.hooksPath=/dev/null keeps a planted
# hook (reference-transaction fires on the fallback fetch's ref update;
# core.hooksPath plants are overridden the same way) out of every call,
# and core.fsmonitor= keeps a planted fsmonitor command out of the reads.
GIT_SAFE=(git -c core.hooksPath=/dev/null -c core.fsmonitor=)

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
# certify an indentation-only rewrite of PR-owned lines; plain `git diff`
# renders binary files as one content-free marker line, so --binary keeps
# their bytes in the hash. --no-ext-diff and --no-textconv keep a planted
# diff.external / diff.<driver>.textconv from executing code in this
# PAT-bearing step; -U3 pins the hashed geometry so a planted diff.context
# cannot shrink it to changed-only lines.
diff_digest() {
  local diff
  diff="$(
    "${GIT_SAFE[@]}" diff --binary --no-ext-diff --no-textconv -U3 "$1" "$2" \
      2>/dev/null
  )" || return 1
  [[ -n "${diff}" ]] || return 0
  printf '%s\n' "${diff}" |
    sed -E '/^index [0-9a-f]+\.\.[0-9a-f]+/d; /^@@ /d' |
    "${GIT_SAFE[@]}" hash-object --stdin
}

decide() {
  # A planted $GIT_DIR/info/attributes maps files to planted merge/diff
  # drivers from inside the git dir, where no config scrub reaches; fail
  # open instead of deleting a file this step does not own.
  local git_dir
  REASON='planted git attributes present'
  git_dir="$("${GIT_SAFE[@]}" rev-parse --git-dir 2>/dev/null)" || return
  [[ ! -e "${git_dir}/info/attributes" ]] || return
  # No git flag disables a merge driver (merge-tree executes one on any
  # both-sides-modified path the attributes map to it), so strip the
  # code-executing repo-local keys before any git call below can honor
  # them. Ambient sources are already masked by the exports above.
  local key
  REASON='workspace git config scrub failed'
  while IFS= read -r key; do
    [[ -n "${key}" ]] || continue
    "${GIT_SAFE[@]}" config --local --unset-all "${key}" || return
  done < <(
    "${GIT_SAFE[@]}" config --local --name-only --get-regexp \
      '^(merge\..*\.driver|diff\..*\.(command|textconv)|core\.attributesfile)$' \
      2>/dev/null || true
  )

  REASON='pr head fetch failed'
  "${GIT_SAFE[@]}" fetch --no-tags --quiet origin \
    "refs/pull/${PR_NUMBER}/head" || return
  REASON='event head not reachable from the PR head ref'
  "${GIT_SAFE[@]}" cat-file -e "${EVENT_HEAD_SHA}^{commit}" 2>/dev/null || return
  REASON='base branch ref unavailable'
  if ! "${GIT_SAFE[@]}" rev-parse -q --verify "origin/${BASE_REF}^{commit}" \
    >/dev/null; then
    "${GIT_SAFE[@]}" fetch --no-tags --quiet origin "${BASE_REF}" || return
    "${GIT_SAFE[@]}" rev-parse -q --verify "origin/${BASE_REF}^{commit}" \
      >/dev/null || return
  fi

  REASON='reviewed-head lookup failed'
  local bot_login reviews marker reviewed_base
  bot_login="$(gh api user --jq '.login')" && [[ -n "${bot_login}" ]] || return
  reviews="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" --method GET --paginate -F per_page=100)" || return
  # The marker PAYLOAD is the certification: the newest submitted bot
  # review whose body CARRIES a marker decides, and anything malformed or
  # withheld fails open — no fall-through to an older marker, since a
  # fail-closed round withholds its `sha` precisely so the next round
  # re-covers what it could not certify, and an unparseable payload (a
  # writer bug, body truncation, a hand-edit) is the same unreadable
  # state. Selecting on parseability instead would drop the newest
  # unparseable marker inside the array and certify from the older one
  # beside it. Non-string `sha`/`base` values are coerced before matching
  # so a writer bug drops out instead of aborting the whole jq program
  # (and every later lookup on the PR). Control characters are stripped
  # from the untrusted base value so a forged marker cannot inject extra
  # GITHUB_OUTPUT lines through the reason text.
  marker="$(
    printf '%s' "${reviews}" | jq -sr --arg login "${bot_login}" '
      [.[][]
       | select(.user.login == $login)
       | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED"
                or .state == "COMMENTED")
       | select(.submitted_at != null)
       | select((.body // "") | contains("<!-- qwen-review-ledger "))]
      | last // empty
      | ((.body // "")
         | capture("<!-- qwen-review-ledger (?<p>\\{.*\\}) -->")
         | .p
         | fromjson)?
      | select(((.sha? // "") | tostring) | test("^[0-9a-f]{7,64}$"))
      | "\(.sha)\t\(((.base // "") | tostring) | gsub("[\\x00-\\x1f\\x7f]"; ""))"'
  )" || return
  REVIEWED_SHA="${marker%%$'\t'*}"
  reviewed_base="${marker#*$'\t'}"
  REASON='no completed automatic round on this PR'
  [[ -n "${REVIEWED_SHA}" ]] || return
  if [[ "${reviewed_base}" != "${BASE_REF}" ]]; then
    REASON="reviewed round certified against base '${reviewed_base:-unknown}', not '${BASE_REF}'"
    return
  fi
  REASON='reviewed head not in the fetched history'
  "${GIT_SAFE[@]}" cat-file -e "${REVIEWED_SHA}^{commit}" 2>/dev/null || return
  REASON='reviewed head is not an ancestor of the pushed head'
  "${GIT_SAFE[@]}" merge-base --is-ancestor "${REVIEWED_SHA}" \
    "${EVENT_HEAD_SHA}" 2>/dev/null || return

  # Bounded walk: a stale reviewed head must not buy an unbounded ancestry
  # scan, and past ten first-parent steps this is not the cheap shape the
  # gate exists for anyway.
  local count c p2 clean_tree walked_tree
  REASON='commit walk failed'
  count="$("${GIT_SAFE[@]}" rev-list --first-parent --count \
    "${REVIEWED_SHA}..${EVENT_HEAD_SHA}" 2>/dev/null)" || return
  [[ "${count}" =~ ^[0-9]+$ ]] || return
  REASON='no new commits since the reviewed head'
  [[ "${count}" -ge 1 ]] || return
  REASON="too many commits since the reviewed head (${count})"
  [[ "${count}" -le 10 ]] || return
  for c in $("${GIT_SAFE[@]}" rev-list --first-parent \
    "${REVIEWED_SHA}..${EVENT_HEAD_SHA}" 2>/dev/null); do
    REASON="non-merge commit since the reviewed head: ${c}"
    p2="$("${GIT_SAFE[@]}" rev-parse -q --verify "${c}^2" 2>/dev/null)" || return
    REASON="octopus merge since the reviewed head: ${c}"
    if "${GIT_SAFE[@]}" rev-parse -q --verify "${c}^3" >/dev/null 2>&1; then
      return
    fi
    REASON="merge of a non-base branch since the reviewed head: ${c}"
    "${GIT_SAFE[@]}" merge-base --is-ancestor "${p2}" "origin/${BASE_REF}" \
      2>/dev/null || return
    # Parentage is not content: a commit-tree-crafted merge can carry the
    # reviewed hunks at a position the offset-stripped digest cannot see,
    # so require the walked tree to be its parents' clean merge; a git
    # without --write-tree (< 2.38) fails open through the same || return.
    REASON="walk commit tree deviates from the clean merge: ${c}"
    clean_tree="$("${GIT_SAFE[@]}" merge-tree --write-tree "${c}^1" "${p2}" \
      2>/dev/null)" || return
    clean_tree="${clean_tree%%$'\n'*}"
    walked_tree="$("${GIT_SAFE[@]}" rev-parse -q --verify "${c}^{tree}" \
      2>/dev/null)" || return
    [[ "${walked_tree}" = "${clean_tree}" ]] || return
  done

  local mb_r mb_h digest_r digest_h
  REASON='merge-base resolution failed'
  mb_r="$("${GIT_SAFE[@]}" merge-base "origin/${BASE_REF}" "${REVIEWED_SHA}" \
    2>/dev/null)" || return
  mb_h="$("${GIT_SAFE[@]}" merge-base "origin/${BASE_REF}" "${EVENT_HEAD_SHA}" \
    2>/dev/null)" || return
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
