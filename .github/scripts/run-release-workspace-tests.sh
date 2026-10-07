#!/usr/bin/env bash
set -eo pipefail

shard="${1:?usage: run-release-workspace-tests.sh <shard>}"
retry_arg=()
if [ -n "${VITEST_RETRY}" ] && [ "${VITEST_RETRY}" != 'off' ]; then
  retry_arg=("--retry=${VITEST_RETRY}")
fi

# `tee` so the annotation can name WHICH failure this is: a shard killed by
# Vitest's own worker RPC timing out reads identically to a real break, and this
# release lost two attempts to that (run 33713579913). The status is re-raised
# untouched either way; this script supplies `-o pipefail`, so `$?` is npm's.
log="${RUNNER_TEMP:-/tmp}/workspace-tests-${shard}.log"
npm run test:release:workspaces -- --shard="${shard}/3" --passWithNoTests "${retry_arg[@]}" 2>&1 | tee "${log}" || {
  status=$?
  if grep -qE '^[[:space:]]*FAIL ' "${log}"; then
    : # A failing test names itself; an annotation adds nothing.
  elif grep -q '\[vitest-worker\]: Timeout calling' "${log}"; then
    # Vitest's worker RPC giving up says nothing about the product, and
    # --retry cannot cover it — retries re-run failing TESTS while an
    # unhandled error fails the run outright. It has now cost this release
    # three attempts (run 33713579913).
    #
    # Passed only with proof the run reached its end and that every unhandled
    # error WAS the transport. That proof is Vitest's own count rather than a
    # reading of the crash: it prints `Errors  N errors` whenever unhandled
    # errors occurred, so the guard compares that count with how many carried
    # the transport's own `[vitest-worker]: Timeout calling` message.
    # Recognising a crash by its header cannot be made to work — the header is
    # producer-chosen (26 of this repo's 293 Error subclasses have no
    # Error/Exception suffix, and four assign that bare name to err.name), so
    # any pattern over headers is incomplete by construction, while the count
    # needs no pattern.
    #
    # `--workspaces` prints one summary per workspace into one log, so both
    # figures are whole-file sums and a passing tally cannot cover a later
    # workspace's crash. Reaching this branch means at least one transport
    # line, so a log with no `Errors` summary at all counts 0 against it and
    # the pass is refused, not granted.
    errors=$(awk '/^[[:space:]]*Errors[[:space:]]+[0-9]+ errors?$/ { total += $2 } END { print total + 0 }' "${log}")
    timeouts=$(grep -cE '\[vitest-worker\]: Timeout calling' "${log}" || true)
    if [ "${status}" -lt 128 ] \
      && grep -qE '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' "${log}" \
      && ! grep -qE '^[[:space:]]*(Tests|Test Files)[[:space:]]+[0-9]+ failed' "${log}" \
      && [ "${errors}" -eq "${timeouts}" ]; then
      echo "::warning title=Workspace tests passed through a Vitest transport timeout::Every test passed and all ${errors} unhandled error(s) Vitest counted were its own worker RPC timing out. Treated as a pass."
      exit 0
    fi
    echo "::warning title=Workspace tests exited ${status} on a Vitest transport timeout::A transport timeout the run cannot account for — no passing tally, a failing tally, a signal death, an unhandled error that was not the transport, or the two counts disagreeing for a reason this log does not show. The failure stands (status ${status}, ${errors} counted error(s) vs ${timeouts} transport line(s)); rerun the job."
  else
    echo "::error title=Workspace tests exited ${status} with no failing test::No FAIL line and no transport timeout in the log. Look for a Vitest Unhandled Errors section, or a worker killed before it could report."
  fi
  exit "${status}"
}
