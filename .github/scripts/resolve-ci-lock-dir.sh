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
# One shape heals in place below: unlink permission lives on the containing
# directory, so a root-owned lock FILE inside a still runner-writable dir is
# unlinked and re-probed without sudo — but never while a live process
# provably flocks it: the lock rides the inode, so unlinking strands the
# holder on a deleted name while this job flocks a fresh one, voiding the
# exclusion without a trace. When the shared dir stays unusable (the dir
# itself unwritable, a name that cannot be unlinked, a lock still held),
# print a job-private fallback instead: the leg still runs, which beats
# dying in under a second, but the cost is real — RUNNER_TEMP is per-job, so
# coordination with sibling jobs, the root qwen-docker-cleanup timer, and
# the release lane's build mutex is LOST, not merely degraded: a prune can
# run against a daemon with docker work in flight, and the prunes'
# until=24h age filter does not protect a reused image (a re-run of a SHA
# whose image is older than a day can lose it mid-run to the timer). That
# state does not heal itself: clearing it needs a human on the host.
set -uo pipefail

primary="${HOME}/.cache/qwen-code-ci"

# ci_lock_dir_writable sets this to WHY the probe failed — which check, on
# which path — so the diagnostics below name the offender instead of
# asserting a cause the probe never verified.
problem=''

# lock_held proves whether a live process flocks the inode behind $1, which
# the mode-bit probe cannot see. Two probes, because each sees a shape the
# other cannot: a read-only open plus a non-blocking exclusive flock is
# refused exactly when a holder sits on the inode (and `<` can never
# truncate a held one); when the file cannot even be opened — the
# root-owned 0400 daemon lock the qwen-docker-cleanup timer holds across
# its prune — /proc/locks is the only witness that needs no access to the
# file. Where neither probe exists (macOS has neither flock(1) nor
# /proc/locks) report not-held, leaving those lanes on the previous
# behaviour.
lock_held() {
  local path="$1"
  if command -v flock >/dev/null 2>&1; then
    local probe_rc=0
    bash -c 'exec 8<"$1" || exit 66; flock --nonblock --exclusive 8 || exit 77' _ "${path}" 2>/dev/null || probe_rc=$?
    case "${probe_rc}" in
      0) return 1 ;; # the probe took the exclusive lock: provably unheld
      77) return 0 ;; # opened, but the flock was refused: a live holder
    esac
    # 66 (cannot open) or anything else: fall through to /proc/locks.
  fi
  [[ -r /proc/locks ]] || return 1
  # A /proc/locks line lays a lock out as
  # `<id>: FLOCK ADVISORY WRITE <pid> <major>:<minor>:<inode> <start> <end>`
  # — the witness triple is $6, while $5 is the holder's PID. The device
  # must compare with the inode: an inode-only match names a phantom
  # holder on another filesystem. %D is st_dev in hex (major above the low
  # minor byte); the hex arithmetic stays in bash because strtonum is
  # gawk-only.
  local dev ino want
  dev="$(stat -c %D -- "${path}" 2>/dev/null)" || return 1
  ino="$(stat -c %i -- "${path}" 2>/dev/null)" || return 1
  printf -v want '%02x:%02x:%d' "$((0x${dev} >> 8))" "$((0x${dev} & 0xff))" "${ino}"
  awk -v want="${want}" '$6 == want { found = 1 } END { exit !found }' /proc/locks
}

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
    # Vet the open the caller is about to make, not the mode bits: a
    # directory, FIFO, or dangling symlink at the lock name passes -w (or
    # never reaches it) and then fails or hangs the caller's `exec N>`.
    # `-e` follows symlinks, so `-L` is what sees a dangling one.
    if [[ -e "${dir}/${name}" || -L "${dir}/${name}" ]] && ! [[ -f "${dir}/${name}" ]]; then
      problem="${dir}/${name} exists but is not a regular file"
      return 1
    fi
    if [[ -e "${dir}/${name}" && ! -w "${dir}/${name}" ]]; then
      # Unlink permission comes from the directory, so a runner-owned dir
      # holding a foreign-owned lock is repairable without sudo. Narrow on
      # purpose: only files this probe found unwritable — never a glob,
      # never a writable file a live sibling holds, and never a file a live
      # process flocks. The re-test still covers a failed unlink (EROFS, a
      # sticky dir).
      if lock_held "${dir}/${name}"; then
        problem="lock file ${dir}/${name} is not writable and is locked by a live process"
        return 1
      fi
      rm -f -- "${dir}/${name}" 2>/dev/null || true
      if [[ -e "${dir}/${name}" && ! -w "${dir}/${name}" ]]; then
        problem="lock file ${dir}/${name} is not writable"
        return 1
      fi
      # A healed host must not heal silently: name what was unlinked so
      # the next poisoned run has a trail. stderr only — stdout stays the
      # single-path payload both callers capture with $(...).
      echo "::warning::unlinked stale unwritable lock file ${dir}/${name}; a fresh one opens in its place" >&2
    fi
    # Vet the very open the caller makes next, in append mode so the probe
    # can never truncate an inode a live process flocks. The regular-file
    # vet above keeps the open bounded (a FIFO would hang it), and a name
    # the heal just unlinked is absent here — the caller's own open
    # creates it — so only a surviving name is probed.
    if [[ -e "${dir}/${name}" ]] && ! (exec 9>>"${dir}/${name}") 2>/dev/null; then
      problem="cannot open ${dir}/${name} for writing"
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
echo "::warning::${problem} — using job-private lock dir ${fallback} for: $*; cross-job coordination on these locks is lost for this job" >&2
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '### ⚠️ Docker lock-dir fallback active'
    echo
    echo "${problem} — this job locks in the job-private \`${fallback}\` for: $*. Cross-job coordination on these locks is **lost** for this job. The shared dir does not heal itself — clearing \`${primary}\` needs a human on the host."
  } >>"${GITHUB_STEP_SUMMARY}" || true
fi
printf '%s\n' "${fallback}"
