#!/usr/bin/env bash
# Run the Linux CI unit suites in two concurrent lanes.
#
# The CLI suite keeps its workers busy for most of ci.yml's test job, while
# web-shell's suite spends most of its run on App.test.tsx alone and the
# standalone runtime regression starts one runtime process at a time. A side
# lane runs those two beside the other workspaces, so their mostly idle
# minutes overlap the CLI suite instead of adding to it. Together the lanes
# run what `npm run test:ci` runs: every workspace's test:ci, the standalone
# regression and the scripts/tests suite.
#
# The side lane logs to a file that is replayed once the main lane ends: the
# two logs never interleave, and a vitest FAIL line still starts its own line
# for main-failure-signature.mjs. If the side lane is still running then,
# `tail --pid` keeps streaming its log until it exits. The replay also puts
# the side lane's failures after the main lane's: when both lanes fail,
# main-failure-signature.mjs, which titles and searches by the first failures
# in the log, names main-lane tests.
#
# Each Vitest run applies the worker cap (VITEST_MAX_FORKS / VITEST_MAX_THREADS)
# on its own, so two lanes would run twice the cap. Web-shell, whose suite
# waits on one file, runs at half of it, at least 1, beside the main lane's
# full cap. Where no cap is set, as on the 4-CPU hosted runners, it runs at 2
# rather than at Vitest's default of all CPUs but one.
#
# Usage: run-unit-test-lanes.sh [vitest args...]
# The args (ci.yml passes --retry) reach every Vitest run. Exits with the main
# lane's status, or with the side lane's when the main lane passed.
set -uo pipefail

side_workspace='@qwen-code/web-shell'
# The heap cap `npm run test:ci:workspaces` gives each workspace suite.
workspace_node_options='--max-old-space-size=3072'
if ! side_log="$(mktemp "${TMPDIR:-/tmp}/side-lane-tests.XXXXXX")"; then
  echo "::error::Could not create the side lane's log file under ${TMPDIR:-/tmp}; running no suites."
  exit 1
fi

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
    npm run test:ci --workspace="$side_workspace" -- "$@"
  web_shell_rc=$?
  npm run test:standalone:runtimes:ci
  standalone_rc=$?
  exit $((web_shell_rc ? web_shell_rc : standalone_rc))
) > "$side_log" 2>&1 &
side_pid=$!

# Every other workspace that defines test:ci, in npm's workspace order: the
# set `npm run test:ci:workspaces` runs, minus the side lane's.
if ! workspace_scripts="$(npm pkg get scripts.test:ci --workspaces --json)" ||
  ! workspace_args="$(
    printf '%s' "$workspace_scripts" |
      SIDE_WORKSPACE="$side_workspace" node -e "
        const scripts = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
        for (const [name, script] of Object.entries(scripts)) {
          if (typeof script !== 'string' || name === process.env.SIDE_WORKSPACE) {
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
  rc=1
elif [ -z "$workspace_args" ]; then
  # An empty list would run the root's own test:ci, every suite again.
  echo '::error::Found no workspaces to test beside the side lane.'
  rc=1
else
  mapfile -t main_workspaces <<<"$workspace_args"
  NODE_OPTIONS="$workspace_node_options" npm run test:ci "${main_workspaces[@]}" -- "$@"
  rc=$?
fi
if [ "$rc" -eq 0 ]; then
  npm run test:scripts:unit -- "$@"
  rc=$?
fi

echo "Side lane output (${side_workspace}, standalone runtimes):"
tail -n +1 -f --pid="$side_pid" "$side_log"
wait "$side_pid"
side_rc=$?
echo "Side lane exited with ${side_rc}."
rm -f "$side_log"
if [ "$rc" -eq 0 ]; then
  rc=$side_rc
fi
exit "$rc"
