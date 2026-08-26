#!/usr/bin/env bash
# Push the round's commit to the PR head and post the round report.
#
# The body below is the 'Push and report' step of review-address in
# .github/workflows/qwen-autofix.yml — the inline block it came from (626
# lines, ~41 KB at the move), its long comments since migrated to
# qwen-autofix.md pointers like the rest of the workflow. The file it left
# is within a few KB of the repo's 470,000-byte gate, and GitHub stops starting
# runs past 512,000 without saying so (.github/scripts/check-workflow-size.sh).
# No absolute size is
# quoted here on purpose — main moves it every day, and a number that decays is
# how this comment earned three review rounds. It is also
# the step docs/design/autofix-gate-runner-isolation.md moves into its own
# credentialed `publish` job — carrying it as a file makes that a small diff.
#
# DELIVERY: this file is never staged, copied or executed from disk at run
# time. The stage step reads it from the trusted-base checkout, before any
# branch code has run, and passes the TEXT through step output; 'Push and
# report' runs those bytes. That is the delivery the inline block had — the
# workflow file's own bytes — and the one upsert-deferred-issue.sh uses. With
# no agent-writable copy on this shared host there is nothing to digest, type
# check or re-open, and no check→use window between those steps. Keep it that
# way: `bash <path>` here would hand the PAT-bearing step to whatever the
# branch left at that path.
#
# INPUTS: the body runs with the step's environment, exactly as the inline
# block did — the `env:` bindings on 'Push and report' plus review-address's
# job-level `env:`. There is deliberately no enumeration here: the previous one
# went stale within a round (it omitted ISSUE, TAKEOVER_LABEL,
# TAKEOVER_COMMAND and TAKEOVER_MAX_ROUNDS), and a list that can rot is worse
# than the two places that cannot.
#
# GitHub runs `run:` blocks as `bash --noprofile --norc -eo pipefail`, so the
# same flags are set here — deliberately without `-u`: the body reads optional
# step outputs unguarded, and adding `-u` would change behaviour rather than
# preserve it.
#
# SHELLCHECK: `scripts/lint.js --shellcheck` adds `--enable=all` on top of
# `--severity=style`, which every script here trips (26 findings for
# run-autofix-review-verification.sh, 9 for upsert-deferred-issue.sh, 32 here)
# and which the lane cannot fail on — its pipeline ends in `sed`. This file is
# clean at the lane's severity WITHOUT `--enable=all`, which is the bar its
# siblings meet, and the three codes below are what that bar reports:
#   SC1007 — the empty prefix assignments before the clean-child launches
#            (`VAR= VAR= cmd`) clear those variables for one command. That is
#            the intent, not a mistyped assignment. Spelled generically here
#            on purpose: a contract test anchors its slice on the literal
#            launch line, and repeating it in a comment moves that anchor.
#   SC2016 — single-quoted `${...}` is passed verbatim to jq programs, GraphQL
#            queries and comment bodies; expanding them here would break them.
#   SC2155 — real, and pre-existing: two `export X="$(cmd)"` sites mask the
#            command's exit status. Splitting them changes what `set -e` does
#            at those lines, so it belongs in a change that can be reviewed as
#            a behaviour change rather than hiding inside a move.
# shellcheck disable=SC1007,SC2016,SC2155
set -eo pipefail

# gh has its own $GITHUB_ENV-injectable channels: pin the host and
# drop any planted token BEFORE the identity check below, so a
# GH_HOST reroute cannot spoof `gh api user` and a planted GH_TOKEN
# cannot outrank the inline GITHUB_TOKEN. (git's channels are
# stripped in the hermetic preamble further down.)
export GH_HOST=github.com
unset GH_ENTERPRISE_TOKEN GH_TOKEN
# Point gh at a fresh empty config dir, not the default
# ~/.config/gh on the shared attacker-writable HOME — its
# config.yml can carry http_unix_socket and other transport
# reroutes no sweep here touches. mktemp -d gives an
# unpredictable path a watcher cannot pre-seed.
export GH_CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP}/autofix-gh-config.XXXXXX")"
# The head the agent actually evaluated — captured in prepare before
# any mutation, not the report-time remote head (which can move
# during the run). Empty when prepare exited early, which matches
# no marker and keeps reds visible — fail-open.
REPORT_HEAD="${CHECKED_OUT_HEAD}"
# Prepare may have adopted a sibling's live round; the matrix value
# would double-write that round's marker.
ROUND="${EFFECTIVE_ROUND:-${ROUND}}"
MODEL_DISPLAY="${MODEL:-default}"
# Growth-audit trail (+ re-arm on sound): audit rounds record the
# verdict under the key the baseline was READ under — same rule as
# the growth markers, same dead-key hazard (a supersede-exempt
# round can report under a stale WINDOW after a re-arm).
# Full rationale → qwen-autofix.md#af-131
emit_growth_audit_marker() {
  local allow_rearm="${1:-false}"
  [[ "${KISS_AUDIT}" == 'true' ]] || return 0
  case "${AUDIT_VERDICT:-}" in
    sound | drift | conflict) ;;
    *) return 0 ;;
  esac
  echo "<!-- autofix-growth-audit verdict=${AUDIT_VERDICT} win=${GROWTH_BASE_WIN:-${WINDOW:-none}} -->"
  if [[ "${AUDIT_VERDICT}" == 'sound' && "${allow_rearm}" == 'true' ]]; then
    echo "<!-- autofix-rearm -->"
  fi
}
if [[ -z "${GITHUB_TOKEN}" ]]; then
  echo '::error::CI_DEV_BOT_PAT is required to push and report as qwen-code-dev-bot.'
  exit 1
