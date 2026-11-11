#!/usr/bin/env bash
# Run the Linux CI unit suites in two concurrent lanes.
#
# The CLI and core suites keep their workers busy for most of ci.yml's test
# job. Every other suite is smaller, or spends most of its run on a few files
# (web-shell on App.test.tsx alone), and the standalone runtime regression
# starts one runtime process at a time. The main lane runs the CLI and core
# suites; a side lane runs everything else beside them: the other workspaces'
# test:ci, the standalone regression and the scripts/tests suite. Together the
# lanes run what `npm run test:ci` runs.
#
# The side lane logs to a file that is replayed once the main lane ends: the
# two logs never interleave, and a vitest FAIL line still starts its own line
# for main-failure-signature.mjs. If the side lane is still running then,
# `tail --pid` keeps streaming its log until it exits. The replay also puts
# the side lane's failures after the main lane's: when both lanes fail,
# main-failure-signature.mjs, which titles and searches by the first failures
# in the log, names main-lane tests. The log is SIDE_LANE_LOG when the caller
# names one, so that a step killed before the replay (a timeout or a cancel)
# leaves it for a later step to print, else a temp file; either way it is
# removed once replayed.
#
# Each Vitest run applies the worker cap (VITEST_MAX_FORKS / VITEST_MAX_THREADS)
# on its own, so two lanes would run twice the cap. The side lane's Vitest runs
# take half of it, at least 1, beside the main lane's full cap. Where no cap is
# set, as on the 4-CPU hosted runners, they take 2 rather than Vitest's default
# of all CPUs but one.
#
# Usage: run-unit-test-lanes.sh [vitest args...]
# The args (ci.yml passes --shard and --retry) reach every Vitest run. Every suite runs
# even after another fails. Exits with the main lane's status, or with the side
# lane's when the main lane passed.
set -uo pipefail

# A Vitest run whose every test passed can still exit non-zero on an unhandled
# error, and on this pool the error is usually the worker->main RPC budget
# rather than anything the branch did: `Timeout calling "onTaskUpdate"` failed
# main runs 43018456551 and 43016357976 with 902 of 902 tests passing in
# packages/channels/github. The Linux lanes deliberately keep unhandled errors
# fatal (scripts/tests/unit-vitest-configs.test.ts pins that, #10438), so the
# answer is not to ignore them: re-run the workspace suites whose reports show
# no failed test and only that RPC error. A real unhandled rejection still
# fails the first time, and an RPC stall that outlives two whole runs still
# fails.
#
# Set to 0 or off to disable, for an operator who wants the first failure to
# stand. `off` is what the other levers in this test step use (VITEST_RETRY,
# HOST_LOAD_MAX_RATIO), so both tokens are accepted and `0` keeps working.
RPC_RETRY="${QWEN_CI_RPC_RETRY:-1}"
case "$RPC_RETRY" in 0 | off) RPC_RETRY=0 ;; esac

# The main lane's workspaces, the CLI suite and core.
main_workspaces=('@qwen-code/qwen-code' '@qwen-code/qwen-code-core')
# The heap cap `npm run test:ci:workspaces` gives each workspace suite.
workspace_node_options='--max-old-space-size=3072'

# Every other workspace that defines test:ci, in npm's workspace order: the
# set `npm run test:ci:workspaces` runs, minus the main lane's.
if ! workspace_scripts="$(npm pkg get scripts.test:ci --workspaces --json)" ||
  ! side_args="$(
    printf '%s' "$workspace_scripts" |
      MAIN_WORKSPACES="${main_workspaces[*]}" node -e "
        const scripts = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
        const main = process.env.MAIN_WORKSPACES.split(' ');
        for (const [name, script] of Object.entries(scripts)) {
          if (typeof script !== 'string' || main.includes(name)) {
            continue;
          }
          // mapfile reads one argument per line below.
          if (/[\s\p{Cc}]/u.test(name)) {
            console.error('A workspace name holds whitespace: ' + JSON.stringify(name));
            process.exit(1);
          }
          console.log('--workspace=' + name);
        }
      "
  )"; then
  echo '::error::Could not list the workspaces that define test:ci; the error is above.'
  exit 1
