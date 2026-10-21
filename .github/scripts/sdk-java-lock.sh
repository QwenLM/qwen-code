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

  local start=${SECONDS} head name pid mtime age remaining last_log=-60 blocking head_hint=0
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
    blocking=0
    if [[ ${head} == "${ticket}" && ${remaining} -gt 0 ]]; then
      # Probe first, so the wait line is printed before blocking: a head
      # parked behind a sibling hold used to emit nothing for the whole
      # budget (run 39528681869's step sat in flock for 40 minutes silently).
      if flock --nonblock 9; then
        rm -f "${ticket}"
        return 0
      fi
      blocking=1
      # A head that cannot take the lock is starved by an unticketed holder;
      # name it once here instead of waiting out the budget to find it.
      if ((head_hint == 0)); then
        head_hint=1
        echo "::warning::head of the queue as ticket ${seq} but the lock is held; holder visible from this host:"
        sdk_java_lock_holder_hint "${lock}"
      fi
    fi
    if ((SECONDS - start - last_log >= 60)); then
      last_log=$((SECONDS - start))
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${remaining}s left in a ${wait_seconds}s budget)"
    fi
    if ((blocking)); then
      if flock --wait "${remaining}" 9; then
        # Leave the queue at acquisition: a holder needs no place in line once
        # the kernel holds the lock, and a trap cannot see this `local` anyway.
        rm -f "${ticket}"
        return 0
      fi
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq}; head of queue is ${head##*/}"
      echo "holder of ${lock} at timeout:"
      sdk_java_lock_holder_hint "${lock}"
      return 1
    fi
    touch "${ticket}"
    sleep 2
  done
}

# Best-effort: report who currently holds the lock file. The ticket queue
# only orders ticketed waiters; a holder that never took a ticket (a stray
# process left by a canceled job, or the fallback path of a resumed release
# tag) starves the head while every waiter reports itself as head of queue.
# /proc/locks is host-local: an empty answer while the wait budget burns
# means the holder lives on ANOTHER machine sharing this HOME -- that
# negative result is the hint, not a probe failure.
sdk_java_lock_holder_hint() {
  local lock="$1"
  if command -v lslocks >/dev/null 2>&1; then
    lslocks --output PID,TYPE,COMMAND,PATH 2>/dev/null | grep -F -- "${lock}" && return 0
  elif command -v fuser >/dev/null 2>&1; then
    fuser -v "${lock}" 2>&1 && return 0
  fi
  echo '(no holder visible from this host)'
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds>" >&2
  exit 2
fi
