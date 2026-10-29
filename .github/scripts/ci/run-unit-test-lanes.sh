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
# The args (ci.yml passes --retry) reach every Vitest run. Every suite runs
# even after another fails. Exits with the main lane's status, or with the side
# lane's when the main lane passed.
set -uo pipefail

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

(
  NODE_OPTIONS="$workspace_node_options" VITEST_MAX_FORKS="$side_forks" \
    VITEST_MAX_THREADS="$side_threads" \
    npm run test:ci "${side_workspaces[@]}" -- "$@"
  workspaces_rc=$?
  npm run test:standalone:runtimes:ci
  standalone_rc=$?
  VITEST_MAX_FORKS="$side_forks" VITEST_MAX_THREADS="$side_threads" \
    npm run test:scripts:unit -- "$@"
  scripts_rc=$?
  for lane_rc in "$workspaces_rc" "$standalone_rc" "$scripts_rc"; do
    if [ "$lane_rc" -ne 0 ]; then
      exit "$lane_rc"
    fi
  done
) > "$side_log" 2>&1 &
side_pid=$!

NODE_OPTIONS="$workspace_node_options" \
  npm run test:ci "${main_workspaces[@]/#/--workspace=}" -- "$@"
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
