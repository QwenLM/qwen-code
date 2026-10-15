#!/usr/bin/env bash
# File (or comment on) one issue when the nightly CodeQL scan does not finish.
#
# The body below is the 'File or update the CodeQL failure issue' step of the
# report_failure job in .github/workflows/codeql.yml.
#
# The scan is schedule-only and never a required check, so nothing turns red
# when it dies: the old shared 30-minute cap cancelled 57 of 59 nightlies and
# the Security tab silently stopped updating for weeks (#13249).
# main-ci-failure-issue.yml cannot cover this: it files autofix-routed issues
# keyed on failing tests, a timeout has no failing test, and it only fires on
# `failure` while a `timeout-minutes` overrun reports `cancelled`.
set -euo pipefail

# Name the legs that did not finish, so the issue says which language lost its
# coverage. A failed read degrades to "see the run" instead of killing the
# report — `x=$(false)` aborts under `set -e`, hence the `||`.
legs=''
legs="$(
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq '
    [ .jobs[]
      | select(.name | startswith("CodeQL ("))
      | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
      | "\(.name): \(.conclusion)" ] | join(", ")
  '
)" || legs=''

marker_html='<!-- codeql-nightly-failure -->'
body_file="${RUNNER_TEMP}/codeql-failure.md"

# The backticks in these formats are literal markdown, not command
# substitution, so shellcheck's SC2016 expansion warning is disabled.
# shellcheck disable=SC2016
{
  printf '%s\n\n' "${marker_html}"
  printf 'The nightly [`CodeQL`](%s) scan did not finish, so the Security tab is not being updated.\n\n' "${RUN_URL}"
  printf -- '- Legs: %s\n' "${legs:-see the run; the job conclusions could not be read}"
  printf -- '- Run: %s\n\n' "${RUN_URL}"
  printf 'A `cancelled` leg usually means it overran its `timeout-minutes` in `.github/workflows/codeql.yml`: compare the `Perform CodeQL Analysis` duration with the cap, then raise the cap or re-run through `workflow_dispatch`.\n'
} > "${body_file}"

# Dedup by an exact body marker — see find-marked-issue.sh. A lookup failure
# degrades to a possible duplicate rather than silence.
existing="$(
  MARKER_HTML="${marker_html}" \
    bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"
)" || existing=''

# One comment per failed night is the history the operator wants, and it
# notifies subscribers that the scan died again.
if [[ -n "${existing}" ]]; then
  gh issue comment "${existing}" --repo "${REPO}" --body-file "${body_file}"
  echo "Recorded this failure on issue #${existing}."
  exit 0
fi

gh issue create \
  --repo "${REPO}" \
  --title 'Nightly CodeQL scan did not finish' \
  --body-file "${body_file}" \
  --label 'type/bug' \
  --label "${DEDUP_LABEL}"