fi
if [ -z "$side_args" ]; then
  # An empty list would run the root's own test:ci, every suite again.
  echo '::error::Found no workspaces to test beside the CLI and core suites.'
  exit 1
fi
mapfile -t side_workspaces <<<"$side_args"

if [ -n "${SIDE_LANE_LOG:-}" ]; then
  side_log="$SIDE_LANE_LOG"
  if ! : > "$side_log"; then
    echo "::error::Could not create the side lane's log file ${side_log}; running no suites."
    exit 1
  fi
elif ! side_log="$(mktemp "${TMPDIR:-/tmp}/side-lane-tests.XXXXXX")"; then
  echo "::error::Could not create the side lane's log file under ${TMPDIR:-/tmp}; running no suites."
  exit 1
fi
# scripts/tests runs `npm run test:scripts:unit`, this script again: a nested
# run that inherited the caller's log would truncate the outer side lane's,
# replay it and remove it.
unset SIDE_LANE_LOG

# Half a Vitest worker cap, at least 1; 2 where the cap is unset or not a count.
half_cap() {
  case "$1" in
    '' | *[!0-9]*) echo 2 ;;
    *) echo $((10#$1 > 1 ? 10#$1 / 2 : 1)) ;;
  esac
}
side_forks="$(half_cap "${VITEST_MAX_FORKS:-}")"
side_threads="$(half_cap "${VITEST_MAX_THREADS:-}")"

# Run one suite command and re-run it once when its own log proves the run was
# all-green and the only failure was the RPC budget. Used for
# `npm run test:scripts:unit`, a single suite whose whole log is its own report;
# the workspace lanes use run_lane_suites below, which has to tell one
# workspace's report from another's.
#
# The first attempt is teed because the decision needs the text. The retry is
# not: nothing reads its status but the lane's, so it streams straight through
# exactly as this suite did before there was a retry.
run_suite() {
  local log rc
  log="$(mktemp "${TMPDIR:-/tmp}/unit-lane-suite.XXXXXX")" || {
    echo "::error::Could not create a suite log under ${TMPDIR:-/tmp}."
    return 1
  }
  "$@" 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  if [ "$rc" -ne 0 ] && [ "$RPC_RETRY" != '0' ] &&
    rpc_only_failure_text "$rc" < "$log"; then
    echo "::warning::Every test passed but Vitest reported the worker RPC timeout as an unhandled error; re-running this suite once."
    rm -f "$log"
    "$@"
    return $?
  fi
  rm -f "$log"
  return "$rc"
}

# Run a lane's workspace suites in ONE npm call, exactly as before, then re-run
# only the workspaces npm names as failed when each of their reports shows no
# failed test and only the RPC error. The first attempt keeps npm's own
# batching: it runs every listed workspace even after one fails and exits with
# the first failure's status, and the lane has always relied on both.
#
# The retry reads npm's `workspace <name>` failure lines to learn WHICH
# workspaces failed, and each one's own report block to learn WHY. A batch log
# holds every workspace's summary, so judging the whole log — or just its last
# summary — would let one workspace's green report license another's retry.
run_lane_suites() {
  local log rc failed name block block_rc
  log="$(mktemp "${TMPDIR:-/tmp}/unit-lane-suite.XXXXXX")" || {
    echo "::error::Could not create a suite log under ${TMPDIR:-/tmp}."
    return 1
  }
  local started=$SECONDS
  npm run test:ci "$@" -- "${suite_args[@]}" 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  if [ "$rc" -eq 0 ] || [ "$RPC_RETRY" = '0' ]; then
    rm -f "$log"
    return "$rc"
  fi
  # npm prints one of these per workspace whose script exited non-zero, as
  # `npm error workspace @scope/name@1.2.3`. Strip the trailing version at the
  # LAST `@`, not the first: every workspace here is scoped, so the name itself
  # starts with one. Strip only a NUMERIC version: a workspace with no version
  # is printed as `@scope/name`, and stripping at its last `@` would empty the
  # name and quietly drop a real failure from the loop below. No such line
  # means the failure was npm's own (a bad workspace list, a missing script),
  # which no retry of a suite can fix.
  failed="$(grep -oE '^npm error workspace [^ ]+' "$log" |
    awk '{ print $4 }' | sed 's/@[0-9][^@]*$//' | sort -u)"
  if [ -z "$failed" ]; then
    rm -f "$log"
    return "$rc"
  fi
  local retryable=() unproven=0
  while IFS= read -r name; do
    # An empty name cannot be matched to a report block, so nothing proves its
    # failure was the transport. Keep the original failure instead of skipping
    # the workspace the way a `continue` would.
    if [ -z "$name" ]; then
      rm -f "$log"
      return "$rc"
    fi
    # The block from this workspace's own header to the next workspace's
    # header: its build output, its report, and nothing belonging to a
    # neighbour. `index`, not a regex: every workspace here is scoped, so the
    # name is full of characters a regex would read as syntax.
    block="$(awk -v name="$name" '
      /^> .*@[^ ]+ test:ci$/ { inside = (index($0, "> " name "@") == 1) }
      inside { print }
    ' "$log")"
    # npm exits with the LAST failing workspace's status, so the batch rc
    # describes a different workspace than the block being judged. Read this
    # workspace's own `npm error code N` out of its block; without one, fall
    # back to the batch status (fail closed: a signal death is still >= 128).
    block_rc="$(grep -oE '^npm error code [0-9]+' <<< "$block" | awk 'NR == 1 { print $4 }')"
    [ -n "$block_rc" ] || block_rc="$rc"
    if rpc_only_failure_text "$block_rc" <<< "$block"; then
      retryable+=("$name")
    else
      # This workspace's failure is not the transport. Its failure stands, and
      # nothing here re-runs it; the other workspaces are still judged on
      # their own evidence rather than on the batch status.
      unproven=1
    fi
  done <<< "$failed"
  if [ "${#retryable[@]}" -eq 0 ]; then
    rm -f "$log"
    return "$rc"
  fi
  # A retry costs about what the first attempt cost. When the step has less
  # than that left it would be killed by the step timeout, leaving a truncated
  # run instead of the first attempt's report; keep the first failure.
  if [ "${UNIT_LANE_BUDGET_SECONDS:-0}" -gt 0 ] &&
    [ $((SECONDS - started)) -ge $((UNIT_LANE_BUDGET_SECONDS / 2)) ]; then
    echo "::warning::Skipping the RPC re-run: ${SECONDS} s of the ${UNIT_LANE_BUDGET_SECONDS} s step budget used, too little left for another pass."
    rm -f "$log"
    return "$rc"
  fi
  rm -f "$log"
  echo "::warning::Every test passed but Vitest reported the worker RPC timeout as an unhandled error; re-running the affected workspace suites once."
  local status=0 attempt
  for name in "${retryable[@]}"; do
    npm run test:ci "--workspace=${name}" -- "${suite_args[@]}"
    attempt=$?
    if [ "$attempt" -ne 0 ] && [ "$status" -eq 0 ]; then
      status="$attempt"
    fi
  done
  # A workspace whose failure was not the transport was not re-run; its
  # failure is the lane's verdict even when every retry passed.
  if [ "$unproven" -eq 1 ] && [ "$status" -eq 0 ]; then
    return "$rc"
  fi
  return "$status"
}

