#!/usr/bin/env bash
# Fetch a PR's changed files and classify its CI profile in one step.
#
# The jq projection below is the input contract of classify-profile.mjs
# (it reads `filename`, `status`, `previous_filename` per JSONL entry).
# Both ci.yml's profile gate and qwen-code-pr-review.yml's docs-only
# downgrade consume the classification through THIS script, so the contract
# lives in exactly one place — a divergence between the two call sites once
# meant the same PR could classify differently in each workflow, silently,
# because both fall back to `full` on their own errors.
#
# Usage: classify-pr-profile.sh <owner/repo> <pr-number>
# Prints the profile (docs_only | github_ci_only | full) on stdout.
# Exit codes: 0 classified; 2 file listing failed; 3 classifier failed.
set -euo pipefail

repo="${1:?usage: classify-pr-profile.sh <owner/repo> <pr-number>}"
pr="${2:?usage: classify-pr-profile.sh <owner/repo> <pr-number>}"

# mktemp + trap, not a fixed name: the self-hosted pool is persistent and
# shared, so a predictable path is a leftover-file landmine, and ci.yml's
# gate and the review gate can run concurrently for the same PR — two
# writers interleaving one JSONL would classify one job against the other
# job's file list.
tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
files="$(mktemp "${tmp}/classify-pr-${pr}-files.XXXXXX")"
trap 'rm -f "$files"' EXIT

if ! gh api --paginate "repos/${repo}/pulls/${pr}/files" \
    --jq '.[] | {filename, status, previous_filename}' > "${files}"; then
  exit 2
fi

# The list-files endpoint caps at 3,000 entries. A truncated listing can be
# all docs while an omitted later entry is source, so any mismatch against
# the PR's own changed-file count conservatively classifies as `full`.
declared="$(gh api "repos/${repo}/pulls/${pr}" --jq '.changed_files')" || exit 2
retrieved="$(wc -l < "${files}")"
if [ "${retrieved}" -ne "${declared}" ]; then
  echo "classify-pr-profile: retrieved ${retrieved} file entries but PR declares ${declared}; classifying full." >&2
  echo "full"
  exit 0
fi

node "$(dirname "$0")/classify-profile.mjs" "${files}" || exit 3
