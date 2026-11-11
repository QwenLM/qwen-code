#!/usr/bin/env bash
# Pre-test host admission gate for the shared self-hosted Linux pool.
#
# The disk floor gate (check-disk-floor.sh) admits a job on free bytes and
# inodes, which says nothing about CPU contention. On 2026-11-11 the hk1 pool
# ran 64-CPU hosts at load 53-98 with 28-140 concurrent vitest processes
# (artifacts disk-pressure-run-43016357976/-43018456551/-43014476470, all
# attempt 1 shard 2). A shard of identical work measures minutes or tens of
# minutes depending only on that occupancy (#10490), and the contention itself
# turns green suites red: `Error: [vitest-worker]: Timeout calling
# "onTaskUpdate"` failed main runs 43018456551 and 43016357976 with 902 of 902
# tests passing, and main run 43014476470 spent the test step's whole 45-minute
# budget before being killed.
#
# The gate does not queue: GitHub has already placed this job, and only a
# re-run can move it to another host. What it changes is WHEN the job fails.
# Breaching before the suites start costs a minute and says "re-run to land on
# a host with headroom"; breaching during them costs the step's whole 45-minute
# budget and reports a test failure that no PR authored. The five-minute load
# average is the input, not the one-minute one: the latter spikes on a
# neighbour's collection phase and would refuse hosts that are about to idle.
#
# Usage: check-host-load.sh
# Reads /proc/loadavg and nproc, so it is Linux-only by construction; every
# caller gates the step on runner.os.
#
# Thresholds (env-overridable, per job):
#   HOST_LOAD_MAX_RATIO       default 2.0, load per CPU at or above which the
#                             host is refused. See the calibration below: this
#                             is a backstop against an unrunnable host, NOT a
#                             predictor of the RPC flake.
#   HOST_LOAD_MAX_WAIT_TRIES  default 6, samples taken before refusing
#   HOST_LOAD_WAIT_SECONDS    default 10, gap between samples
#
# Calibration, from the five-minute load per CPU of the shards above and of
# four shards that passed on the same pool in the same hour:
#
#   red   hk1-4  start 1.34  median 1.43  max 1.54  (RPC timeout)
#   red   hk1-30 start 1.45  median 1.42  max 1.54  (RPC timeout)
#   red   hk1-29 start 0.85  median 1.42  max 1.54  (45-minute step timeout)
#   green hk1-7  start 0.94  median 1.40  max 1.49
#   green hk5-27 start 1.03  median 1.03  max 1.19
#   green hk2-32 start 0.75  median 0.97  max 1.18
#   green hk3-28 start 0.48  median 0.67  max 0.87
#
# The bands OVERLAP: a host that passed reached 1.49 while a host that failed
# started at 0.85, because occupancy grew during the run and only two of the
# three failing hosts were already contended when their suites began. No
# entry-time threshold separates them, and a ceiling tight enough to catch the
# contended two would also refuse hosts that demonstrably pass. The ceiling is
# therefore set above every reading measured on a host that completed its
# suites, so it refuses only a host no sample here has survived, and the RPC
# flake itself is handled where the evidence does exist — the lane re-runs a
# suite whose every test passed and whose only unhandled error was the
# transport. Operators tightening this should expect false refusals; raising it
# further makes the gate inert.
#
# A host that clears the ceiling on any sample is admitted immediately: the
# wait exists to ride out a neighbour finishing, not to hold a healthy host.
# `off` in either knob disables the gate for an operator who needs the pool to
# admit everything while the fleet is being resized.
set -u

MAX_RATIO="${HOST_LOAD_MAX_RATIO:-2.0}"
WAIT_TRIES="${HOST_LOAD_MAX_WAIT_TRIES:-6}"
WAIT_SECONDS="${HOST_LOAD_WAIT_SECONDS:-10}"

TAG="runner[${RUNNER_NAME:-unknown}] run[${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-1}] job[${GITHUB_JOB:-check-host-load}]"

emit_sample() {
  echo "HOSTLOAD $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) ${TAG} cpus[${cpus:-unknown}] load[${loadavg:-unknown}] ratio[${ratio:-unknown}] max_ratio[${MAX_RATIO}]"
}

if [ "$MAX_RATIO" = 'off' ] || [ "$WAIT_TRIES" = 'off' ]; then
  echo "HOSTLOAD ${TAG} disabled by configuration"
  exit 0
fi

if ! [[ "$MAX_RATIO" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "::error::HOST_LOAD_MAX_RATIO must be a positive number or 'off', got '${MAX_RATIO}'"
  exit 1
fi
for override in "MAX_WAIT_TRIES:${WAIT_TRIES}" "WAIT_SECONDS:${WAIT_SECONDS}"; do
  name="HOST_LOAD_${override%%:*}"
  value="${override#*:}"
  if ! [[ "$value" =~ ^[0-9]{1,6}$ ]] || [ "$value" -lt 1 ]; then
    echo "::error::${name} must be a positive integer, got '${value}'"
    exit 1
  fi
done

cpus="$(nproc 2>/dev/null || true)"
case "$cpus" in '' | *[!0-9]*) cpus='' ;; esac
if [ -z "$cpus" ] || [ "$cpus" -lt 1 ]; then
  # No CPU count means no denominator, and a ratio without one would refuse or
  # admit at random. Say so and let the job run: this gate is an optimisation
  # over the honest failure, never a new way to block a lane.
  echo "::warning::could not read the CPU count; admitting the job without a load gate"
  emit_sample
  exit 0
fi

for ((try = 1; try <= WAIT_TRIES; try++)); do
  loadavg="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || true)"
  load5="$(awk '{print $2}' <<< "$loadavg")"
  case "$load5" in '' | *[!0-9.]*) load5='' ;; esac
  if [ -z "$load5" ]; then
    echo "::warning::could not read /proc/loadavg; admitting the job without a load gate"
    emit_sample
    exit 0
  fi
  # awk, not bash arithmetic: the load average is fractional and the ceiling is
  # a ratio. The product is compared against the load so no rounding of the
  # ratio can move the boundary.
  ratio="$(awk -v load="$load5" -v cpus="$cpus" 'BEGIN { printf "%.2f", load / cpus }')"
  emit_sample
  if awk -v load="$load5" -v cpus="$cpus" -v max="$MAX_RATIO" 'BEGIN { exit !(load < cpus * max) }'; then
    exit 0
  fi
  if [ "$try" -lt "$WAIT_TRIES" ]; then
    sleep "$WAIT_SECONDS"
  fi
done

echo "::error::Host load gate breached on ${RUNNER_NAME:-unknown}: five-minute load ${load5} on ${cpus} CPUs (ratio ${ratio}, ceiling ${MAX_RATIO}) after ${WAIT_TRIES} samples. Failing before the suites start instead of spending the test step's budget on a host where green suites time out — re-run the job to land on a host with headroom."
exit 1
