#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?workspace is required}"
phase="${2:-prepare}"
report_name="${3:-}"
user='qwen-autofix-verify'
home='/tmp/qwen-autofix-verify-home'

case "${phase}" in
  prepare)
    id -u "${user}" > /dev/null 2>&1 ||
      sudo useradd --create-home --home-dir "${home}" --shell /bin/bash "${user}"
    # Recursive: useradd --create-home copies /etc/skel files owned by the
    # new user; the whole home must be root-owned before the downgrade.
    sudo chown -R root:root "${home}"
    git config --global --add safe.directory "${workspace}"
    sudo chown -R root:root "${workspace}"
    sudo find "${workspace}" -xdev -type f -exec chmod a-w -- {} +
    sudo find "${workspace}" -xdev -path "${workspace}/.git" -prune -o -type d -exec chmod 1777 -- {} +
    sudo find "${workspace}/.git" -xdev -type d -exec chmod 0555 -- {} +
    sudo find "${workspace}/.git" -xdev -type f -exec chmod a-w -- {} +
    sudo chmod 0755 "${home}"
    sudo install -d -o root -g root -m 0711 "${home}/runs" "${home}/reports"
    ;;
  dependencies)
    [[ -d "${workspace}/node_modules" ]] || { echo "prepare-autofix-verification-worktree: ${workspace}/node_modules is missing; install dependencies first" >&2; exit 1; }
    manifest="$(mktemp)"
    while IFS= read -r -d '' dependency_dir; do
      relative_dir="${dependency_dir#"${workspace}/"}"
      printf '%s\0' "${relative_dir}" >> "${manifest}"
      sudo chown -R root:root "${dependency_dir}"
      sudo find "${dependency_dir}" -xdev -type d -exec chmod 0555 -- {} +
      sudo find "${dependency_dir}" -xdev -type f -exec chmod a-w -- {} +
    done < <(
      find "${workspace}" -xdev -type d -name node_modules -prune -print0
    )
    sudo install -o root -g root -m 0444 \
      "${manifest}" "${workspace}/.git/autofix-verification-dependencies"
    rm -f "${manifest}"
    ;;
  finalize)
    sudo chown -R root:root "${workspace}"
    sudo find "${workspace}" -xdev -type d -exec chmod 0555 -- {} +
    sudo find "${workspace}" -xdev -type f -exec chmod a-w -- {} +
    sudo install -d -o root -g root -m 0711 "${workspace}/.integration-tests"
    ;;
  report)
    [[ "${report_name}" =~ ^case-[0-9]+$ ]]
    sudo install -d -o root -g root -m 0700 \
      "${home}/reports/${report_name}"
    ;;
  remove-report)
    [[ "${report_name}" =~ ^case-[0-9]+$ ]]
    sudo rm -rf -- "${home}/reports/${report_name}"
    ;;
  cleanup)
    sudo rm -rf -- "${workspace}/.integration-tests"
    ;;
  *)
    echo "unknown verification worktree phase: ${phase}" >&2
    exit 2
    ;;
esac
