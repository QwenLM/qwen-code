#!/usr/bin/env bash
# Prints the directory this host's CI jobs use for the docker sandbox flock
# files (daemon prune exclusion, per-commit build coordinator, build mutex).
#
# The shared ${HOME}/.cache/qwen-code-ci coordinates every job on the host,
# but a root-owned leftover there fails every `exec 9>` with EACCES before a
# test runs (#11990), and the pre-checkout heal can only chown it back when
# the runner has passwordless sudo — run 35069321648 (#12006) died in under a
# second on both lock-opening steps after the heal warned and gave up. When
# the shared dir is unusable, print a job-private fallback instead: the leg
# still runs, and losing cross-job coordination is safe here — the sandbox
# image build is idempotent and the image prune is label- and age-filtered.
set -uo pipefail

primary="${HOME}/.cache/qwen-code-ci"

ci_lock_dir_writable() {
  local dir="$1"
  local existing
  mkdir -p "${dir}" 2>/dev/null || return 1
  [[ -w "${dir}" ]] || return 1
  for existing in "${dir}"/*.lock; do
    if [[ -e "${existing}" && ! -w "${existing}" ]]; then
      return 1
    fi
  done
  return 0
}

if ci_lock_dir_writable "${primary}"; then
  printf '%s\n' "${primary}"
  exit 0
fi

fallback="${RUNNER_TEMP:-/tmp}/qwen-code-ci-locks"
if ! mkdir -p "${fallback}"; then
  echo "::error::${primary} is not writable and job-private fallback ${fallback} cannot be created; the docker sandbox locks cannot be opened" >&2
  exit 1
fi
echo "::warning::${primary} is not writable (unhealed root-owned leftover) — using job-private lock dir ${fallback}; docker build/prune coordination on this host is degraded for this job" >&2
printf '%s\n' "${fallback}"