fi
api_error_file="$(mktemp)"
if ! bot_actor="$(GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq '.login' 2>"${api_error_file}")"; then
  api_error="$(tr '\r\n' ' ' < "${api_error_file}")"
  rm -f "${api_error_file}"
  echo "::error::Failed to verify CI_DEV_BOT_PAT identity with gh api user: ${api_error:-unknown error}."
  exit 1
fi
rm -f "${api_error_file}"
echo "CI_DEV_BOT_PAT authenticates as ${bot_actor}"
if [[ "${bot_actor}" != "${AUTOFIX_BOT}" ]]; then
  echo "::error::CI_DEV_BOT_PAT authenticates as ${bot_actor}; expected ${AUTOFIX_BOT}."
  exit 1
fi

# Shared by the pushed and no-op outcomes: a no-op round may
# resolve re-verified findings (verified_head is the unchanged,
# previously verified origin head) and must post its declines'
# replies — silence in still-open threads was a no-op-only gap.
resolve_and_reply_threads() {
  CAN_RESOLVE_THREADS='false'
  if [[ -s "${WORKDIR}/resolved-comments.txt" ]]; then
    LOCAL_PUSHED_HEAD="$(git rev-parse HEAD)"
    if [[ "${PUSH_RACE_MERGED}" == 'true' ]]; then
      echo "::warning::skipping review-thread resolution because the pushed head includes commits merged after deterministic verification"
    elif [[ -z "${VERIFIED_HEAD}" || "${LOCAL_PUSHED_HEAD}" != "${VERIFIED_HEAD}" ]]; then
      echo "::warning::skipping review-thread resolution because the pushed head is not the exact deterministically verified commit"
    elif LIVE_PR_HEAD="$(gh pr view "${PR}" --repo "${REPO}" --json headRefOid --jq '.headRefOid // ""' 2> /dev/null)" &&
      [[ -n "${LIVE_PR_HEAD}" && "${LIVE_PR_HEAD}" == "${VERIFIED_HEAD}" ]]; then
      CAN_RESOLVE_THREADS='true'
    else
      echo "::warning::skipping review-thread resolution because the live PR head could not be proven equal to the deterministically verified commit"
    fi
  fi
  # Resolve the review threads whose findings the agent actually
  # IMPLEMENTED, so a human re-reviewing sees only what is still open
  # instead of re-reading every thread to work out what was handled.
  # Full rationale → qwen-autofix.md#af-052
  if [[ -s "${WORKDIR}/resolved-comments.txt" || -s "${WORKDIR}/comment-replies.json" ]]; then
    THREADS_FETCH_OK='true'
    # gh's stderr goes to a fresh mktemp regular file, never a named
    # WORKDIR path: WORKDIR is bind-mounted read-write into the agent
    # Full rationale → qwen-autofix.md#af-053
    threads_err_file="$(mktemp)"
    THREADS_RAW="$(gh api graphql --paginate -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F pr="${PR}" -f query='
      query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
        repository(owner:$owner,name:$name){
          pullRequest(number:$pr){
            reviewThreads(first:100, after:$endCursor){
              nodes{id isResolved comments(first:100){nodes{databaseId author{login} body} pageInfo{hasNextPage}}}
              pageInfo{hasNextPage endCursor}
            }
          }
        }
      }' --jq '.data.repository.pullRequest.reviewThreads.nodes[]' 2> "${threads_err_file}")" || THREADS_FETCH_OK='false'
    # gh emits one node per line across every page; slurp them
    # into the flat array both blocks below already expect. The
    # Full rationale → qwen-autofix.md#af-054
    THREADS_JSON="$(jq -s '[.[] | select(type == "object" and has("id") and has("comments"))]' <<< "${THREADS_RAW}" 2> /dev/null)" || THREADS_JSON='[]'
    [[ -n "${THREADS_JSON}" ]] || THREADS_JSON='[]'
    if [[ "${THREADS_FETCH_OK}" != 'true' ]]; then
      # Fold in gh's stderr: the warning announces THAT pagination
      # stopped, and only this says WHY — a transient rate limit
      # (back off) reads identically to an expired PAT (rotate) or a
      # network failure without it.
      echo "::warning::review-thread pagination did not complete; $(jq 'length' <<< "${THREADS_JSON}") thread(s) fetched, and any thread past them will not be resolved or answered in-thread: $(tail -c 300 "${threads_err_file}" 2> /dev/null | tr '\r\n' '  ')"
    fi
    rm -f "${threads_err_file}"
    if [[ "$(jq -r 'map(select(.comments.pageInfo.hasNextPage)) | length' <<< "${THREADS_JSON}")" != "0" ]]; then
      echo "::warning::a review thread carries more than 100 comments; a comment past that page is not mapped to its thread"
    fi
  fi
  if [[ "${CAN_RESOLVE_THREADS}" == 'true' ]]; then
    CONFIRMED_RESOLVED_N=0
    read_thread_guard() {
      gh api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F pr="${PR}" -f threadId="${1}" -f query='
        query($owner:String!,$name:String!,$pr:Int!,$threadId:ID!){
          repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid}}
          node(id:$threadId){... on PullRequestReviewThread{isResolved}}
        }' --jq '[.data.repository.pullRequest.headRefOid // "", .data.node.isResolved] | @tsv'
    }
    while IFS= read -r rc_id || [[ -n "${rc_id}" ]]; do
      rc_id="${rc_id%$'\r'}"
      rc_id="${rc_id#rc:}"
      [[ "${rc_id}" =~ ^[0-9]+$ ]] || continue
      thread_id="$(jq -r --argjson id "${rc_id}" \
        'map(select(.isResolved | not)
           | select(any(.comments.nodes[]; .databaseId == $id)))
         | .[0].id // ""' <<< "${THREADS_JSON}")"
      if [[ -z "${thread_id}" ]]; then
        echo "::warning::comment ${rc_id} matched no open review thread"
        continue
      fi
      if ! IFS=$'\t' read -r LIVE_PR_HEAD THREAD_IS_RESOLVED < <(read_thread_guard "${thread_id}" 2> /dev/null) ||
        [[ -z "${LIVE_PR_HEAD}" || "${LIVE_PR_HEAD}" != "${VERIFIED_HEAD}" ]]; then
        echo "::warning::stopping review-thread resolution because the live PR head moved before resolving comment ${rc_id}"
        break
      elif [[ "${THREAD_IS_RESOLVED}" == 'true' ]]; then
        echo "::warning::comment ${rc_id} was resolved by another actor before this round could resolve it"
        continue
      elif [[ "${THREAD_IS_RESOLVED}" != 'false' ]]; then
        echo "::warning::stopping review-thread resolution because the state of comment ${rc_id} could not be proven"
        break
      fi
      RESOLVE_SUCCEEDED='false'
      if gh api graphql -f threadId="${thread_id}" -f query='
        mutation($threadId:ID!){
          resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}
        }' > /dev/null 2>&1; then
        RESOLVE_SUCCEEDED='true'
      fi
      POST_GUARD_OK='false'
      if IFS=$'\t' read -r LIVE_PR_HEAD THREAD_IS_RESOLVED < <(read_thread_guard "${thread_id}" 2> /dev/null); then
        POST_GUARD_OK='true'
      fi
      if [[ "${POST_GUARD_OK}" == 'true' && "${LIVE_PR_HEAD}" == "${VERIFIED_HEAD}" && "${THREAD_IS_RESOLVED}" == 'true' ]]; then
        if [[ "${RESOLVE_SUCCEEDED}" != 'true' ]]; then
          echo "::warning::comment ${rc_id} is resolved after an unsuccessful mutation command; another actor or a lost response may be responsible"
        fi
        CONFIRMED_RESOLVED_N=$(( CONFIRMED_RESOLVED_N + 1 ))
      elif [[ "${POST_GUARD_OK}" == 'true' && "${LIVE_PR_HEAD}" == "${VERIFIED_HEAD}" && "${THREAD_IS_RESOLVED}" == 'false' && "${RESOLVE_SUCCEEDED}" == 'false' ]]; then
        echo "::warning::could not resolve the review thread for comment ${rc_id}"
      else
        echo "::warning::the live PR head or thread state could not be proven after resolving comment ${rc_id}; stopping review-thread resolution"
        break
      fi
    done < "${WORKDIR}/resolved-comments.txt"
    echo "🧵 confirmed ${CONFIRMED_RESOLVED_N} selected review thread(s) resolved while the verified head remained live"
  fi
  # The mirror of the resolve above: a finding the agent did NOT
  # resolve keeps its thread open, and this answers it IN that thread.
  # Full rationale → qwen-autofix.md#af-132
  if [[ -s "${WORKDIR}/comment-replies.json" ]] &&
    jq -e 'type == "array"' "${WORKDIR}/comment-replies.json" > /dev/null 2>&1; then
    REPLIED_N=0
    while IFS=$'\t' read -r rc_id reply_b64; do
      [[ "${rc_id}" =~ ^[0-9]+$ && -n "${reply_b64}" ]] || continue
      # A finding cannot be both resolved and replied to; the resolve
      # block above already closed anything in resolved-comments.txt,
      # so skip it here rather than answer a thread we just resolved.
      # Match tolerates the rc: prefix and a trailing CR, as the
      # resolve block's own parsing does.
      if [[ -f "${WORKDIR}/resolved-comments.txt" ]] &&
        tr -d '\r' < "${WORKDIR}/resolved-comments.txt" |
        grep -qxE "(rc:)?${rc_id}"; then
        continue
      fi
      REPLY_BODY="$(base64 -d <<< "${reply_b64}" | sed 's/<!--/<!\\-\\-/g')"
      [[ -n "${REPLY_BODY}" ]] || continue
      # GitHub rejects a reply aimed at another reply ("Replies to
      # replies are not supported"), and rc_id can itself be a reply
      # id — the feedback step lists every review comment, replies
      # included. Map to the thread's top-level comment (the one
      # valid target), falling back to rc_id when the comment is
      # absent from THREADS_JSON — a thread past a partial fetch, or
      # a comment past its own thread's first-100 comment page.
      root_id="$(jq -r --argjson id "${rc_id}" \
        'map(select(any(.comments.nodes[]; .databaseId == $id)))
         | .[0].comments.nodes[0].databaseId // $id' <<< "${THREADS_JSON}")"
      # Idempotence gate: a crash-and-rerun of this round, a
      # same-run repair that regenerates the dispositions, or a
      # later round whose agent rewrites an unchanged declination
      # must not post the same bot reply twice on one thread
      # (observed 2026-08-16: an identical reply posted three
      # times, #9296).
      # Full rationale → qwen-autofix.md#af-133
      if jq -e --argjson id "${root_id}" --arg bot "${AUTOFIX_BOT}" \
        --arg body "${REPLY_BODY}" '
          map(select(any(.comments.nodes[]; .databaseId == $id)))
          | .[0].comments.nodes // []
          | any(.[]; (.author.login // "") == $bot
                   and (.body // "") == $body)' \
        <<< "${THREADS_JSON}" > /dev/null 2>&1; then
        echo "⏭️ reply to review comment ${rc_id} skipped — identical bot reply already on the thread"
        continue
      fi
      if gh api "repos/${REPO}/pulls/${PR}/comments/${root_id}/replies" \
        -f body="${REPLY_BODY}" > /dev/null 2>&1; then
        REPLIED_N=$(( REPLIED_N + 1 ))
      else
        echo "::warning::could not reply to review comment ${rc_id}"
      fi
    done < <(jq -r '.[] | select(.id != null and .body != null)
      | [(.id | tostring), (.body | @base64)] | @tsv' \
      "${WORKDIR}/comment-replies.json" 2> /dev/null || true)
    echo "🧵 replied on ${REPLIED_N} thread(s) the agent left open"
  fi
}
# Deferred-findings persistence, shared by both arms below.
# Full rationale → qwen-autofix.md#af-055
run_deferred_upsert() {
  if [[ -z "${UPSERT_SRC:-}" ]]; then
    # Stage never ran: nothing was deferred either.
    echo 'deferred-findings upsert skipped: stage step never ran'
    return 0
  fi
  UPSERT_OUT="$( { LD_PRELOAD= LD_AUDIT= LD_LIBRARY_PATH= \
    LD_PROFILE= LD_PROFILE_OUTPUT= LD_DEBUG= LD_DEBUG_OUTPUT= \
    /usr/bin/env -i \
    PATH="${TRUSTED_PATH}" \
    GITHUB_TOKEN="${GITHUB_TOKEN}" \
    GH_HOST=github.com \
    RUNNER_TEMP="${RUNNER_TEMP}" \
    WORKDIR="${WORKDIR}" \
    PR="${PR}" \
    REPO="${REPO}" \
    AUTOFIX_BOT="${AUTOFIX_BOT}" \
    UPSERT_SRC="${UPSERT_SRC}" \
    bash --norc -c '
      set -uo pipefail
      exec >&3
      printf "%s\n" "__upsert_child_live__"
      if ! GH_CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP}/autofix-gh-config.XXXXXX")"; then
        echo "__upsert_trusted__::warning::could not create a gh config dir; deferred findings NOT persisted this round"
        exit 0
      fi
      export GH_CONFIG_DIR
      bash -c "${UPSERT_SRC}" ||
        echo "__upsert_trusted__::warning::deferred-findings upsert failed; continuing"
    ' > /dev/null 2>&1 ; } 3>&1 )" || true
  # INSPECTION uses bash builtins only ([[ ]], read, printf — no
  # exec): under loader trace mode every external binary, grep
  # included, would itself print-and-exit-0, so a grep-based check
  # would be neutered by the very condition it must detect.
  if [[ "${UPSERT_OUT}" != *'__upsert_child_live__'* ]]; then
    echo "::warning::deferred-findings upsert child never started (loader trace mode or exec failure); NOT persisted this round"
  fi
  # The child's output is agent-reachable content, so both workflow-command
  # syntaxes are neutralized before it reaches this step's stdout (`##[`
  # parses mid-line too — #9761).
  while IFS= read -r _upsert_line; do
    # Wrapper-authored lines carry a marker and are emitted
    # VERBATIM so they still render as GitHub annotations; the
    # script's own output is agent-reachable and stays neutralized.
    if [[ "${_upsert_line}" == '__upsert_child_live__' ]]; then
      :
    elif [[ "${_upsert_line}" == __upsert_trusted__* ]]; then
      printf '%s\n' "${_upsert_line#__upsert_trusted__}"
    else
      # The canonical two-expression neutralizer, identical to every other
      # echo site — one spelling for the whole family, so a syntax change
      # cannot drift across two implementations.
      printf '%s\n' "${_upsert_line}" | sed -e 's/::/;;/g' -e 's/##\[/##［/g'
    fi
  done <<< "${UPSERT_OUT}"
}

          # Take this PAT-bearing step off every mutable host git surface —
# both the shared config FILES and git's ENV channels — keep this
          # Full rationale → qwen-autofix.md#af-056
export PATH="${TRUSTED_PATH}"
unset LD_PRELOAD LD_AUDIT LD_LIBRARY_PATH \
  GIT_CONFIG_PARAMETERS GIT_ALLOW_PROTOCOL GIT_PROXY_COMMAND \
  GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_EXEC_PATH GIT_DIR \
  GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_SHALLOW_FILE \
  GIT_ASKPASS GIT_SSH GIT_SSH_COMMAND
export GIT_CONFIG_COUNT=0
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL="$(mktemp "${RUNNER_TEMP}/autofix-pat-gitconfig.XXXXXX")"
git config --file "${GIT_CONFIG_GLOBAL}" safe.directory "$(pwd)"
# Host hygiene + LOCAL .git/config scrub (the throwaway global above
# covers only the global scope, not the highest-precedence local
# file the branch/agent can plant). The staged copy's trusted-base
# provenance holds at cp time only — RUNNER_TEMP is writable by that
# same branch code — so verify the digest the staging step recorded
# in GITHUB_OUTPUT (unreachable from a disk write) before executing.
# Never run the script from the working tree; it holds the branch.
echo "${RESANITIZE_SHA256}  ${RUNNER_TEMP}/resanitize-git-config.sh" | sha256sum -c - > /dev/null
bash "${RUNNER_TEMP}/resanitize-git-config.sh"

if [[ "${OUTCOME}" == "fixed" ]]; then
  NEXT_ROUND="$(( ROUND + 1 ))"
  # The tree the gate verified is what gets pushed: assert HEAD is
  # the gate's verified_head before touching credentials.
  # Full rationale → qwen-autofix.md#af-134
  HEAD_NOW="$(git rev-parse HEAD)"
  if [[ -z "${VERIFIED_HEAD}" || "${HEAD_NOW}" != "${VERIFIED_HEAD}" ]]; then
    echo "::error::HEAD ${HEAD_NOW} is not the gate's verified head ${VERIFIED_HEAD:-<empty>} — refusing to push"
    exit 1
  fi
  # Push the exact verified COMMIT OBJECT, never the symbolic
  # HEAD: `HEAD:branch` would re-resolve at push time, re-opening
  # the check-then-use race the guard above just closed (a watcher
  # moving HEAD between the check and the push). PUSH_SHA is
  # re-pinned to the concrete object after each salvage merge below.
  PUSH_SHA="${VERIFIED_HEAD}"
  git config --local --unset-all http.https://github.com/.extraheader || true
  # This step carries the PAT; the branch carries PR-controlled
  # .husky hooks (hooksPath was pointed there so the AGENT's
  # commits get checked). A pre-push hook would execute that code
  # with the PAT in env — sever hooks entirely before pushing.
  git config core.hooksPath /dev/null
  # Authenticate push/fetch with a one-shot, host-scoped credential
  # helper via a git_auth wrapper (see Publish PR) — nothing lands
  # Full rationale → qwen-autofix.md#af-057
  git_auth() { git -c http.sslVerify=true -c fetch.recurseSubmodules=false -c protocol.ext.allow=never -c credential.helper= -c credential."https://github.com".helper='!f(){ echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; };f' "$@"; }
  if [[ "${HEAD_REPO:-${REPO}}" != "${REPO}" ]]; then
    # Push back to the FORK branch via allow-edits (PAT has push
    # rights on the upstream, which GitHub extends to the fork's
    # PR branch when the author ticked the box).
    PUSH_URL="https://github.com/${HEAD_REPO}.git"
  else
    PUSH_URL="https://github.com/${REPO}.git"
  fi
  # Salvage a race-lost push instead of discarding the run. The
  # per-PR head-write concurrency group serialises THIS repo's
  # Full rationale → qwen-autofix.md#af-058
  PUSH_RACE_MERGED='false'
  for push_attempt in 1 2 3; do
    if git_auth push --no-verify "${PUSH_URL}" "${PUSH_SHA}:refs/heads/${BRANCH}"; then
      break
    fi
    if [[ "${push_attempt}" == 3 ]]; then
      echo "::error::push rejected ${push_attempt} times; giving up"
      exit 1
    fi
    echo "⚠️ push rejected (attempt ${push_attempt}) — branch moved during the run; merging the new head and retrying"
    if ! git_auth fetch "${PUSH_URL}" "refs/heads/${BRANCH}"; then
      echo "::error::could not fetch the moved head (attempt ${push_attempt}) — cannot salvage this push"
      exit 1
    fi
    # The disclosure flag keys on HEAD actually advancing: a push
    # can fail transiently (upload timeout, 503) with the branch
    # unmoved, and the merge then no-ops "Already up to date" —
    # flagging that would tell the reviewer to re-check mid-run
    # commits that never existed.
    PRE_MERGE_HEAD="$(git rev-parse HEAD)"
    # commit.gpgsign=false: this real merge commit would otherwise
    # read the signing knob from config and, with no key on the
    # runner, exit 128 ("gpg: signing failed") — misread below as a
    # content conflict, discarding a verified round. The throwaway
    # global above already hides a polluted ~/.gitconfig; this makes
    # the merge independent of it regardless.
    if ! git -c commit.gpgsign=false \
      -c user.name="${AUTOFIX_BOT}" \
      -c user.email="${AUTOFIX_BOT}@users.noreply.github.com" \
      merge --no-edit FETCH_HEAD; then
      git merge --abort || true
      echo "::error::the commits pushed during the run conflict with this fix — handing off instead of overwriting either side"
      exit 1
    fi
    # Re-pin the exact object the next attempt pushes to the
    # merge result, captured here under control — not a symbolic
    # HEAD the push would re-resolve.
    PUSH_SHA="$(git rev-parse HEAD)"
    if [[ "${PUSH_SHA}" != "${PRE_MERGE_HEAD}" ]]; then
      PUSH_RACE_MERGED='true'
    fi
  done
  resolve_and_reply_threads
  # Best-effort: verified out-of-footprint findings persist into
  # the per-PR tracking issue (script content from expression
  # context; append-only comment design — see the script).
  run_deferred_upsert
  # The sha the push loop above actually left on the branch — the merge
  # retry can advance it past the verified head, and the regression marker
  # must name what the PR now carries.
  PUSHED_HEAD="$(git rev-parse HEAD 2> /dev/null || echo '')"
  {
    echo "🤖 Addressed the latest review feedback (round ${NEXT_ROUND}/${MAX_ROUNDS}). What changed, and what I pushed back on: · 已处理最新评审反馈（第 ${NEXT_ROUND}/${MAX_ROUNDS} 轮）。改动内容与我反驳保留之处如下："
    echo
    # Neutralize the comment-opening token itself: model output
    # posted verbatim under the bot identity could smuggle a forged
    # control marker ('<!-- autofix-eval …') the scanners would
    # trust. Token-breaking is LINE-INDEPENDENT — a strip like
    # 's/<!--[^>]*-->//' misses a marker whose --> sits on another
    # line, and jq scan() matches across newlines. The backslashes
    # render away in markdown, so the visible text is unchanged.
    sed 's/<!--/<!\\-\\-/g' "${WORKDIR}/address-summary.md"
    # Gate-authored advisories (e.g. "test coverage shrank") render
    # AFTER the agent's summary: the summary carries the agent's
    # justification, the advisory carries the machine measurement a
    # maintainer checks it against. Escaped like every other
    # embedded file — the advisory quotes file paths from the
    # branch, which are model-influenced content.
    if [[ -s "${WORKDIR}/gate-advisories.md" ]]; then
      echo
      sed 's/<!--/<!\\-\\-/g' "${WORKDIR}/gate-advisories.md"
    fi
    if [[ -s "${WORKDIR}/deferred-feedback.md" ]]; then
      echo
      sed 's/<!--/<!\\-\\-/g' "${WORKDIR}/deferred-feedback.md"
    fi
    echo
    echo "Base-conflict check · 基分支冲突检查: $([[ "${CONFLICT}" == "true" ]] && echo 'conflicted with main — resolved in this push. · 与 main 有冲突——已在本次推送中解决。' || echo 'no conflict with main. · 与 main 无冲突。')"
    if [[ "${PUSH_RACE_MERGED}" == 'true' ]]; then
      echo
      echo "⚠️ The branch received new commits while this round ran; they were merged into this push, but this round's verification predates that merge — re-check anything that landed mid-run. · 本轮运行期间分支收到了新的提交；本次推送已将其合并，但本轮验证在合并之前完成——请复查运行期间落地的改动。"
    fi
    if [[ -n "${REGRESSED_ROUND:-}" ]]; then
      echo
      echo "🩸 Regression charged to round ${REGRESSED_ROUND}: that round pushed onto a head whose checks were all green and left them red. It no longer counts as progress for the consecutive-failure brake. · 已将回归记在第 ${REGRESSED_ROUND} 轮：该轮在检查全绿的 head 上推送后检查转红，因此不再计入连续失败熔断的有进展判定。"
    fi
    echo
    echo "Re-review when you have a moment. After round ${MAX_ROUNDS} this bot stops and leaves the PR for a human. · 有空请复审；第 ${MAX_ROUNDS} 轮后本 bot 停止并将 PR 交给人工。"
    echo
    echo "---"
    echo "🧠 Handled by **Qwen Code** · model/模型 \`${MODEL_DISPLAY}\`"
    echo
    echo "<!-- autofix-eval ts=${NEWEST} acted=true round=${NEXT_ROUND} win=${WINDOW:-none} -->"
    echo "<!-- autofix-redcheck head=${REPORT_HEAD} -->"
    # Regression accounting (af-148). Two distinct facts, both keyed to the
    # eval marker's window so the consecutive-failure walk reads them with
    # the same filter it already applies to the eval markers:
    #   autofix-push       — what THIS round pushed, and whether the head it
    #                        pushed ONTO was fully green. Only an acted round
    #                        writes it; a no-op pushed nothing to regress.
    #                        head= is the PUSHED sha, not REPORT_HEAD (which
    #                        deliberately records the pre-round head).
    #   autofix-regression — the PRIOR round prepare found had left a green
    #                        head red. Written by whichever report this round
    #                        posts, so the record survives a later failure.
    echo "<!-- autofix-push round=${NEXT_ROUND} head=${PUSHED_HEAD} pre=${CHECK_STATE:-none} key=${WINDOW:-none} -->"
    if [[ -n "${REGRESSED_ROUND:-}" ]]; then
      echo "<!-- autofix-regression round=${REGRESSED_ROUND} key=${WINDOW:-none} -->"
    fi
    if [[ "${GROWTH_BASE_NEW}" == 'true' ]]; then
      echo "<!-- autofix-growth-base src=${GROWTH_BASE_SRC} test=${GROWTH_BASE_TEST} key=${GROWTH_BASE_WIN:-${WINDOW:-none}} -->"
    fi
    # Per-round growth history the next round's census counts;
    # run=GITHUB_RUN_ID is the DEDUP identity (a retry or a
    # job re-run re-posts the same run; measured= orders and picks
    # that run's latest attempt).
    echo "<!-- autofix-growth-now src=${GROWTH_SRC:-0} test=${GROWTH_TEST:-0} over=${CRITICAL_ONLY_GROWTH:-false} round=${NEXT_ROUND} run=${GITHUB_RUN_ID}${MEASURED_AT:+ measured=${MEASURED_AT}} key=${GROWTH_BASE_WIN:-${WINDOW:-none}} -->"
    emit_growth_audit_marker true
  } > "${WORKDIR}/report.md"
  STATUS="pushed (round ${NEXT_ROUND}/${MAX_ROUNDS})"
else
  # No push happened, so the verified head is the unchanged
  # origin head; resolution's own live-head guards still apply.
  PUSH_RACE_MERGED='false'
  resolve_and_reply_threads
  # Best-effort: verified out-of-footprint findings persist into
  # the per-PR tracking issue (script content from expression
  # context; append-only comment design — see the script).
  run_deferred_upsert
  # noop: evaluated, nothing worth doing. Report once and advance the
  # watermark so the next scan does not re-evaluate the same feedback.
  {
    echo "🤖 Reviewed the latest feedback — no changes needed. Why, point by point: · 已审阅最新反馈——无需改动。逐点说明原因如下："
    echo
    sed 's/<!--/<!\\-\\-/g' "${WORKDIR}/no-action.md"
    if [[ -s "${WORKDIR}/deferred-feedback.md" ]]; then
      echo
      sed 's/<!--/<!\\-\\-/g' "${WORKDIR}/deferred-feedback.md"
    fi
    echo
    echo "Base-conflict check · 基分支冲突检查: $([[ "${CONFLICT}" == "true" ]] && echo 'conflicts with main (no review fix needed, but a rebase/merge is required before merge). · 与 main 有冲突（无需评审修复，但合并前需 rebase/merge）。' || echo 'no conflict with main. · 与 main 无冲突。')"
    echo
    echo "---"
    echo "🧠 Handled by **Qwen Code** · model/模型 \`${MODEL_DISPLAY}\`"
    echo
    echo "<!-- autofix-eval ts=${NEWEST} acted=false round=${ROUND} win=${WINDOW:-none} -->"
    echo "<!-- autofix-redcheck head=${REPORT_HEAD} -->"
    # No autofix-push marker: a no-op round pushed nothing that could
    # regress. The regression it OBSERVED still has to be recorded here.
    if [[ -n "${REGRESSED_ROUND:-}" ]]; then
      echo "<!-- autofix-regression round=${REGRESSED_ROUND} key=${WINDOW:-none} -->"
    fi
    if [[ "${GROWTH_BASE_NEW}" == 'true' ]]; then
      echo "<!-- autofix-growth-base src=${GROWTH_BASE_SRC} test=${GROWTH_BASE_TEST} key=${GROWTH_BASE_WIN:-${WINDOW:-none}} -->"
    fi
    # Per-round growth history the next round's census counts;
    # run=GITHUB_RUN_ID is the DEDUP identity (a retry or a
    # job re-run re-posts the same run; measured= orders and picks
    # that run's latest attempt).
    echo "<!-- autofix-growth-now src=${GROWTH_SRC:-0} test=${GROWTH_TEST:-0} over=${CRITICAL_ONLY_GROWTH:-false} round=${ROUND} run=${GITHUB_RUN_ID}${MEASURED_AT:+ measured=${MEASURED_AT}} key=${GROWTH_BASE_WIN:-${WINDOW:-none}} -->"
    emit_growth_audit_marker true
  } > "${WORKDIR}/report.md"
  STATUS="no action needed"
fi

# Bounded retry on the report post: this one comment carries the
# round's ENTIRE persisted state (autofix-eval watermark/round,
# redcheck head, growth baseline).
# Full rationale → qwen-autofix.md#af-135
REPORT_POSTED='false'
for attempt in 1 2 3; do
  if gh pr comment "${PR}" --repo "${REPO}" --body-file "${WORKDIR}/report.md"; then
    REPORT_POSTED='true'
    break
  fi
  if [[ "${attempt}" == 3 ]]; then
    echo "::error::report post failed ${attempt} times for PR #${PR}; giving up"
  else
    echo "::warning::report post attempt ${attempt} failed for PR #${PR}; retrying"
    sleep 10
  fi
done
[[ "${REPORT_POSTED}" == 'true' ]] || exit 1

# Takeover milestone digest — roughly every 10 rounds. The takeover
# cap (100) bounds runaway but says nothing about when a human
# Full rationale → qwen-autofix.md#af-059
if [[ "${OUTCOME}" == "fixed" && "${MAX_ROUNDS}" == "${TAKEOVER_MAX_ROUNDS}" ]] \
  && [[ "${NEXT_ROUND}" -ge 10 && -f "${WORKDIR}/ic.json" ]]; then
  # Crossing trigger, not an equality test: failure rounds also
  # advance the round counter, so `push@9, crash@10, push@11`
  # would skip an exact %10 check forever — and a failure-heavy
  # PR is the very PR the digest exists for.
  # Full rationale → qwen-autofix.md#af-136
  MS_LAST="$(jq -r --arg ab "${AUTOFIX_BOT}" --arg win "${WINDOW:-none}" --argjson start "${ROUND_START:-0}" '
    [ .[] | select((.user.login // "") == $ab) | (.body // "")
      | [ scan("<!-- autofix-milestone round=([0-9]+) win=([^ ]+) -->") ] | .[]
      | select(.[1] == $win) | (.[0] | tonumber) ]
    | max // $start' "${WORKDIR}/ic.json" 2> /dev/null || echo "${ROUND_START:-0}")"
  if [[ "$(( NEXT_ROUND - MS_LAST ))" -ge 10 ]]; then
    WIN_HEADS="$(jq -r --arg ab "${AUTOFIX_BOT}" --arg win "${WINDOW:-none}" '
      [.[] | select((.user.login // "") == $ab)
           | select((.body // "") | contains("<!-- autofix-eval "))
           | select(
               ([ ((.body // "") | scan("<!-- autofix-eval ts=[^ ]+ acted=[^ ]+ round=[0-9]+(?: win=([^ ]+))? -->")) ] | map(.[0] // "none")) as $wins
               | ($wins | length) > 0 and (($wins | last) == $win))]
      | sort_by(.created_at) | .[]
      | (.body | gsub("\r"; "") | split("\n")[0])' "${WORKDIR}/ic.json" 2> /dev/null || true)"
    if [[ -z "${WIN_HEADS}" ]]; then
      # Reaching round 10+ with zero window markers means the
      # parse failed (prior markers must exist to be here) — a
      # fabricated all-zero census is worse than no digest.
      echo "::warning::milestone census found no window markers on #${PR}; skipping the digest"
    else
      N_PUSHED="$(grep -c 'Addressed the latest review feedback' <<< "${WIN_HEADS}" || true)"
      # This round's own marker was posted just above but ic.json
      # predates it — count it in by hand.
      N_PUSHED=$(( N_PUSHED + 1 ))
      N_NOOP="$(grep -c 'no changes needed' <<< "${WIN_HEADS}" || true)"
      # Needle matches the emitted headline verbatim — first
      # lines can embed provider error text.
      N_TIMEOUT="$(grep -c 'AutoFix ran out of time before finishing' <<< "${WIN_HEADS}" || true)"
      # Both wordings of the gate-rejection handoff, past and
      # present, plus both handoff brake violations, dirty and
      # committed (the gate rejects each under its own outcome)
      # — the census must not silently zero when the headline is
      # reworded.
      N_REJECTED="$(grep -cE 'Could not (address the latest feedback|produce a passing fix)|wrote a handoff but (left a dirty workspace|the round HAS a commit)' <<< "${WIN_HEADS}" || true)"
      # The brake's deliberate stop — its own bucket, not the
      # residual crash bucket: it tells the maintainer a human
      # decision is already waiting on this PR.
      N_HANDOFF="$(grep -c 'deferred this item to a human under instruction' <<< "${WIN_HEADS}" || true)"
      # Every other outcome (crash, model error, gate error,
      # infra) lands in a residual bucket: a window that burned
      # 80% of its budget on crashes must be the LOUDEST line in
      # the digest, not four zeros quieter than a healthy one.
      N_TOTAL=$(( $(grep -c . <<< "${WIN_HEADS}" || true) + 1 ))
      N_OTHER=$(( N_TOTAL - N_PUSHED - N_NOOP - N_TIMEOUT - N_REJECTED - N_HANDOFF ))
      (( N_OTHER < 0 )) && N_OTHER=0
      # Base updates carry their own marker with no win= field;
      # their window is recovered by timestamp (the window key IS
      # the engage ack's created_at — 'none' means count all,
      # and the header says so).
      N_BASE="$(jq -r --arg ab "${AUTOFIX_BOT}" --arg win "${WINDOW:-none}" '
        [.[] | select((.user.login // "") == $ab)
             | select((.body // "") | contains("<!-- autofix-base-updated -->"))
             | select($win == "none" or ((.created_at // "") > $win))]
        | length' "${WORKDIR}/ic.json" 2> /dev/null || echo 0)"
      WIN_DESC='in the current window'
      WIN_DESC_ZH='当前窗口'
      if [[ "${WINDOW:-none}" == 'none' ]]; then
        WIN_DESC='since the PR opened (no counting window yet)'
        WIN_DESC_ZH='自 PR 创建以来（尚无计数窗口）'
      fi
      if gh pr comment "${PR}" --repo "${REPO}" --body "$(printf '📊 Takeover milestone — round %s/%s, %s. Census: %s pushed fix(es), %s no-change review(s), %s timeout(s), %s rejected attempt(s), %s deliberate stop(s) under instruction (deferred to a human), %s other round(s) (crash / model error / gate error / infra), %s base update(s).\n\nThis many rounds deserves a human look. Options: keep going (fine — nothing changes), split or reduce the PR if rounds keep accumulating, or release takeover (remove the `%s` label or comment `%s stop`). Management continues unchanged unless you act.\n\n<details>\n<summary>中文说明</summary>\n\n📊 接管里程碑 —— 第 %s/%s 轮（%s）。统计：推送修复 %s 次、审阅无需改动 %s 次、超时 %s 次、验证拒绝 %s 次、按指示有意停止（移交人工）%s 次、其他轮次（崩溃/模型错误/门错误/infra）%s 次、base 更新 %s 次。\n\n轮次到这个量值得人工看一眼。可选：继续（无需操作）；若轮次持续累积，考虑拆分或缩减 PR；或释放接管（移除 `%s` 标签或评论 `%s stop`）。不操作则托管照常继续。\n\n</details>\n\n<!-- autofix-milestone round=%s win=%s -->' "${NEXT_ROUND}" "${MAX_ROUNDS}" "${WIN_DESC}" "${N_PUSHED}" "${N_NOOP}" "${N_TIMEOUT}" "${N_REJECTED}" "${N_HANDOFF}" "${N_OTHER}" "${N_BASE}" "${TAKEOVER_LABEL}" "${TAKEOVER_COMMAND}" "${NEXT_ROUND}" "${MAX_ROUNDS}" "${WIN_DESC_ZH}" "${N_PUSHED}" "${N_NOOP}" "${N_TIMEOUT}" "${N_REJECTED}" "${N_HANDOFF}" "${N_OTHER}" "${N_BASE}" "${TAKEOVER_LABEL}" "${TAKEOVER_COMMAND}" "${NEXT_ROUND}" "${WINDOW:-none}")"; then
        echo "📊 milestone digest posted on #${PR} (round ${NEXT_ROUND})"
      else
        echo "::warning::milestone digest failed to post on PR #${PR}; the round report above already landed"
      fi
    fi
  fi
fi

{
  ISSUE_REF=""
  [[ "${ISSUE}" != "${PR}" ]] && ISSUE_REF=" (issue #${ISSUE})"
  echo "### PR #${PR}${ISSUE_REF} — ${STATUS}"
  echo "- Base conflict: ${CONFLICT}"
  echo
  if [[ "${OUTCOME}" == "fixed" ]]; then
    cat "${WORKDIR}/address-summary.md"
  else
    cat "${WORKDIR}/no-action.md"
  fi
} >> "${GITHUB_STEP_SUMMARY}"
echo "💬 PR #${PR}: ${STATUS}"
