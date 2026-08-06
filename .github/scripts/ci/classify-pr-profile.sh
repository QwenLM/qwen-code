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

tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
files="${tmp}/classify-pr-${pr}-files.jsonl"

if ! gh api --paginate "repos/${repo}/pulls/${pr}/files" \
    --jq '.[] | {filename, status, previous_filename}' > "${files}"; then
  exit 2
fi

node "$(dirname "$0")/classify-profile.mjs" "${files}" || exit 3
