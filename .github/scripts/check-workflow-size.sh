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

# The gate above is the ceiling; the baseline below is the RATCHET. The gate
# alone only objects once a file is nearly at the wall, so growth accumulates
# invisibly until one unlucky PR has to pay for everyone: qwen-autofix.yml
# regained 78 KB when its prose moved out (#9517) and gave 25 KB of it back in
# a single feature commit two days later, unremarked. Each file's recorded size
# lives in .size-baseline; exceeding it by more than the allowance fails until
# the number is updated in the same PR, which turns the drift into one line a
# reviewer sees.
BASELINE_FILE='.github/workflows/.size-baseline'
GROWTH_ALLOWANCE="${WORKFLOW_SIZE_GROWTH_ALLOWANCE:-4096}"
# Loose enough that ordinary edits do not churn the manifest, tight enough that
# a file which shed real weight gets its baseline reclaimed rather than banking
# the slack for the next unreviewed 25 KB.
SLACK_BYTES=20000

status=0
declare -A baseline=()
if [[ -r "${BASELINE_FILE}" ]]; then
  # The || clause keeps an unterminated final line, which read reports as a
  # failure and the loop would otherwise silently drop.
  while read -r recorded name extra || [[ -n "${recorded}" ]]; do
    [[ -z "${recorded}" || "${recorded}" == \#* ]] && continue
    # Fail closed on malformed lines: bash evaluates a leading-zero value as
    # OCTAL at the arithmetic sites below, a non-numeric one errors both
    # comparisons to false (the ratchet would fail OPEN), and extra fields
    # key differently in the vitest mirror.
    if [[ -z "${name}" || -n "${extra}" || ! "${recorded}" =~ ^(0|[1-9][0-9]*)$ ]]; then
      echo "::error file=${BASELINE_FILE}::${BASELINE_FILE} entry '${recorded}${name:+ ${name}}${extra:+ ${extra}}' is malformed — expected exactly '<bytes> <file>' with a decimal byte count (no leading zeros)"
      status=1
      continue
    fi
    baseline["${name}"]="${recorded}"
  done <"${BASELINE_FILE}"
else
  echo "::error::${BASELINE_FILE} is missing or unreadable — the growth ratchet cannot run"
  exit 1
fi

shopt -s nullglob
for file in .github/workflows/*.yml .github/workflows/*.yaml; do
  if ! size="$(wc -c <"${file}")"; then
    echo "::error file=${file}::unable to read ${file}"
    status=1
    continue
  fi
  size="${size// /}"
  pct=$((size * 100 / GITHUB_LIMIT_BYTES))
  if ((size > GATE_BYTES)); then
    echo "::error file=${file}::${file} is ${size} bytes — ${pct}% of GitHub's ${GITHUB_LIMIT_BYTES}-byte start-runs limit, past this repo's ${GATE_BYTES}-byte gate. Move prose into a sibling .md and long steps into .github/scripts/; do not raise the gate."
    status=1
  elif ((size > WARN_BYTES)); then
    echo "::warning file=${file}::${file} is ${size} bytes (${pct}% of GitHub's limit) — approaching the ${GATE_BYTES}-byte gate."
  fi

  base="${baseline[${file##*/}]:-}"
  if [[ -z "${base}" ]]; then
    echo "::error file=${file}::${file} has no entry in ${BASELINE_FILE}. Add '${size} ${file##*/}' so its growth is tracked."
    status=1
  elif ((size > base + GROWTH_ALLOWANCE)); then
    echo "::error file=${file}::${file} grew to ${size} bytes, $((size - base)) over its recorded ${base} (allowance ${GROWTH_ALLOWANCE}). Move prose into a sibling .md and long steps into .github/scripts/ — or, if the growth is real, update ${BASELINE_FILE} in this PR and say why."
    status=1
  elif ((size + SLACK_BYTES < base)); then
    echo "::warning file=${file}::${file} is ${size} bytes, $((base - size)) under its recorded ${base} — lower the entry in ${BASELINE_FILE} so the slack is not banked."
  fi
done

if ((status == 0)); then
  echo "✅ every workflow file is under the ${GATE_BYTES}-byte gate and within ${GROWTH_ALLOWANCE} bytes of its recorded baseline"
fi
exit "${status}"
