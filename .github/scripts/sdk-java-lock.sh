#!/usr/bin/env bash
# shellcheck shell=bash
# flock(2) does not order its wakeups: under continuous arrivals one waiter
# can lose every release and starve to its wait budget (qwen-code#14743).
# Take a ticket first, so only the oldest live ticket touches the lock; the
# rest sleep. Tickets carry their owner's PID, and a dead owner's ticket is
# dropped by the next waiter. The lock itself still releases at the step
# boundary, so release semantics are unchanged.
#
# Two classes share the one physical lock. `fast` is the pull-request
# feedback lane; it is served before `normal` (approval and main full-tier
# work), so a PR job waits at most the hold already running instead of a
# queue of long full-tier holds (qwen-code#14962). A normal ticket that waits
# more than SDK_JAVA_LOCK_PROMOTE_AFTER seconds (default 1200) is promoted
# into the fast class, so continuous PR traffic cannot starve the full tier.
#
# Source this file and call
# `sdk_java_lock_acquire <wait-seconds> [fast|normal]`. On success the lock
# stays on fd 9 in the step shell, so it releases automatically at the step
# boundary exactly like the inline `flock --wait` block did; the armed traps
# drop the ticket on exit, interrupt or termination. On timeout the function
# prints the pinned infrastructure-signature line and returns 1.
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
  local seq_padded
  seq_padded=$(printf '%010d' "${seq}")
  local ticket="${queue}/${rank}.${seq_padded}.$$.ticket"
  : >"${ticket}"

  local start=${SECONDS} head name pid mtime remaining announced=0
  local promoted=$((rank == 0))
  while true; do
    # Drop dead owners' tickets. The 10-second mtime guard skips a ticket
    # whose owner is between touches, and a recycled PID alone cannot clear a
    # live waiter.
    for head in "${queue}/"*.ticket; do
      [[ -e ${head} ]] || continue
      name=${head##*/}
      pid=${name%.ticket}
      pid=${pid##*.}
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

    # Age a normal ticket into the fast class so a continuous PR stream
    # cannot starve the full tier.
    if ((!promoted && SECONDS - start >= promote_after)); then
      local promoted_ticket="${queue}/0.${seq_padded}.$$.ticket"
      if mv "${ticket}" "${promoted_ticket}" 2>/dev/null; then
        ticket="${promoted_ticket}"
        promoted=1
        echo "Promoted sdk-java host lock queue ticket ${seq} to the fast class after $((promote_after / 60)) minutes"
      fi
    fi

    # sed -n 1p consumes every line: head -n 1 would close the pipe early
    # and pipefail would then fail the assignment with a SIGPIPE status.
    head=$(printf '%s\n' "${queue}/"*.ticket | sort | sed -n '1p')
    remaining=$((wait_seconds - (SECONDS - start)))
    if ((remaining < 0)); then
      remaining=0
    fi
    # Head of line: block inside the kernel's wake race like the legacy
    # inline `flock --wait` waiters still run elsewhere, in five-second
    # slices so the budget stays sharp.
    if [[ ${head} == "${ticket}" && ${remaining} -gt 0 ]] \
      && flock --wait "$((remaining < 5 ? remaining : 5))" 9; then
      # The traps outlive this function's locals: an EXIT trap expands its
      # command after the function has returned, when `ticket` is gone.
      SDK_JAVA_LOCK_TICKET="${ticket}"
      trap 'rm -f "${SDK_JAVA_LOCK_TICKET}"' EXIT
      trap 'rm -f "${SDK_JAVA_LOCK_TICKET}"; exit 143' TERM
      trap 'rm -f "${SDK_JAVA_LOCK_TICKET}"; exit 130' INT
      return 0
    fi
    if ((!announced)); then
      announced=1
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${priority})"
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq} (${priority})"
      return 1
    fi
    touch "${ticket}"
    sleep 2
  done
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds> [fast|normal]" >&2
  exit 2
fi
