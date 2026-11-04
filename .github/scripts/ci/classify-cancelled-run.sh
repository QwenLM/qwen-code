#!/usr/bin/env bash
# Classify a cancelled main CI run by positive annotation evidence (#16272) and
# echo `timeout`, `concurrency`, `nothing-executed`, or `unknown`. Shared by the
# current-run gate and the successor-ownership check in
# main-ci-failure-issue.yml so the two cannot drift:
#   timeout          - a job carries the execution-time annotation (a real
#                      breakage that concludes cancelled, #16214); wins even
#                      when a shutdown annotation coexists on the same job.
#   concurrency      - shutdown / higher-priority / operation-canceled
#                      annotations and no timeout (a deliberate supersede).
#   nothing-executed - no cancelled job ran a step, so there is no breakage to
#                      report (#16280 R1-2). Its own token because the caller
#                      must not name an annotation this path never read (#16280
#                      R3-2).
#   unknown          - cancelled jobs ran steps but their annotations could not
#                      be read or matched neither pattern, a job concluded
#                      failure/timed_out under the cancelled run (#16280 R3-1),
#                      or the jobs pages could not be certified complete;
#                      callers fail open on this so an unclassifiable
#                      cancellation cannot hide.
set -uo pipefail

REPO="${REPO:?REPO must name the repository}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
run_id="$1"
attempt="$2"
pages="${RUNNER_TEMP}/cancel-jobs-${run_id}-${attempt}.json"

if ! gh api "repos/${REPO}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" \
  --paginate > "${pages}" 2>/dev/null; then
  echo unknown
  exit 0
fi
# Certify the merged pages against the total_count receipt, like the download
# step: a partial list must read as unknown, not as a complete one that happens
# to lack the timed-out job.
if ! jq -e -s '([.[].total_count] | max) as $t | ([.[].jobs[]?] | length) as $n | $t != null and $n == $t' \
  "${pages}" >/dev/null 2>&1; then
  echo unknown
  exit 0
fi

# A cancelled run can still carry a job that concluded failure or timed_out: a
# job fails, then the next push entering the concurrency group (or a runner
# shutdown) cancels the rest of the run. Reading only `cancelled` jobs would
# call that a deliberate supersede and drop the regression (#16280 R3-1).
if ! failed_jobs="$(
  jq -e -s '[.[].jobs[]?] | map(select(.conclusion == "failure" or .conclusion == "timed_out")) | length' \
    "${pages}" 2>/dev/null
)"; then
  echo unknown
  exit 0
fi
if [[ "${failed_jobs}" -gt 0 ]]; then
  echo unknown
  exit 0
fi

timeout_found=false
concurrency_found=false
cancelled_seen=false
executed_seen=false
while IFS=$'\t' read -r _ check_run_id steps_run; do
  [[ -n "${check_run_id}" ]] || continue
  cancelled_seen=true
  if [[ "${steps_run:-0}" -gt 0 ]]; then
    executed_seen=true
  fi
  if ! annotations="$(
    gh api --paginate \
      "repos/${REPO}/check-runs/${check_run_id}/annotations" \
      --jq '[.[].message] | join("\n")' 2>/dev/null
  )"; then
    echo unknown
    exit 0
  fi
  if grep -qiE 'exceeded the maximum execution time' <<< "${annotations}"; then
    timeout_found=true
  fi
  if grep -qiE 'Canceling since a higher priority|shutdown signal|operation was canceled' <<< "${annotations}"; then
    concurrency_found=true
  fi
done < <(
  jq -r -s '[.[].jobs[]?] | .[] | select(.conclusion == "cancelled") | [(.id | tostring), ((.check_run_url // "") | split("/")[-1]), (((.steps // []) | length) | tostring)] | @tsv' \
    "${pages}" 2>/dev/null
)

if [[ "${timeout_found}" == 'true' ]]; then
  echo timeout
elif [[ "${concurrency_found}" == 'true' ]]; then
  echo concurrency
elif [[ "${cancelled_seen}" != 'true' || "${executed_seen}" != 'true' ]]; then
  # Nothing executed: either the run carried no cancelled job at all
  # (displaced while queued, or cancelled after only success/skipped jobs), or
  # every cancelled job stopped before its first step. There is no breakage to
  # report, and the caller must not name an annotation this path never read
  # (#16280 R1-2, R3-2).
  echo nothing-executed
else
  echo unknown
fi
