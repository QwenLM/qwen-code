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
# are not reachable through `needs`. The prefix is the `update` job's
# `name:` template with `${{ matrix.runner }}` stripped; the workflow suite
# pins the two together, since a rename that only lands on one side would
# quietly name no pools at all.
#
# One call reports both how many pool legs actually ran and which of them are
# stale. `skipped` legs are excluded on purpose: when `resolve` fails the whole
# matrix is skipped, yet the jobs API still lists every leg under its fully
# expanded name, so counting those would make the "no pool was reached" shape
# below unreachable and file a pool-level claim about a run where no pool was
# ever asked to install anything.
#
# The read's own status is captured because `set -e` DOES abort on a failing
# command substitution that feeds an assignment (`x=$(false)` exits 1) — the
# `|| jobs_status=$?` below is load-bearing, not a belt on top of braces, and
# "the jobs API could not be read" has to reach the body instead of killing
# the reporter.
jobs_status=0
# The jq filter's `$legs`/`$stale` are jq bindings, not shell expansions.
# shellcheck disable=SC2016
jobs_summary="$(
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq '
    [ .jobs[]
      | select(.name | startswith("Update Qwen on "))
      | select(.conclusion != "skipped") ] as $legs
    | [ $legs[]
        | select(.conclusion == "failure" or .conclusion == "timed_out")
        | (.name | sub("^Update Qwen on "; "")) ] as $stale
    | "\($legs | length)\t\($stale | join(", "))"
  '
)" || jobs_status=$?

legs=''
failed=''
if (( jobs_status == 0 )); then
  legs="${jobs_summary%%$'\t'*}"
  failed="${jobs_summary#*$'\t'}"
fi

# Three shapes, because they send the operator to three different places. The
# backticks below are literal markdown, not command substitution.
# shellcheck disable=SC2016
if (( jobs_status != 0 )); then
  # Which shape failed is exactly what could not be read, so this branch must
  # not assert one: `resolve` may have failed before any pool ran, and naming
  # `Verify version` steps that never existed is guidance, not information.
  headline='failed, but the job conclusions for this run could not be read, so which pools are affected is not yet known.'
  pools='unknown — the job conclusions for this run could not be read'
  repair='open the run above and check whether the pool matrix started at all — read the `Resolve version` step first when the target version below shows `unresolved`, the `Verify version` step of each pool otherwise — then re-run **Update ECS Runner Qwen** through `workflow_dispatch` (an empty version means latest).'
elif [[ "${legs}" == '0' ]]; then
  # `needs.resolve.result == 'failure'` also opens this gate, and then no pool
  # was ever asked to install anything: claiming a pool-level state that never
  # happened would send a 3 AM operator to pool logs that do not exist.
  headline='failed before any pool was asked to install a release, so the fleet is still on whatever `qwen` it already had.'
  pools='none was reached — the run failed before the pool matrix started'
  repair='read the `Resolve version` step on the run above (a version npm has not published is the usual cause), then re-run **Update ECS Runner Qwen** through `workflow_dispatch` once it resolves.'
else
  headline='failed, so at least one ECS pool is still running an older `qwen` than the release it was asked to install.'
  pools="${failed:-see the run; no pool reported a conclusion}"
  repair='re-run **Update ECS Runner Qwen** through `workflow_dispatch` (an empty version means latest), then read the `Verify version` step of every pool.'
fi

marker_html='<!-- ecs-fleet-update-failure -->'
body_file="${RUNNER_TEMP}/ecs-fleet-update-failure.md"

# The backticks in these formats are literal markdown, not command
# substitution, so shellcheck's SC2016 expansion warning is disabled.
# shellcheck disable=SC2016
{
  printf '%s\n\n' "${marker_html}"
  printf '[`Update ECS Runner Qwen`](%s) %s\n\n' "${RUN_URL}" "${headline}"
  printf -- '- Target version: `%s`\n' "${VERSION:-unresolved}"
  printf -- '- Pools left stale: %s\n' "${pools}"
  printf -- '- Run: %s\n\n' "${RUN_URL}"
  printf 'Nothing else surfaces this. The review and triage workflows install `qwen` only when `command -v qwen` finds nothing, which on a self-hosted runner is never, so a stale pool keeps reviewing PRs on the old CLI until someone reads a version string.\n\n'
  printf 'To repair: %s\n' "${repair}"
} > "${body_file}"

# Dedup by an exact body marker; the lookup itself is shared with the sibling
# reporter that files into the same label space — see find-marked-issue.sh for
# why it is matched client-side and why the listing is not a window. The label
# is applied at creation below, so the dedup key can never be half-written.
# Degrade rather than abort: a transient 5xx or rate-limit on the lookup must
# not take the whole report down (`set -e` would kill it here), because a rare
# duplicate issue costs far less than the silence this job exists to break.
existing="$(
  MARKER_HTML="${marker_html}" \
    bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"
)" || existing=''

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
