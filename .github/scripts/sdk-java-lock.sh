#!/usr/bin/env bash
# shellcheck shell=bash
# flock(2) does not promise an order for blocked waiters, and a waiter that
# re-enters the wait queue loses its place behind every waiter that stayed
# resident -- under continuous arrivals that starves it to its wait budget
# (qwen-code#14743). Take a ticket first, so only the head of line touches
# the lock; the rest sleep. Tickets carry their owner's PID, and a ticket
# whose owner is gone is dropped by the next waiter. The lock itself still
# releases at the step boundary, so release semantics are unchanged.
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

  local start=${SECONDS} head name pid mtime age remaining last_log=-60
  while true; do
    # Drop tickets whose owner is gone. A waiter waiting its turn re-touches
    # every loop; the head cannot while it is blocked in `flock`, so the mtime
    # arm below also bounds a ticket whose PID was recycled to a live process.
    for head in "${queue}/"*; do
      [[ -e ${head} && ${head##*/} != .seq ]] || continue
      name=${head##*/}
      pid=${name##*-}
      mtime=$(
        stat -c %Y "${head}" 2>/dev/null \
          || { stat -f %m "${head}" 2>/dev/null; } || echo 0
      )
      age=$((${EPOCHSECONDS:-$(date +%s)} - mtime))
      # 1800s is far above one full hold (~925s): this is the arm that clears
      # a ticket whose PID was recycled, since `kill -0` still answers for it.
      if ((age > 1800)) ||
        { ((age > 10)) && ! kill -0 "${pid}" 2>/dev/null; }; then
        rm -f "${head}"
      fi
    done

    head=$(printf '%s\n' "${queue}/"* | grep -v '/\.seq$' | sort | sed -n '1p')
    remaining=$((wait_seconds - (SECONDS - start)))
    ((remaining < 0)) && remaining=0
    # Head of line: one blocking wait, so this ticket enters the kernel's
    # wait queue once and keeps its arrival position. Re-entering every few
    # seconds would put it behind every waiter that stayed blocked.
    if [[ ${head} == "${ticket}" && ${remaining} -gt 0 ]] \
      && flock --wait "${remaining}" 9; then
      # Leave the queue at acquisition: a holder needs no place in line once
      # the kernel holds the lock, and a trap cannot see this `local` anyway.
      rm -f "${ticket}"
      return 0
    fi
    if ((SECONDS - start - last_log >= 60)); then
      last_log=$((SECONDS - start))
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${remaining}s left in a ${wait_seconds}s budget)"
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq}; head of queue is ${head##*/}"
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