# True only for an all-green report whose unhandled errors are all the RPC
# timeout. The release lane already grants exactly this pass on its own shards
# (.github/scripts/run-release-workspace-tests.sh, run 33713579913), and its
# evidence rules are pinned by scripts/tests/release-workflow.test.js; these
# are those rules. The count is what proves the run, not the crash header: the
# header is producer-chosen, so a pattern over headers is incomplete by
# construction (26 of this repo's 293 Error subclasses carry no Error/Exception
# suffix), while Vitest's own `Errors  N errors` needs no pattern.
#
# The two figures are sums over the whole block, so a passing tally in one
# attempt cannot cover a later one's crash. Every pattern is anchored on the
# section-line shape and the transport message is matched on Vitest's own
# `[vitest-worker]: Timeout calling` prefix, because a test's console output is
# echoed at column 0 and a test that prints summary-shaped fixture data — or
# the words `Timeout calling` — must not move either figure.
rpc_only_failure_text() {
  local text
  text="$(cat)"
  # A signal death (>=128) is not the transport giving up: the process was
  # killed, and whatever it printed before that says nothing about the rest.
  # Both callers already know the run failed; the lower bound says so here too,
  # so this cannot grant a retry to a status that was never a failure.
  [ "$1" -ge 1 ] || return 1
  [ "$1" -lt 128 ] || return 1
  # No summary at all: the process died before reporting (OOM, a kill, a step
  # timeout). Nothing here says the tests passed.
  grep -qE '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' <<< "$text" || return 1
  grep -qE '^[[:space:]]*(Tests|Test Files)[[:space:]]+[0-9]+ failed' <<< "$text" &&
    return 1
  grep -qE '^[[:space:]]*FAIL ' <<< "$text" && return 1
  # Every reported error must be the RPC timeout. Vitest prints the count in
  # the summary and the message once per error, so the totals have to agree;
  # a second, different unhandled error would leave them apart, and the same
  # message printed twice against one counted error leaves them apart too.
  local reported timeouts
  reported="$(awk '/^[[:space:]]*Errors[[:space:]]+[0-9]+ errors?$/ { total += $2 } END { print total + 0 }' <<< "$text")"
  [ "$reported" -ge 1 ] || return 1
  # Only the block Vitest emits for unhandled errors counts. A test's console
  # output is echoed at column 0 too, so a whole-text grep let a test that
  # prints these words move the figure in both directions: it could license a
  # retry for an unrelated unhandled error, or deny the retry a real transport
  # report had earned.
  timeouts="$(awk '
    /Unhandled Errors/ { inside = 1; next }
    inside && /^[[:space:]]*(Test Files|Tests|Errors)[[:space:]]/ { inside = 0 }
    inside && /\[vitest-worker\]: Timeout calling/ { count++ }
    END { print count + 0 }
  ' <<< "$text")"
  [ "$timeouts" -eq "$reported" ]
}

