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
# Two classes share the one physical lock. `fast` is the pull-request and
# push feedback lane; its tickets sort before `normal` (approval and main
# full-tier work), so a fast job overtakes full-tier tickets still waiting in
# userspace that have waited less than SDK_JAVA_LOCK_PROMOTE_AFTER. It does
# not overtake the hold already running, nor a head already parked in `flock`,
# which keeps its kernel wait position: a fast job waits for the hold already
# running, at most one parked full-tier head, and the fast-class tickets
# ahead of it (older fast or promoted ones, parked or not), never for the
# full-tier queue still waiting in userspace. A normal ticket that waits more
# than SDK_JAVA_LOCK_PROMOTE_AFTER seconds (default 1200) is promoted into the
# fast class, so continuous fast traffic cannot starve the full tier; under a
# single hold longer than that window every waiting normal ticket crosses the
# threshold together and the queue is plain sequence order.
#
# Source this file and call `sdk_java_lock_acquire <wait-seconds> [fast|full]`
# (an empty tier means normal); it returns non-zero on timeout with the pinned
# `lock not acquired within` error.
sdk_java_lock_acquire() {
  local wait_seconds="${1:?wait seconds required}"
  # Callers pass the workflow tier (`fast`, `full`, or empty); everything but
  # `fast` is the normal class. Resolve it once so the rank, the periodic wait
  # line, and the timeout line all report the class the ticket actually has.
  local class=normal
  if [[ ${2:-normal} == 'fast' ]]; then
    class=fast
  fi
  local rank=1
  if [[ ${class} == 'fast' ]]; then
    rank=0
  fi
  # 1200 s sits well inside both acquisition budgets (the write-back's
  # 5400 s is the shorter). At or above a budget promotion would rename a
  # ticket in the same iteration whose timeout arm deletes it;
  # sdk-java-workflow.test.js pins the default below both budgets.
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
  local ticket
  ticket=$(printf '%s/%d-%010d-%s' "${queue}" "${rank}" "${seq}" "$$")
  # Publish inside the critical section: a later arrival that sees an empty
  # queue names itself head and wins out of arrival order.
  : >"${ticket}"
  exec 8>&-

  local start=${SECONDS} head name pid mtime age remaining last_log=-60 blocking head_hint=0
  local promoted=$((rank == 0)) promoted_ticket keepalive acquired
  while true; do
    # Drop tickets whose owner is gone. A waiter waiting its turn re-touches
    # every loop and a head parked in `flock` re-touches from its keepalive
    # below, so the mtime arm only bounds a ticket whose PID was recycled to
    # a live process.
    for head in "${queue}/"*; do
      [[ -e ${head} && ${head##*/} != .seq ]] || continue
      name=${head##*/}
      pid=${name##*-}
      mtime=$(
        stat -c %Y "${head}" 2>/dev/null \
          || { stat -f %m "${head}" 2>/dev/null; } || echo 0
      )
      age=$((${EPOCHSECONDS:-$(date +%s)} - mtime))
      # 1800s is far above the 2s refresh cadence: this is the arm that
      # clears a ticket whose PID was recycled, since `kill -0` still answers.
      if ((age > 1800)) ||
        { ((age > 10)) && ! kill -0 "${pid}" 2>/dev/null; }; then
        rm -f "${head}"
      fi
    done

    # Age a normal ticket into the fast class so a continuous stream of fast
    # tickets cannot starve full-tier work. The renamed ticket keeps its
    # sequence, so it still precedes fast tickets that arrived after it. Only
    # a waiter reaches this: a head parked in `flock` is already next.
    if ((!promoted && SECONDS - start >= promote_after)); then
      promoted_ticket=$(printf '%s/0-%010d-%s' "${queue}" "${seq}" "$$")
      if mv "${ticket}" "${promoted_ticket}" 2>/dev/null; then
        ticket="${promoted_ticket}"
        promoted=1
        class=fast
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
      # A head that cannot take the lock waits behind the holder, which left
      # the queue when it acquired or never joined it, and behind any ticket
      # that parked in `flock` before rank order made this one the head. Name
      # the holder once here instead of waiting out the budget to find it.
      if ((head_hint == 0)); then
        head_hint=1
        echo "::warning::head of the queue as ticket ${seq} (${class}) but the lock is held, and any ticket already parked in flock still goes first; holder visible from this host:"
        sdk_java_lock_holder_hint "${lock}"
      fi
    fi
    if ((SECONDS - start - last_log >= 60)); then
      last_log=$((SECONDS - start))
      echo "Waiting for the sdk-java host lock as queue ticket ${seq} (${class}, ${remaining}s left in a ${wait_seconds}s budget)"
    fi
    if ((blocking)); then
      # A parked head cannot touch its own ticket, and one hold can outlast
      # the 1800s arm above (a head on 2026-10-21 blocked 3106s), so another
      # waiter would reap a live head. Refresh it at the waiters' cadence from
      # a keepalive that closes the lock fd, so it can never hold the lock,
      # and uses `touch -c`, so it cannot recreate a ticket already removed.
      (
        exec 9>&-
        while sleep 2 && kill -0 $$ 2>/dev/null; do
          touch -c "${ticket}"
        done
      ) </dev/null >/dev/null 2>&1 &
      keepalive=$!
      acquired=0
      if flock --wait "${remaining}" 9; then
        acquired=1
      fi
      kill "${keepalive}" 2>/dev/null || true
      wait "${keepalive}" 2>/dev/null || true
      if ((acquired)); then
        # Leave the queue at acquisition: a holder needs no place in line once
        # the kernel holds the lock, and a trap cannot see this `local` anyway.
        rm -f "${ticket}"
        return 0
      fi
    fi
    if ((SECONDS - start >= wait_seconds)); then
      rm -f "${ticket}"
      # Rank order and promotion can displace a parked head after it entered
      # `flock --wait`; name the queue as it is at timeout, not the value this
      # ticket saw when it parked. Once this was the last ticket the glob
      # stays literal, so say so instead of printing `*`.
      head=$(printf '%s\n' "${queue}/"* | grep -v '/\.seq$' | sort | sed -n '1p')
      [[ -e ${head} ]] || head='(no other ticket queued)'
      echo "::error::sdk-java host lock not acquired within $((wait_seconds / 60)) minutes as queue ticket ${seq} (${class}); head of queue is ${head##*/}"
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
  echo "source ${0} and call sdk_java_lock_acquire <wait-seconds> [fast|full]" >&2
  exit 2
fi
