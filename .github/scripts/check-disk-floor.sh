#!/usr/bin/env bash
# Pre-job disk floor gate for self-hosted Linux runners (#10035).
#
# ENOSPC failed `npm ci` mid-install on a saturated host while the workspace
# cleanup timer skipped busy runners, so the job died mid-suite and the host
# looked healthy by the time anyone ran `df`. Failing BEFORE the heavy step
# turns that into a clear, retryable gate failure instead of a corrupted
# half-run; a re-run lands on a host with headroom.
#
# Usage: check-disk-floor.sh [DIR ...]
# With no directories, checks GITHUB_WORKSPACE and RUNNER_TEMP.
#
# Floors, checked per directory's filesystem (env-overridable):
#   DISK_FLOOR_MIN_FREE_KB      default 2097152 (2 GiB)
#   DISK_FLOOR_MIN_FREE_INODES  default 100000
#
# Every check emits a DISKFLOOR sample tagged with runner and run ids so a
# breached gate can be correlated with the GitHub job that hit it.
set -u

MIN_FREE_KB="${DISK_FLOOR_MIN_FREE_KB:-2097152}"
MIN_FREE_INODES="${DISK_FLOOR_MIN_FREE_INODES:-100000}"
MAX_BASH_INT=9223372036854775807

validate_floor_override() {
  local name="$1"
  local value="$2"
  local normalized

  case "$value" in
    '' | *[!0-9]*)
      echo "::error::${name} must be a non-negative integer"
      exit 1
      ;;
  esac

  normalized="$(sed 's/^0*//' <<< "$value")"
  if [ -z "$normalized" ]; then
    normalized=0
  fi
  if [ "${#normalized}" -gt 19 ] ||
    { [ "${#normalized}" -eq 19 ] && [[ "$normalized" > "$MAX_BASH_INT" ]]; }; then
    echo "::error::${name} must fit in a signed 64-bit integer"
    exit 1
  fi
}

validate_floor_override DISK_FLOOR_MIN_FREE_KB "$MIN_FREE_KB"
validate_floor_override DISK_FLOOR_MIN_FREE_INODES "$MIN_FREE_INODES"

TAG="runner[${RUNNER_NAME:-unknown}] run[${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-1}] job[${GITHUB_JOB:-check-disk-floor}]"

if [ "$#" -eq 0 ]; then
  set -- "${GITHUB_WORKSPACE:-.}" "${RUNNER_TEMP:-/tmp}"
fi

status=0
for dir in "$@"; do
  if [ ! -d "$dir" ]; then
    echo "::warning::disk floor check skipped for missing directory: ${dir}"
    continue
  fi
  # df -kP is POSIX-portable: one line per filesystem, sizes in KiB, mount
  # point last. With -i the same layout reports inodes instead of blocks.
  space_line="$(df -kP "$dir" 2>/dev/null | tail -n 1 || true)"
  inode_line="$(df -kPi "$dir" 2>/dev/null | tail -n 1 || true)"
  avail_kb="$(awk '{print $4}' <<< "$space_line")"
  mount="$(awk '{for (i = 6; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : ""); print ""}' <<< "$space_line")"
  free_inodes="$(awk '{print $4}' <<< "$inode_line")"

  case "$avail_kb" in '' | *[!0-9]*) avail_kb='' ;; esac
  case "$free_inodes" in '' | *[!0-9]*) free_inodes='' ;; esac

  echo "DISKFLOOR $(date -u +%Y-%m-%dT%H:%M:%SZ) ${TAG} dir[${dir}] fs[${mount}] avail_kb[${avail_kb:-unknown}] floor_kb[${MIN_FREE_KB}] free_inodes[${free_inodes:-unknown}] floor_inodes[${MIN_FREE_INODES}]"

  if [ -z "$avail_kb" ] && [ -z "$free_inodes" ]; then
    echo "::warning::could not read disk usage for ${dir}; letting the job proceed"
    continue
  fi

  if [ -n "$avail_kb" ] && [ "$avail_kb" -lt "$MIN_FREE_KB" ]; then
    echo "::error::Disk floor breached on ${RUNNER_NAME:-unknown}: ${dir} has ${avail_kb} KiB free, below the ${MIN_FREE_KB} KiB floor. Failing before the heavy step instead of dying on ENOSPC mid-run — re-run the job to land on a host with headroom."
    status=1
  fi
  if [ -n "$free_inodes" ] && [ "$free_inodes" -lt "$MIN_FREE_INODES" ]; then
    echo "::error::Disk floor breached on ${RUNNER_NAME:-unknown}: ${dir} has ${free_inodes} free inodes, below the ${MIN_FREE_INODES} floor. Failing before the heavy step instead of dying on ENOSPC mid-run — re-run the job to land on a host with headroom."
    status=1
  fi
done

exit "$status"
