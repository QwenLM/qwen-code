#!/usr/bin/env bash
# shellcheck shell=bash
# fifo(2) wakeups on flock(2) are unordered: under continuous arrivals one
# waiter can lose every release and die at its wait budget (qwen-code#14743).
# This helper turns the shared sdk-java-tests.lock into a ticketed queue —
# every acquirer takes the next sequence number atomically and only the
# smallest live number even tries the lock, so the wait is bounded by
# position instead of luck. The head retries with a blocking `flock --wait`
# slice, not a --nonblock poll: a mixed fleet still holds legacy inline
# `flock --wait` waiters, and a polled head loses every release to the kernel
# wakeups those legacy waiters get — this PR's first live run starved the
# full 5400 s budget as queue ticket 1 behind exactly those holders. Tickets
# belong to `${lock}.queue/` and carry their owner's PID; the queue and the
# PID namespace are both per-host, so a cancelled or killed step's orphaned
# ticket is reaped by the next head-of-line check.
#
# Two classes share the one physical lock. `fast` is the pull-request
# feedback lane; it is served before `normal` (approval and main full-tier
# work), so a fast job never waits behind a queue of long full-tier holds —
# its worst wait is the hold already running. A normal ticket that waits
# more than SDK_JAVA_LOCK_PROMOTE_AFTER seconds (default 1200) is promoted
# into the fast class, so continuous PR traffic cannot starve the full tier.
#
# Source this file from the locking step and call
# `sdk_java_lock_acquire <wait-seconds> [fast|normal]`. On success the lock
# stays on fd 9 in the step shell, so it releases automatically at the step
# boundary exactly like the inline `flock --wait` block did; the armed traps
# drop the ticket on exit, interrupt or termination. On timeout the function
# prints the pinned infrastructure-signature line and returns 1.
sdk_java_lock_acquire() {
  local wait_seconds="${1:?wait seconds required}"
  local priority="${2:-normal}"
  local rank=1
  [[ ${priority} == 'fast' ]] && rank=0
  local promote_after="${SDK_JAVA_LOCK_PROMOTE_AFTER:-1200}"
  local lock="${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"
  local queue="${lock}.queue"
  mkdir -p "${queue}"
  exec 9>"${lock}"

  # The sequence increment needs its own exclusion: a counter-lock directory
  # gives atomic enter/leave. A holder dying inside the section leaves the
  # directory behind, so a contender aging past one minute clears it; rmdir on
  # an empty directory is the compare-and-swap, and the loser's rmdir simply
  # fails.
  local counter="${queue}/.counter.lock" guard=0
  while ! mkdir "${counter}" 2>/dev/null; do
    guard=$((guard + 1))
    if ((guard > 120)); then
      if [[ -n $(find "${counter}" -maxdepth 0 -mmin +1 -print -quit 2>/dev/null) ]]; then
        rmdir "${counter}" 2>/dev/null || true
        guard=0
      else
        sleep 1
      fi
    else
      sleep 0.1
    fi
  done

  local seq=0
  # No `[[ ]] &&`: an absent counter must not trip the steps' bash -e.
  if [[ -f ${queue}/.seq ]]; then
    seq=$(cat "${queue}/.seq")
  fi
  seq=$((seq + 1))
  printf '%s\n' "${seq}" >"${queue}/.seq"
  local seq_padded
  seq_padded=$(printf '%010d' "${seq}")
  local ticket="${queue}/${rank}.${seq_padded}.$$.ticket"
  : >"${ticket}"
  rmdir "${counter}"

  # The wait line prints on the first wait, then caps at one per minute.
  local start=${SECONDS} heart=$((SECONDS - 61)) head name pid mtime
  local promoted=$((rank == 0))
  while true; do
    # Reap dead owners: their ticket can neither hold nor wait in line. A
    # live waiter touches its ticket every loop, so the 10-second mtime
    # guard skips one mid-creation and a recycled PID alone cannot clear it.
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
    # Head of line: block inside the kernel's wake race like every legacy
    # inline `flock --wait` waiter that main and older branches still run,
    # in five-second slices so the shared budget below stays sharp.
    remaining=$((wait_seconds - (SECONDS - start)))
    ((remaining < 0)) && remaining=0
    if [[ ${head} == "${ticket}" && ${remaining} -gt 0 ]] \
      && flock --wait "$((remaining < 5 ? remaining : 5))" 9; then
      sdk_java_lock_ticket=${ticket}
      sdk_java_lock_release() { [[ -n ${sdk_java_lock_ticket} ]] && rm -f "${sdk_java_lock_ticket}"; sdk_java_lock_ticket=; }
      trap 'sdk_java_lock_release' EXIT
      trap 'sdk_java_lock_release; exit 143' TERM
      trap 'sdk_java_lock_release; exit 130' INT
      return 0
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq} (${priority})"
      return 1
    fi
    if ((SECONDS - heart >= 60)); then
      heart=${SECONDS}
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${priority})"
    fi
    touch "${ticket}"
    sleep 2
  done
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds> [fast|normal]" >&2
  exit 2
fi
