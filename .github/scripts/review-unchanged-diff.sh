#!/usr/bin/env bash
# Decide whether a `synchronize` push left the pull request's diff against
# its base byte-identical to a head this workflow has ALREADY reviewed — the
# shape of an update-branch merge of main (measured 2026-09-08/09: 241 of 755
# automatic reviews, 32%, ran on such a head). Used by qwen-code-pr-review.yml
# ("Run review") to skip the review; the caller records the skip as a
# `qwen-review/reviewed` commit status on the new head so the next merge only
# has to look one commit back.
#
# Prints ONE verdict line on stdout, diagnostics on stderr:
#   unchanged <reviewed-sha>   same diff as an already-reviewed ancestor
#   changed <reason>           anything else — the caller reviews in full
# Exit status is 0 for either verdict; a broken environment (no git, no gh)
# still prints `changed <reason>` so a failure here can only cost a review,
# never skip one.
#
# WHY THE ANCHOR IS A COMMIT STATUS. The obvious anchor — "compare with the
# push's `before` sha" — has a hole: push A (a real change) queues a review,
# push B (merge main) supersedes A's pending run in the PR concurrency
# group, B's diff equals A's, so B is skipped and A's change is NEVER
# reviewed. The anchor must therefore be a head the review actually
# completed on. Bot review comments cannot be that anchor (R13-1: the
# reviewed agent authors every input such a lookup has, and cede/skip runs
# make "a successful run" true without posting). A commit status written by
# the workflow's own token from a step the agent never runs in cannot be
# authored by the PR, so `qwen-review/reviewed` on a commit means exactly
# "this diff was reviewed (or equals one that was)". Two narrowings make that
# hold: the status is written by the workflow's `record-reviewed` job, not
# by review-pr (whose GITHUB_TOKEN the agent can read), on the EVENT's head;
# and only statuses whose creator is github-actions[bot] count here, so one
# written with CI_BOT_PAT — also within the agent's reach — is ignored.
#
# WHY sha256 OF THE DIFF, NOT git patch-id. patch-id ignores whitespace, so a
# formatting-only push would be skipped as "unchanged"; the raw diff (with
# --full-index blob ids, which also fingerprint binary changes) is exact.
# Every command-valued setting a reachable git config could otherwise use to
# rewrite those bytes is neutralized on the diff itself: diff.external and
# diff.<driver>.command by --no-ext-diff, diff.<driver>.textconv by
# --no-textconv. A textconv filter that prints a constant makes two different
# blobs compare equal, so git drops the file from the diff entirely — no
# `index` line survives to differ — every head then hashes as the empty digest
# and any reviewed ancestor anchors a false skip.
# Context lines are part of the diff on purpose: when main edits a file the
# PR also touches, the PR's diff against the new base differs and the
# review runs — that is the case a merge can break.
#
# Usage: review-unchanged-diff.sh <owner/repo> <pr-number> <head-sha> <base-ref>
# Env:   GH_TOKEN  read access for the commit status lookup
set -uo pipefail

REPO="${1:-}"
PR_NUMBER="${2:-}"
HEAD_SHA="${3:-}"
BASE_REF="${4:-}"
# Constants, not environment knobs. STATUS_CREATOR in particular IS the trust
# boundary: only statuses the workflow's own identity wrote may anchor a
# skip, and nothing in the environment can widen that.
STATUS_CONTEXT='qwen-review/reviewed'
STATUS_CREATOR='github-actions[bot]'
LOOKBACK=20
REMOTE=origin
TMP_REF="refs/qwen-review-skip/pr-${PR_NUMBER}"

log() { printf '%s\n' "unchanged-diff: $*" >&2; }
verdict() { printf '%s\n' "$*"; exit 0; }

if [ -z "$REPO" ] || [ -z "$PR_NUMBER" ] || [ -z "$HEAD_SHA" ] || [ -z "$BASE_REF" ]; then
  verdict "changed missing-arguments"
fi
case "$PR_NUMBER" in ''|*[!0-9]*) verdict "changed bad-pr-number" ;; esac
case "$HEAD_SHA" in
  *[!0-9a-fA-F]*|'') verdict "changed bad-head-sha" ;;
esac
case "$BASE_REF" in
  ''|-*|*..*|*/) verdict "changed bad-base-ref" ;;
esac

# Hooks and fsmonitor off: the objects fetched below are the PR's, and the
# repository's own hooks are irrelevant to a read-only fingerprint.
GIT=(git -c core.hooksPath=/dev/null -c core.fsmonitor=)

