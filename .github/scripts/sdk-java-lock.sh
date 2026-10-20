#!/usr/bin/env bash
# shellcheck shell=bash
# flock(2) does not order its wakeups: under continuous arrivals one waiter
# can lose every release and starve to its wait budget (qwen-code#14743).
# Take a ticket first, so only the oldest live ticket touches the lock; the
# rest sleep. Tickets carry their owner's PID, and a dead owner's ticket is
# dropped by the next waiter. The lock itself still releases at the step
# boundary, so release semantics are unchanged.
#
# Source this file and call `sdk_java_lock_acquire <wait-seconds>`; it returns
# non-zero on timeout with the pinned `lock not acquired within` error.
sdk_java_lock_acquire() {
  local wait_seconds="${1:?wait seconds required}"
  local lock="${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"
  local queue="${lock}.queue"
  mkdir -p "${queue}"
  exec 9>"${lock}"

  # Atomic sequence: fd 8 holds the counter file and flock serializes the
  # read-increment-write. A holder killed inside this millisecond window only
  # costs one sequence number, not a stuck queue.
  # Append, never truncate: opening with `>` would wipe the counter before
  # this process even takes the lock.
  exec 8>>"${queue}/.seq"
  flock 8
  local seq
  seq=$(tail -n 1 "${queue}/.seq" 2>/dev/null)
  seq=$((${seq:-0} + 1))
  printf '%s\n' "${seq}" >>"${queue}/.seq"
  exec 8>&-
  local ticket
  ticket=$(printf '%s/%010d-%s' "${queue}" "${seq}" "$$")
  : >"${ticket}"

  local start=${SECONDS} head name pid mtime remaining announced=0
  while true; do
    # Drop dead owners' tickets. The 10-second mtime guard skips a ticket
    # whose owner is between touches, and a recycled PID alone cannot clear a
    # live waiter.
    for head in "${queue}/"*; do
      [[ -e ${head} && ${head##*/} != .seq ]] || continue
      name=${head##*/}
      pid=${name##*-}
      if ! kill -0 "${pid}" 2>/dev/null; then
        mtime=$(
          stat -c %Y "${head}" 2>/dev/null \
            || { stat -f %m "${head}" 2>/dev/null; } || echo 0
        )
        if ((${EPOCHSECONDS:-$(date +%s)} - mtime > 10)); then
          rm -f "${head}"
        fi
      fi
    done

    head=$(printf '%s\n' "${queue}/"* | grep -v '/\.seq$' | sort | sed -n '1p')
    remaining=$((wait_seconds - (SECONDS - start)))
    ((remaining < 0)) && remaining=0
    # Head of line: block inside the kernel's wake race like the legacy
    # inline `flock --wait` waiters still run elsewhere, in five-second slices
    # so the budget stays sharp.
    if [[ ${head} == "${ticket}" && ${remaining} -gt 0 ]] \
      && flock --wait "$((remaining < 5 ? remaining : 5))" 9; then
      trap 'rm -f "${ticket}"' EXIT
      trap 'rm -f "${ticket}"; exit 143' TERM
      trap 'rm -f "${ticket}"; exit 130' INT
      return 0
    fi
    if ((!announced)); then
      announced=1
      echo "Waiting for the sdk-java host lock as queue ticket ${seq}"
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq}"
      return 1
    fi
    touch "${ticket}"
    sleep 2
  done
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds>" >&2
  exit 2
fi
