#!/usr/bin/env bash
# Classify a cancelled main CI run by positive annotation evidence (#16272) and
# echo `timeout`, `concurrency`, or `unknown`. Shared by the current-run gate and
# the successor-ownership check in main-ci-failure-issue.yml so the two cannot
# drift:
#   timeout     - a job carries the execution-time annotation (a real breakage
#                 that concludes cancelled, #16214); wins even when a shutdown
#                 annotation coexists on the same job.
#   concurrency - shutdown / higher-priority / operation-canceled annotations
#                 and no timeout (a deliberate supersede), OR a cancelled run
#                 with no cancelled job at all (it ran nothing; #16280 R1-2).
#   unknown     - cancelled jobs exist but their annotations could not be read
#                 or matched neither pattern, or the jobs pages could not be
#                 certified complete; callers fail open on this so an
#                 unclassifiable cancellation cannot hide.
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

timeout_found=false
concurrency_found=false
cancelled_seen=false
while IFS=$'\t' read -r _ check_run_id; do
  [[ -n "${check_run_id}" ]] || continue
  cancelled_seen=true
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
  jq -r -s '[.[].jobs[]?] | .[] | select(.conclusion == "cancelled") | [(.id | tostring), ((.check_run_url // "") | split("/")[-1])] | @tsv' \
    "${pages}" 2>/dev/null
)

if [[ "${timeout_found}" == 'true' ]]; then
  echo timeout
elif [[ "${concurrency_found}" == 'true' ]]; then
  echo concurrency
elif [[ "${cancelled_seen}" != 'true' ]]; then
  # A cancelled run with no cancelled job ran nothing (displaced while queued,
  # or cancelled after only success/skipped jobs): there is no breakage to
  # report, so treat it as a supersede rather than failing open (#16280 R1-2).
  echo concurrency
else
  echo unknown
fi
