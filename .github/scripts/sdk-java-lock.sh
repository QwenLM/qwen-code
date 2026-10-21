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
  local ticket
  ticket=$(printf '%s/%010d-%s' "${queue}" "${seq}" "$$")
  # Publish inside the critical section: a later arrival that sees an empty
  # queue names itself head and wins out of arrival order.
  : >"${ticket}"
  exec 8>&-

  local start=${SECONDS} head name pid mtime age remaining announced=0
  while true; do
    # Drop owners that are gone. A live waiter re-touches every loop, so a
    # stale mtime means the owner is gone even when its PID was recycled to a
    # live process -- that case otherwise wedges an idle lock for every job.
    for head in "${queue}/"*; do
      [[ -e ${head} && ${head##*/} != .seq ]] || continue
      name=${head##*/}
      pid=${name##*-}
      mtime=$(
        stat -c %Y "${head}" 2>/dev/null \
          || { stat -f %m "${head}" 2>/dev/null; } || echo 0
      )
      age=$((${EPOCHSECONDS:-$(date +%s)} - mtime))
      # ponytail: 1800s is far above the ~7s touch cadence of a live waiter.
      if ((age > 1800)) ||
        { ((age > 10)) && ! kill -0 "${pid}" 2>/dev/null; }; then
        rm -f "${head}"
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
      # Leave the queue at acquisition: a holder needs no place in line once
      # the kernel holds the lock, and a trap cannot see this `local` anyway.
      rm -f "${ticket}"
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
