#!/usr/bin/env bash
# File (or update) one issue when the ECS runner fleet's `qwen` update fails.
#
# The body below is the 'File or update the stale-fleet issue' step of the
# report_failure job in .github/workflows/update-ecs-runner-qwen.yml.
#
# A failed fleet update is otherwise invisible. qwen-code-pr-review.yml and
# qwen-triage.yml install the CLI only when `command -v qwen` finds nothing,
# and on a self-hosted runner it never does, so a pool that misses an update
# keeps answering PRs on the old version with nothing to distinguish it from a
# healthy one. On v0.22.3 three of the four pools 404'd on a version npm had
# not finished publishing and the split fleet went unnoticed for a day.
# main-ci-failure-issue.yml cannot cover this: it watches test suites on
# `main`, and this workflow runs off `repository_dispatch`.
set -euo pipefail

# Name the pools, not just the run: the operator needs to know which ones are
# still answering PRs on the old CLI, and a matrix job's per-leg conclusions
# are not reachable through `needs`.
failed="$(
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq '
    [ .jobs[]
      | select(.name | startswith("Update Qwen on "))
      | select(.conclusion == "failure" or .conclusion == "timed_out")
      | (.name | sub("^Update Qwen on "; "")) ]
    | join(", ")
  '
)" || failed=''

marker_html='<!-- ecs-fleet-update-failure -->'
body_file="${RUNNER_TEMP}/ecs-fleet-update-failure.md"

# The backticks in these formats are literal markdown, not command
# substitution, so shellcheck's SC2016 expansion warning is disabled.
# shellcheck disable=SC2016
{
  printf '%s\n\n' "${marker_html}"
  printf '[`Update ECS Runner Qwen`](%s) failed, so at least one ECS pool is still running an older `qwen` than the release it was asked to install.\n\n' "${RUN_URL}"
  printf -- '- Target version: `%s`\n' "${VERSION:-unresolved}"
  printf -- '- Pools left stale: %s\n' "${failed:-see the run; no pool reported a conclusion}"
  printf -- '- Run: %s\n\n' "${RUN_URL}"
  printf 'Nothing else surfaces this. The review and triage workflows install `qwen` only when `command -v qwen` finds nothing, which on a self-hosted runner is never, so a stale pool keeps reviewing PRs on the old CLI until someone reads a version string.\n\n'
  printf 'To repair: re-run **Update ECS Runner Qwen** through `workflow_dispatch` (an empty version means latest), then read the `Verify version` step of every pool.\n'
} > "${body_file}"

# Dedup by an exact body marker, matched CLIENT-side: GitHub search tokenizes
# the marker apart, so a search-based lookup never finds what this script
# files. The label narrows the listing to issues this kind of job owns, and is
# applied at creation so the dedup key can never be half-written.
issues_file="${RUNNER_TEMP}/open-issues.json"
gh issue list \
  --repo "${REPO}" \
  --state open \
  --label "${DEDUP_LABEL}" \
  --json number,body \
  --limit 200 \
  > "${issues_file}"
existing="$(
  jq -r --arg marker_html "${marker_html}" \
    '.[] | select(.body | contains($marker_html)) | .number' \
    "${issues_file}" \
  | head -n 1
)"

# A comment, not a body rewrite: this fails rarely enough that one line per
# occurrence is the history the operator wants, and it notifies subscribers
# that the fleet went stale again.
if [[ -n "${existing}" ]]; then
  gh issue comment "${existing}" --repo "${REPO}" --body-file "${body_file}"
  echo "Recorded this failure on issue #${existing}."
  exit 0
fi

gh issue create \
  --repo "${REPO}" \
  --title 'ECS runner fleet is stale: the qwen update failed' \
  --body-file "${body_file}" \
  --label 'type/bug' \
  --label "${DEDUP_LABEL}"