cleanup() { "${GIT[@]}" update-ref -d "$TMP_REF" 2>/dev/null || true; }
trap cleanup EXIT

if ! "${GIT[@]}" fetch --no-tags --quiet "$REMOTE" \
    "+refs/pull/${PR_NUMBER}/head:${TMP_REF}" \
    "+refs/heads/${BASE_REF}:refs/remotes/${REMOTE}/${BASE_REF}" 2>&2; then
  verdict "changed fetch-failed"
fi

fetched="$("${GIT[@]}" rev-parse --verify --quiet "${TMP_REF}^{commit}" || true)"
if [ -z "$fetched" ]; then
  verdict "changed no-pr-head"
fi
if [ "$fetched" != "$HEAD_SHA" ]; then
  # The caller's stale-head guard already compared against the API; a move
  # between that check and this fetch is a race the queued replacement run
  # owns, not a skip.
  log "PR head is ${fetched}, expected ${HEAD_SHA}"
  verdict "changed head-moved"
fi

BASE_TIP="refs/remotes/${REMOTE}/${BASE_REF}"
if ! "${GIT[@]}" rev-parse --verify --quiet "${BASE_TIP}^{commit}" >/dev/null; then
  verdict "changed no-base-ref"
fi

# sha256 of the PR's diff against its merge-base with the base branch.
fingerprint() {
  local sha="$1" mb hasher
  mb="$("${GIT[@]}" merge-base "$BASE_TIP" "$sha" 2>/dev/null)" || return 1
  [ -n "$mb" ] || return 1
  # sha256sum is coreutils; macOS ships shasum instead. Bare, a missing binary
  # exits 127 into `changed no-merge-base` — a missing hasher reported as a
  # missing merge base, sending the reader to the wrong mechanism.
  if command -v sha256sum > /dev/null 2>&1; then
    hasher=(sha256sum)
  else
    hasher=(shasum -a 256)
  fi
  "${GIT[@]}" diff --no-color --no-ext-diff --no-textconv --no-renames --full-index "$mb" "$sha" \
    | "${hasher[@]}" | cut -d' ' -f1
}

head_fp="$(fingerprint "$HEAD_SHA")" || verdict "changed no-merge-base"
[ -n "$head_fp" ] || verdict "changed empty-fingerprint"

# Walk the PR branch's own line (first parent — the second parent of an
# update-branch merge is main) looking for the nearest head that carries the
# reviewed status. Stop at the base branch: a commit already on main can only
# carry the status from a merged PR, and its diff against main is empty.
inspected=0
while read -r sha; do
  [ -n "$sha" ] || continue
  if "${GIT[@]}" merge-base --is-ancestor "$sha" "$BASE_TIP" 2>/dev/null; then
    log "reached base branch at ${sha} after ${inspected} ancestor(s) without a reviewed status"
    verdict "changed no-reviewed-ancestor"
  fi
  inspected=$((inspected + 1))
  if [ "$inspected" -gt "$LOOKBACK" ]; then
    verdict "changed lookback-exhausted"
  fi
  # The statuses LIST, not the combined status: only the list carries the
  # creator, and the creator is what makes the anchor unforgeable.
  status_json="$(gh api "repos/${REPO}/commits/${sha}/statuses?per_page=100" 2>/dev/null)" || {
    log "status lookup failed for ${sha}"
    verdict "changed status-lookup-failed"
  }
  reviewed="$(printf '%s' "$status_json" | jq -r --arg ctx "$STATUS_CONTEXT" --arg who "$STATUS_CREATOR" \
    '[.[]? | select(.context == $ctx and .state == "success" and (.creator.login // "") == $who)] | length' 2>/dev/null)" || reviewed=0
  if [ "${reviewed:-0}" -gt 0 ]; then
    anchor_fp="$(fingerprint "$sha")" || verdict "changed anchor-no-merge-base"
    if [ "$anchor_fp" = "$head_fp" ]; then
      log "head ${HEAD_SHA} has the same diff against ${BASE_REF} as reviewed ${sha}"
      verdict "unchanged ${sha}"
    fi
    log "reviewed ancestor ${sha} has a different diff against ${BASE_REF}"
    verdict "changed diff-differs"
  fi
done < <("${GIT[@]}" rev-list --first-parent --skip=1 --max-count="$((LOOKBACK + 1))" "$HEAD_SHA" 2>/dev/null)

verdict "changed no-reviewed-ancestor"
