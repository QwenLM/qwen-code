#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?workspace is required}"
shift
if [[ $# -eq 0 ]]; then
  echo 'run-autofix-verification-command.sh: no command provided' >&2
  exit 1
fi
user='qwen-autofix-verify'
home='/tmp/qwen-autofix-verify-home'
uid="$(id -u "${user}")"
gid="$(id -g "${user}")"
run_home="$(sudo mktemp -d "${home}/runs/command.XXXXXX")"
sudo chown "${user}:${user}" "${run_home}"
sudo install -d -o "${user}" -g "${user}" -m 0700 \
  "${run_home}/.npm" "${run_home}/tmp"

cd "${workspace}"
setpriv_args=(
  --reuid="${uid}"
  --regid="${gid}"
  --clear-groups
  --no-new-privs
)
env_args=(
  HOME="${run_home}"
  USER="${user}"
  LOGNAME="${user}"
  PATH="${PATH}"
  LANG="${LANG:-C.UTF-8}"
  CI='true'
  QWEN_HOME="${run_home}"
  XDG_CONFIG_HOME="${run_home}/.config"
  XDG_CACHE_HOME="${run_home}/.cache"
  KEEP_OUTPUT='true'
  VERBOSE='true'
  QWEN_SKIP_PREPARE='1'
  QWEN_SKIP_SETTINGS_SCHEMA_GENERATION='1'
  GIT_OPTIONAL_LOCKS='0'
  GIT_CONFIG_COUNT='1'
  GIT_CONFIG_KEY_0='safe.directory'
  GIT_CONFIG_VALUE_0="${workspace}"
  npm_config_cache="${run_home}/.npm"
  TMPDIR="${run_home}/tmp"
)

cleanup_processes() {
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
  echo "verification command left processes running as uid ${uid}" >&2
  return 1
}

command_pid=''
# shellcheck disable=SC2317,SC2329
terminate() {
  status="${1:?status is required}"
  cleanup_processes || true
  if [[ -n "${command_pid}" ]]; then
    sudo kill -KILL "${command_pid}" 2> /dev/null || true
    wait "${command_pid}" 2> /dev/null || true
  fi
  sudo rm -rf -- "${run_home}"
  trap - EXIT INT TERM
  exit "${status}"
}
trap 'terminate 1' EXIT
trap 'terminate 130' INT
trap 'terminate 143' TERM

sudo setpriv "${setpriv_args[@]}" env -i "${env_args[@]}" bash --noprofile --norc -ec '
  [[ "$(id -u)" != "0" ]]
  [[ "$(id -G | wc -w)" == "1" ]]
  grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
  [[ ! -r /var/run/docker.sock && ! -w /var/run/docker.sock ]]
'
set +e
sudo setpriv "${setpriv_args[@]}" env -i "${env_args[@]}" "$@" &
command_pid=$!
wait "${command_pid}"
status=$?
command_pid=''
set -e
if ! cleanup_processes; then
  status=1
fi
sudo rm -rf -- "${run_home}"
trap - EXIT INT TERM
exit "${status}"
