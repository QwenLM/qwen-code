#!/usr/bin/env bash
# File or update the one long-lived issue that says a release-following desktop
# publish failed.
#
# This path is unattended by construction: a CLI release fires it, nobody is
# watching, and a failure is silent everywhere else. The release workflow's own
# failure is just a red run among many, and the symptom users see — the updater
# feed still offering the previous desktop version — looks identical to "no
# desktop release was due". Without this job the fleet-stale lesson repeats:
# the ECS updater failed five times over three days before anyone noticed, and
# the only reason it surfaced at all was the sibling reporter this one copies.
#
# Reads GH_TOKEN, REPO, RUN_ID, RUN_URL, RELEASE_TAG and DEDUP_LABEL from the
# environment. The marker and the dedup lookup are shared with the other
# reporters filing into the same label space — see find-marked-issue.sh.
set -euo pipefail

: "${REPO:?}"
: "${RUN_ID:?}"
: "${RUN_URL:?}"
: "${RELEASE_TAG:?}"
: "${DEDUP_LABEL:?}"

marker_html='<!-- desktop-release-sync-failure -->'

# Name the legs that actually failed. A reusable workflow's jobs share the
# caller's run, so this run's job list already contains them under the caller's
# `Publish desktop for <tag> / ` prefix; `skipped` legs are excluded because a
# failure in `prepare` skips the whole matrix and listing those would claim a
# build failed that was never started.
#
# The read's own status is captured deliberately: `set -e` aborts on a failing
# command substitution feeding an assignment, and "the jobs API could not be
# read" has to reach the issue body rather than kill the reporter.
jobs_status=0
# shellcheck disable=SC2016
failed_legs="$(
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq '
    [ .jobs[]
      | select(.conclusion == "failure" or .conclusion == "timed_out")
      | (.name | sub("^[^/]*/ *"; "")) ]
    | join(", ")
  '
)" || jobs_status=$?

body_file="${RUNNER_TEMP:-/tmp}/desktop-sync-failure.md"
{
  echo "${marker_html}"
  echo
  echo "The desktop app did not follow [\`${RELEASE_TAG}\`](${RUN_URL}): the release-following publish failed, so the updater feed still offers the previous desktop version and every installation stays on it."
  echo
  if (( jobs_status != 0 )); then
    echo "- Failed steps: could not read the jobs API for this run; open the run to see which leg failed."
  elif [[ -n "${failed_legs}" ]]; then
    echo "- Failed: ${failed_legs}"
  else
    echo "- Failed: no job reported a failure, so the publish job itself never started (startup_failure) and no leg ran."
  fi
  echo "- CLI release: \`${RELEASE_TAG}\`"
  echo "- Run: ${RUN_URL}"
  echo
  echo "Nothing else surfaces this. A desktop release that never happens looks exactly like a release that was not due, and this path runs without anyone watching it."
  echo
  echo "To recover: if the \`desktop-${RELEASE_TAG}\` tag does not exist yet, dispatch \`Desktop Release\` by hand with the same version; if it exists, the publish got partway and the re-dispatch needs \`clobber=true\`."
} > "${body_file}"

# Degrade rather than abort: a transient failure on the dedup lookup must not
# take down the report, since a duplicate issue costs far less than the silence
# this job exists to break.
existing="$(
  MARKER_HTML="${marker_html}" \
    bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"
)" || existing=''

if [[ -n "${existing}" ]]; then
  gh issue comment "${existing}" --repo "${REPO}" --body-file "${body_file}"
  echo "Recorded this failure on issue #${existing}."
  exit 0
fi

gh issue create \
  --repo "${REPO}" \
  --title 'Desktop release did not follow the CLI release' \
  --body-file "${body_file}" \
  --label 'type/bug' \
  --label "${DEDUP_LABEL}"