suite_args=("$@")

(
  NODE_OPTIONS="$workspace_node_options" VITEST_MAX_FORKS="$side_forks" \
    VITEST_MAX_THREADS="$side_threads" \
    run_lane_suites "${side_workspaces[@]}"
  workspaces_rc=$?
  standalone_rc=0
  # A sharded run skips it on every shard but one.
  if [ -z "${QWEN_CI_SKIP_STANDALONE_RUNTIMES:-}" ]; then
    npm run test:standalone:runtimes:ci
    standalone_rc=$?
  fi
  VITEST_MAX_FORKS="$side_forks" VITEST_MAX_THREADS="$side_threads" \
    run_suite npm run test:scripts:unit -- "${suite_args[@]}"
  scripts_rc=$?
  for lane_rc in "$workspaces_rc" "$standalone_rc" "$scripts_rc"; do
    if [ "$lane_rc" -ne 0 ]; then
      exit "$lane_rc"
    fi
  done
) > "$side_log" 2>&1 &
side_pid=$!

NODE_OPTIONS="$workspace_node_options" \
  run_lane_suites "${main_workspaces[@]/#/--workspace=}"
rc=$?

echo "Side lane output (other workspaces, standalone runtimes, scripts/tests):"
tail -n +1 -f --pid="$side_pid" "$side_log"
wait "$side_pid"
side_rc=$?
echo "Side lane exited with ${side_rc}."
rm -f "$side_log"
if [ "$rc" -eq 0 ]; then
  rc=$side_rc
fi
exit "$rc"
