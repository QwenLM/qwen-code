#!/usr/bin/env bash
# shellcheck shell=bash
# flock(2) does not promise an order for blocked waiters, and a waiter that
# re-enters the wait queue loses its place behind every waiter that stayed
# resident -- under continuous arrivals that starves it to its wait budget
# (qwen-code#14743). Take a ticket first, so only the head of line touches
# the lock; the rest sleep. Tickets carry their owner's PID and kernel start
# time, and a ticket whose owner is gone is dropped by the next waiter. The
# lock itself still releases at the step boundary, so release semantics are
# unchanged.
#
# Two classes share the one physical lock. `fast` is the pull-request
# feedback lane; its tickets sort before `normal` (approval and main
# full-tier work), so a PR job waits at most the hold already running plus
# the one normal head already blocked in the kernel, not the full-tier
# queue behind it (qwen-code#14962). A normal ticket that waits more than
# SDK_JAVA_LOCK_PROMOTE_AFTER seconds (default 1200) is promoted into the
# fast class, so continuous PR traffic cannot starve the full tier.
#
# Source this file and call
# `sdk_java_lock_acquire <wait-seconds> [fast|normal]`; it returns non-zero
# on timeout with the pinned `lock not acquired within` error.

# Field 22 of /proc/<pid>/stat is the process start time in clock ticks
# since boot, so a recycled PID can be told apart from the ticket's owner.
# Prints nothing when /proc is unavailable; callers then trust `kill -0`.
sdk_java_lock_owner_start() {
  local pid="${1}"
  sed 's/.*) //' "/proc/${pid}/stat" 2>/dev/null | awk '{print $20}' || true
}

sdk_java_lock_acquire() {
  local wait_seconds="${1:?wait seconds required}"
  local priority="${2:-normal}"
  local rank=1
  if [[ ${priority} == 'fast' ]]; then
    rank=0
  fi
  local promote_after="${SDK_JAVA_LOCK_PROMOTE_AFTER:-1200}"
  local lock="${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"
  local queue="${lock}.queue"
  mkdir -p "${queue}"
  exec 9>"${lock}"

  local self_start
  self_start=$(sdk_java_lock_owner_start "$$")
  self_start=${self_start:-0}

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
  ticket=$(printf '%s/%d-%010d-%s' "${queue}" "${rank}" "${seq}" "$$")
  # Publish inside the critical section: a later arrival that sees an empty
  # queue names itself head and wins out of arrival order. The ticket body
  # records the owner's start time for the recycled-PID check.
  printf '%s\n' "${self_start}" >"${ticket}"
  exec 8>&-

  local start=${SECONDS} head name pid owner_start current_start alive mtime
  local age remaining last_log=-60 blocking head_hint=0 promoted=$((rank == 0))
  local promoted_ticket
  while true; do
    # Drop tickets whose owner is gone. A waiter waiting its turn re-touches
    # every loop; the head cannot while it is blocked in `flock`, so the mtime
    # arm below also bounds a ticket whose PID was recycled to a live process.
    for head in "${queue}/"*; do
      [[ -e ${head} && ${head##*/} != .seq ]] || continue
      name=${head##*/}
      pid=${name##*-}
      owner_start=0
      if [[ -s ${head} ]]; then
        read -r owner_start <"${head}" || true
      fi
      if [[ ! ${owner_start} =~ ^[0-9]+$ ]]; then
        owner_start=0
      fi
      mtime=$(
        stat -c %Y "${head}" 2>/dev/null \
          || { stat -f %m "${head}" 2>/dev/null; } || echo 0
      )
      age=$((${EPOCHSECONDS:-$(date +%s)} - mtime))
      alive=0
      if kill -0 "${pid}" 2>/dev/null; then
        alive=1
        # A recycled PID has a different start time from the ticket's owner.
        if ((owner_start > 0)); then
          current_start=$(sdk_java_lock_owner_start "${pid}")
          if [[ -n ${current_start} && ${current_start} != "${owner_start}" ]]; then
            alive=0
          fi
        fi
      fi
      # 1800s is far above one full hold (~925s): it is the backstop for a
      # ticket with no recorded start time, where only the PID can be checked.
      if ((age > 1800)) ||
        { ((age > 10)) && ((alive == 0)); }; then
        rm -f "${head}"
      fi
    done

    # Age a normal ticket into the fast class so a continuous PR stream
    # cannot starve the full tier. The renamed ticket keeps its sequence, so
    # it still precedes fast tickets that arrived after it.
    if ((!promoted && SECONDS - start >= promote_after)); then
      promoted_ticket=$(printf '%s/0-%010d-%s' "${queue}" "${seq}" "$$")
      if mv "${ticket}" "${promoted_ticket}" 2>/dev/null; then
        ticket="${promoted_ticket}"
        promoted=1
        echo "Promoted sdk-java host lock queue ticket ${seq} to the fast class after $((promote_after / 60)) minutes"
      fi
    fi

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
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${priority}, ${remaining}s left in a ${wait_seconds}s budget)"
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
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq} (${priority}); head of queue is ${head##*/}"
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
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds> [fast|normal]" >&2
  exit 2
fi
