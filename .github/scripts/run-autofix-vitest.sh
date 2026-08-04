#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?workspace is required}"
report_name="${2:?report name is required}"
test_file="${3:?test file is required}"
test_pattern="${4:?test pattern is required}"
expected_report="${5:?expected report path is required}"
user='qwen-autofix-verify'
home='/tmp/qwen-autofix-verify-home'
uid="$(id -u "${user}")"
gid="$(id -g "${user}")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="${script_dir}/autofix-vitest.config.mjs"
launcher="${script_dir}/autofix-cli-launcher.mjs"
[[ -f "${config}" && -f "${launcher}" ]]
[[ "${report_name}" =~ ^case-[0-9]+$ ]]
[[ "${test_file}" != /* && "${test_file}" != *$'\n'* && "${test_file}" != *'..'* ]]
report="${home}/reports/${report_name}/report.json"
# The verifier reads this exact path after the run; disagreeing here means
# the home constant drifted, which must fail loud instead of as a later ENOENT.
if [[ "${report}" != "${expected_report}" ]]; then
  echo "vitest report path disagreement: wrapper writes ${report} but the caller expects ${expected_report}" >&2
  exit 1
fi
run_home="$(sudo mktemp -d "${home}/runs/vitest.XXXXXX")"
sudo chown "root:${user}" "${run_home}"
sudo chmod 0770 "${run_home}"
sudo install -d -o root -g "${user}" -m 0770 \
  "${run_home}/.npm" "${run_home}/tmp"
runtime_dir="${workspace}/.integration-tests/${report_name}"
sudo install -d -o root -g "${user}" -m 0770 \
  "${runtime_dir}" "${runtime_dir}/cli" "${runtime_dir}/sdk"

cleanup_workers() {
  if ! sudo pgrep -u "${uid}" > /dev/null; then
    return
  fi
  # Graceful TERM first so tool children (esbuild, tsc, npm) can shut down
  # on their own; escalate to KILL only after the grace window.
  sudo pkill -TERM -u "${uid}" || true
  for _ in {1..40}; do
    if ! sudo pgrep -u "${uid}" > /dev/null; then
      return
    fi
    sleep 0.25
  done
  sudo pkill -KILL -u "${uid}" || true
  for _ in {1..20}; do
    if ! sudo pgrep -u "${uid}" > /dev/null; then
      return
    fi
    sudo pkill -KILL -u "${uid}" || true
    sleep 0.25
  done
  echo "targeted Vitest left processes running as uid ${uid}" >&2
  return 1
}

command_pid=''
coordinator_pid=''
cleanup_coordinator() {
  if [[ "${coordinator_pid}" =~ ^[1-9][0-9]*$ ]]; then
    sudo kill -KILL -- "-${coordinator_pid}" 2> /dev/null || true
  fi
  if [[ -n "${command_pid}" ]]; then
    wait "${command_pid}" 2> /dev/null || true
  fi
}
# shellcheck disable=SC2317,SC2329
terminate() {
  status="${1:?status is required}"
  cleanup_coordinator
  cleanup_workers || true
  sudo rm -rf -- "${runtime_dir}" "${run_home}"
  trap - EXIT INT TERM
  exit "${status}"
}
trap 'terminate 1' EXIT
trap 'terminate 130' INT
trap 'terminate 143' TERM

# setsid must not fork here: a backgrounded job in a non-interactive
# shell shares the shell's process group, so setsid is not a group leader
# and execs in place; the new session's process-group ID thus equals
# command_pid and cleanup_coordinator can kill -coordinator_pid.
setsid sudo -- \
  setpriv --no-new-privs \
    --bounding-set=-dac_override,-dac_read_search \
    env -i \
    HOME="${run_home}" \
    USER='root' \
    LOGNAME='root' \
    PATH="${PATH}" \
    LANG="${LANG:-C.UTF-8}" \
    CI='true' \
    QWEN_HOME="${run_home}" \
    XDG_CONFIG_HOME="${run_home}/.config" \
    XDG_CACHE_HOME="${run_home}/.cache" \
    KEEP_OUTPUT='true' \
    VERBOSE='true' \
    QWEN_SKIP_PREPARE='1' \
    QWEN_SKIP_SETTINGS_SCHEMA_GENERATION='1' \
    QWEN_SANDBOX='false' \
    QWEN_CODE_INTEGRATION_TEST='true' \
    TELEMETRY_LOG_FILE="${runtime_dir}/cli/telemetry.log" \
    GIT_OPTIONAL_LOCKS='0' \
    GIT_CONFIG_COUNT='1' \
    GIT_CONFIG_KEY_0='safe.directory' \
    GIT_CONFIG_VALUE_0="${workspace}" \
    INTEGRATION_TEST_FILE_DIR="${runtime_dir}/cli" \
    E2E_TEST_FILE_DIR="${runtime_dir}/sdk" \
    TEST_CLI_PATH="${launcher}" \
    AUTOFIX_CANDIDATE_CLI="${workspace}/dist/cli.js" \
    AUTOFIX_WORKSPACE="${workspace}" \
    AUTOFIX_VERIFY_UID="${uid}" \
    AUTOFIX_VERIFY_GID="${gid}" \
    npm_config_cache="${run_home}/.npm" \
    TMPDIR="${run_home}/tmp" \
    npx --no-install vitest run \
      --config "${config}" \
      "${test_file}" \
      --testNamePattern "${test_pattern}" \
      --reporter=json \
      --outputFile="${report}" &
command_pid=$!
coordinator_pid="${command_pid}"
set +e
wait "${command_pid}"
status=$?
set -e
cleanup_coordinator
command_pid=''
if ! cleanup_workers; then
  status=1
fi
sudo rm -rf -- "${runtime_dir}"
if [[ "${status}" == '0' ]]; then
  sudo test -f "${report}"
  sudo test ! -L "${report}"
  sudo chown root:root "${report}"
  sudo chmod 0444 "${report}"
  sudo chmod 0555 "${home}/reports/${report_name}"
fi
sudo rm -rf -- "${run_home}"
trap - EXIT INT TERM
exit "${status}"
