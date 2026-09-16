#!/usr/bin/env bash
# Prints the directory this host's CI jobs use for the docker sandbox flock
# files (daemon prune exclusion, per-commit build coordinator, build mutex).
# Callers pass the names of the lock files they will open, and only those
# are probed: an unwritable lock from another family (sdk-java-tests.lock)
# must not veto a shared dir that is usable for this caller's own files.
#
# The shared ${HOME}/.cache/qwen-code-ci coordinates every job on the host,
# but a root-owned leftover there fails every `exec 9>` with EACCES before a
# test runs (#11990), and the pre-checkout heal can only chown it back when
# the runner has passwordless sudo — run 35069321648 (#12006) died in under
# a second on both lock-opening steps after the heal warned and gave up.
# When the shared dir is unusable, print a job-private fallback instead: the
# leg still runs, which beats dying in under a second, but the cost is real
# — RUNNER_TEMP is per-job, so coordination with sibling jobs, the root
# qwen-docker-cleanup timer, and the release lane's build mutex is LOST, not
# merely degraded: a prune can run against a daemon with docker work in
# flight, and the prunes' until=24h age filter does not protect a reused
# image (a re-run of a SHA whose image is older than a day can lose it
# mid-run to the timer). The state does not heal itself: clearing it needs
# a human on the host.
set -uo pipefail

primary="${HOME}/.cache/qwen-code-ci"

# ci_lock_dir_writable sets this to WHY the probe failed — which check, on
# which path — so the diagnostics below name the offender instead of
# asserting a cause the probe never verified.
problem=''

ci_lock_dir_writable() {
  local dir="$1"
  shift
  local name
  if ! mkdir -p "${dir}" 2>/dev/null; then
    problem="cannot create ${dir}"
    return 1
  fi
  if [[ ! -w "${dir}" ]]; then
    problem="${dir} is not writable"
    return 1
  fi
  for name in "$@"; do
    if [[ -e "${dir}/${name}" && ! -w "${dir}/${name}" ]]; then
      problem="lock file ${dir}/${name} is not writable"
      return 1
    fi
  done
  return 0
}

if ci_lock_dir_writable "${primary}" "$@"; then
  printf '%s\n' "${primary}"
  exit 0
fi

fallback="${RUNNER_TEMP:-/tmp}/qwen-code-ci-locks"
if ! mkdir -p "${fallback}"; then
  echo "::error::${problem}, and job-private fallback ${fallback} cannot be created; the docker sandbox locks cannot be opened" >&2
  exit 1
fi
echo "::warning::${problem} — using job-private lock dir ${fallback}; docker build/prune coordination on this host is lost for this job" >&2
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '### ⚠️ Docker lock-dir fallback active'
    echo
    echo "${problem} — this job locks in the job-private \`${fallback}\`. Coordination with sibling jobs, the root \`qwen-docker-cleanup\` timer, and the release build lane is **lost** for this job: a prune can race in-flight docker work, and \`until=24h\` does not protect a reused sandbox image. The shared dir does not heal itself — clearing \`${primary}\` needs a human on the host."
  } >>"${GITHUB_STEP_SUMMARY}" || true
fi
printf '%s\n' "${fallback}"
