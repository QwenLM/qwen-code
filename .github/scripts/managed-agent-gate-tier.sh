#!/usr/bin/env bash
# Choose the Managed Agent tier and print it to GITHUB_OUTPUT.
set -euo pipefail

run_reports_full() {
  local run="$1"
  local event prs run_branch metadata current_pr current_sha current_ref jobs

  [[ "${run}" != "${RUN_ID}" ]] || return 1
  metadata="$(gh api "repos/${REPO}/actions/runs/${run}" \
    --jq '[.event, (([.pull_requests[].number] | map(tostring) | join(" ")) | if . == "" then "-" else . end), (.head_branch // "")] | @tsv')" || exit 1
  IFS=$'\t' read -r event prs run_branch <<< "${metadata}"
  [[ -n "${event}" ]] || exit 1
  [[ "${event}" == 'pull_request_review' ]] || return 1

  if [[ "${prs}" != '-' ]]; then
    [[ " ${prs} " == *" ${PR_NUMBER} "* ]] || return 1
  else
    # Fork review runs omit pull_requests. Match the candidate run's branch
    # to this PR after confirming that the PR still points at HEAD_SHA.
    current_pr="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" \
      --jq '[.head.sha, .head.ref] | @tsv')" || exit 1
    IFS=$'\t' read -r current_sha current_ref <<< "${current_pr}"
    [[ "${current_sha}" == "${HEAD_SHA}" && "${run_branch}" == "${current_ref}" ]] || return 1
  fi

  jobs="$(gh api "repos/${REPO}/actions/runs/${run}/jobs?per_page=100" \
    --jq '[.jobs[].name | startswith("SDK Java (full)")] | any')" || exit 1
  [[ "${jobs}" == 'true' ]]
}

tier=none
if [[ "${COVERAGE}" != 'none' ]]; then
  case "${EVENT_NAME}" in
    pull_request | push | merge_group)
      if [[ "${COVERAGE}" != 'background' ]]; then
        tier=fast
      fi
      ;;
    pull_request_review)
      # A maintainer's approval only: an empty association fails closed.
      if [[ "${REVIEW_STATE}" == 'approved' && "${BASE_REF}" == 'main' &&
        ' OWNER MEMBER COLLABORATOR ' == *" ${REVIEW_AUTHOR_ASSOCIATION} "* ]]; then
        tier=full
        urls="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs?check_name=Managed%20Agent%20full%20suite&per_page=100" \
          --jq '.check_runs[] | select(.status != "completed" or .conclusion == "success") | .details_url')" || exit 1
        for run in $({ grep -oE '/runs/[0-9]+/' <<< "${urls}" || true; } | tr -dc '0-9\n' | sort -u); do
          if run_reports_full "${run}"; then
            echo "Run ${run} already covers ${HEAD_SHA}."
            tier=none
            break
          fi
        done
      fi
      ;;
  esac
fi
echo "tier=${tier}" >> "${GITHUB_OUTPUT}"
