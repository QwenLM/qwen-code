#!/usr/bin/env bash
# Choose the Managed Agent tier and print it to GITHUB_OUTPUT.
set -euo pipefail

run_reports_full() {
  local run="$1"
  local pr_scoped="$2"
  local event prs run_branch metadata current_pr current_sha current_ref jobs

  [[ "${run}" != "${RUN_ID}" ]] || return 1
  metadata="$(gh api "repos/${REPO}/actions/runs/${run}" \
    --jq '[.event, (([.pull_requests[].number] | map(tostring) | join(" ")) | if . == "" then "-" else . end), (.head_branch // "")] | @tsv')" || exit 1
  IFS=$'\t' read -r event prs run_branch <<< "${metadata}"
  [[ -n "${event}" ]] || exit 1
  [[ "${event}" == 'pull_request_review' ]] || return 1

  if [[ "${pr_scoped}" == 'true' ]]; then
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
  fi

  jobs="$(gh api "repos/${REPO}/actions/runs/${run}/jobs?per_page=100" \
    --jq '[.jobs[].name | startswith("SDK Java (full)")] | any')" || exit 1
  [[ "${jobs}" == 'true' ]]
}

# A reopened or rerun pull request must not let a new fast result replace an
# existing full result on the same head. That required context is per SHA, so
# any review run with the full callee counts here — including fork runs whose
# pull_requests list is empty.
prior_full_reported=false
if [[ "${TOUCHED}" == 'true' && "${EVENT_NAME}" == 'pull_request' ]]; then
  urls="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs?check_name=Managed%20Agent%20gate&filter=all&per_page=100" \
    --jq '.check_runs[].details_url')" || exit 1
  for run in $({ grep -oE '/runs/[0-9]+/' <<< "${urls}" || true; } | tr -dc '0-9\n' | sort -u); do
    if run_reports_full "${run}" false; then
      prior_full_reported=true
      break
    fi
  done
fi

tier=none
if [[ "${TOUCHED}" == 'true' ]]; then
  case "${EVENT_NAME}" in
    pull_request)
      if [[ "${prior_full_reported}" != 'true' ]]; then
        tier=fast
      fi
      ;;
    push | merge_group) tier=fast ;;
    pull_request_review)
      # A maintainer's approval only: an empty association fails closed.
      if [[ "${REVIEW_STATE}" == 'approved' && "${BASE_REF}" == 'main' &&
        ' OWNER MEMBER COLLABORATOR ' == *" ${REVIEW_AUTHOR_ASSOCIATION} "* ]]; then
        tier=full
        urls="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs?check_name=Managed%20Agent%20gate&per_page=100" \
          --jq '.check_runs[] | select(.status != "completed" or .conclusion == "success") | .details_url')" || exit 1
        for run in $({ grep -oE '/runs/[0-9]+/' <<< "${urls}" || true; } | tr -dc '0-9\n' | sort -u); do
          if run_reports_full "${run}" true; then
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
