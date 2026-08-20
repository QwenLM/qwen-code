#!/usr/bin/env bash
# GitHub does not START RUNS for a workflow file larger than 500 KB (512,000
# bytes), and it says nothing when it stops: schedule ticks vanish, dispatches
# sit "queued" forever with zero jobs, `issues`/`issue_comment` go quiet, and
# only PR-event runs keep working — those resolve the workflow from the PR's
# own branch, so an older, smaller copy runs and the workflow looks half-alive.
# qwen-autofix.yml crossed the line on 2026-08-19 and the autofix loop went
# dark for a day before anyone read the size.
#
# The gate below sits well under the real ceiling on purpose: a PR that trips
# it still has room to land the fix, instead of discovering the wall with no
# space left to move prose out.
set -uo pipefail

GITHUB_LIMIT_BYTES=512000
GATE_BYTES="${WORKFLOW_SIZE_GATE_BYTES:-470000}"
WARN_BYTES=$((GATE_BYTES - 25000))

status=0
shopt -s nullglob
for file in .github/workflows/*.yml .github/workflows/*.yaml; do
  if ! size="$(wc -c <"${file}")"; then
    echo "::error file=${file}::unable to read ${file}"
    status=1
    continue
  fi
  pct=$((size * 100 / GITHUB_LIMIT_BYTES))
  if ((size > GATE_BYTES)); then
    echo "::error file=${file}::${file} is ${size} bytes — ${pct}% of GitHub's ${GITHUB_LIMIT_BYTES}-byte start-runs limit, past this repo's ${GATE_BYTES}-byte gate. Move prose into a sibling .md and long steps into .github/scripts/; do not raise the gate."
    status=1
  elif ((size > WARN_BYTES)); then
    echo "::warning file=${file}::${file} is ${size} bytes (${pct}% of GitHub's limit) — approaching the ${GATE_BYTES}-byte gate."
  fi
done

if ((status == 0)); then
  echo "✅ every workflow file is under the ${GATE_BYTES}-byte gate"
fi
exit "${status}"
