#!/usr/bin/env bash
# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

: "${RUNNER_ENVIRONMENT:?This setup is only for an ephemeral GitHub-hosted runner}"
[[ "${RUNNER_ENVIRONMENT}" == 'github-hosted' && "${EUID}" -ne 0 ]]
evidence="${1:?Supply an absolute preflight evidence directory}"
[[ "${evidence}" == /* ]]
mkdir -p "${evidence}"
exec > >(tee "${evidence}/setup.log") 2>&1

apparmor_diagnostics() {
  sudo -n cat /sys/kernel/security/apparmor/profiles > "${evidence}/apparmor-profiles.txt" 2>&1 || true
  sudo -n journalctl -k --since '-5 minutes' --no-pager |
    grep -Ei 'apparmor|bwrap|userns|RTM_NEWADDR' > "${evidence}/kernel-denials.txt" || true
}
trap apparmor_diagnostics EXIT

uname -a
for setting in /sys/module/apparmor/parameters/enabled \
  /proc/sys/kernel/apparmor_restrict_unprivileged_userns \
  /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces; do
  if [[ -r "${setting}" ]]; then
    printf '%s=' "${setting}"
    cat "${setting}"
  fi
done
sudo apt-get update
sudo apt-get install --yes bubblewrap tmux git apparmor
/usr/bin/bwrap --version

probe() {
  /usr/bin/bwrap --die-with-parent --unshare-user --unshare-pid --unshare-net \
    --ro-bind / / --proc /proc --dev /dev -- /bin/sh -c \
    'readlink /proc/self/ns/pid; readlink /proc/self/ns/net; cat /proc/self/attr/current'
}
if probe > "${evidence}/probe-before.log" 2>&1; then
  cat "${evidence}/probe-before.log"
  exit 0
fi
cat "${evidence}/probe-before.log"
apparmor_diagnostics
cp "${evidence}/kernel-denials.txt" "${evidence}/kernel-denials-before.txt"
[[ "$(cat /sys/module/apparmor/parameters/enabled)" == 'Y' ]]
restriction_before="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
[[ "${restriction_before}" == '1' ]]

# Ubuntu 24.04 requires explicit userns admission for sandbox launchers.
# Load this executable-specific profile only for the lifetime of this CI VM.
cat > "${evidence}/qwen-bwrap-ci.apparmor" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile qwen-bwrap-ci /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
sudo -n apparmor_parser --replace --skip-read-cache "${evidence}/qwen-bwrap-ci.apparmor"
probe > "${evidence}/probe-after.log" 2>&1
cat "${evidence}/probe-after.log"
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "${restriction_before}" ]]
