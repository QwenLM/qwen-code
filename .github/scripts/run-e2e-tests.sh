#!/usr/bin/env bash

set -euo pipefail

sandbox="${1:?usage: run-e2e-tests.sh <sandbox> <shard>}"
shard="${2:?usage: run-e2e-tests.sh <sandbox> <shard>}"

cleanup_e2e_job() {
  if [ "$sandbox" = 'sandbox:docker' ]; then
    container_ids="$(timeout 30 docker ps -aq --filter "label=org.qwen-code.ci.owner=${E2E_CONTAINER_OWNER}" 2>/dev/null)" || container_ids=''
    if [ -n "$container_ids" ]; then
      printf '%s\n' "$container_ids" | xargs -r timeout 60 docker rm -f > /dev/null 2>&1 || echo "::warning::failed to remove E2E containers for ${E2E_CONTAINER_OWNER}"
    fi
  fi
  if [ -n "${QWEN_CI_TMPDIR:-}" ]; then
    rm -rf "$QWEN_CI_TMPDIR" 2>/dev/null || true
  fi
}
trap cleanup_e2e_job EXIT
trap 'exit 1' INT TERM

if [ "$sandbox" = 'sandbox:docker' ]; then
  sandbox_image="$(node -p "require('./packages/cli/package.json').config.sandboxImageUri")-e2e-${GITHUB_SHA}"

  # 7>&- 8>&- 9>&- here and on the test command below: a lock
  # lives on the open file description, so a descendant that
  # inherits the descriptor and outlives this job keeps holding it.
  # Closing it in the child costs nothing — this shell keeps the
  # lock — and leaves no way to leak one onto the host.
  build_image() {
    npm run build:sandbox -- -s --no-prune -i "$sandbox_image" 7>&- 8>&- 9>&-
  }

  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    mkdir -p "${HOME}/.cache/qwen-code-ci"
    # Host daemon lock, shared for the whole step and never
    # upgraded: it only keeps the age-based prune (which takes it
    # exclusively, non-blocking) off a daemon with Docker work in
    # flight. #10605 upgraded it to exclusive to build an image,
    # which starves that shard behind the test-phase readers of
    # every other run on the host: in run 33637097713 shard 1/3
    # gave up on the write lock after 30 minutes while a shard of
    # run 33638984513 held the shared lock through its tests, and
    # shard 2/3 then timed out on the coordinator lock shard 1/3
    # was still holding.
    exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"
    if ! flock --shared --wait 1800 9; then
      echo "::error::docker daemon read lock not acquired within 30 minutes"
      exit 1
    fi
    # Per-commit coordinator: one job builds the image; a concurrent
    # run at the same SHA waits here and then finds it present.
    exec 8>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build-e2e-${GITHUB_SHA}.lock"
    if ! flock --wait 1800 8; then
      echo "::error::docker build coordinator lock not acquired within 30 minutes"
      exit 1
    fi
  fi

  if ! docker image inspect "$sandbox_image" > /dev/null 2>&1; then
    if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
      # Host build mutex: keeps concurrent image builds off one
      # daemon. Held only while an image is prepared, never while
      # tests run, so the wait is bounded by a build.
      exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"
      if ! flock --wait 1800 7; then
        echo "::error::docker build lock not acquired within 30 minutes"
        exit 1
      fi
    fi
    # Label- and age-filtered, so it cannot touch the image a
    # concurrent shard is testing.
    docker image prune --all --force --filter 'label=org.qwen-code.ci.sandbox=true' --filter 'until=24h' || echo "::warning::old CI sandbox image cleanup failed on ${RUNNER_NAME:-this runner}"
    if ! build_image; then
      echo "::warning::sandbox image build failed; retrying once"
      build_image
    fi
    if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
      flock --unlock 7
      exec 7>&-
    fi
  else
    echo "Reusing sandbox image for ${GITHUB_SHA}"
  fi

  sandbox_image_id="$(docker image inspect --format '{{.Id}}' "$sandbox_image")"
  export QWEN_SANDBOX_IMAGE="$sandbox_image_id"
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    flock --unlock 8
    exec 8>&-
  fi
fi

export TMPDIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
if [ "${RUNNER_OS:-}" = 'Linux' ]; then
  QWEN_CI_TMPDIR="$(mktemp -d /var/tmp/qwen-ci-XXXXXX 2>/dev/null || true)"
  if [ -n "$QWEN_CI_TMPDIR" ]; then
    TMPDIR="$QWEN_CI_TMPDIR"
    export TMPDIR
  fi
fi

# QWEN_E2E_RENDERER=ink pins the baseline leg of the renderer
# matrix; the opentui leg runs in e2e-interactive-opentui below.
# The docker leg runs vitest directly instead of through
# test:integration:sandbox:docker: that script would rebuild the image
# the step above just built.
# Keep suites that launch many real CLI/daemon subprocesses out of
# the three-fork batch so they cannot starve each other's local control
# and HTTP requests.
run_vitest() {
  if [ "$sandbox" = 'sandbox:docker' ]; then
    npx cross-env QWEN_E2E_RENDERER=ink QWEN_SANDBOX=docker vitest run --root ./integration-tests "$@" 9>&-
  else
    QWEN_E2E_RENDERER=ink npm run test:integration:sandbox:none -- "$@"
  fi
}

bulk_args=(
  --exclude '**/interactive/cron-interactive.test.ts'
  --exclude '**/channel-plugin.test.ts'
  --exclude '**/chat-transcript-document.test.ts'
  --exclude '**/qwen-serve-routes.test.ts'
  --exclude '**/sdk-typescript/**'
  --poolOptions.forks.maxForks=3
  --shard="$shard"
)

run_shard() {
  run_vitest "${bulk_args[@]}" &&
    run_vitest sdk-typescript cli/qwen-serve-routes.test.ts --poolOptions.forks.maxForks=1
}

if [ "$sandbox" = 'sandbox:docker' ]; then
  run_shard
else
  # One bounded retry: pool runners' sandbox:none shards die under
  # shared-host pressure with every test green and no vitest FAIL
  # line — runs 33293739505, 33302550436 and 33317457036 failed
  # this leg on three different hosts while sibling shards of the
  # same runs passed, and the shard passes on re-run. The same
  # transient class the sandbox-image build retry above covers
  # (#10355). A deterministic test failure fails both attempts and
  # keeps the shard red. The retry is budget-gated on job-elapsed
  # time: two of those three runs died with ~10-12 of the 60 job
  # minutes left, less than one shard-time, where a retry can only
  # be cancelled mid-flight by timeout-minutes. The docker leg
  # keeps no retry: two ~30min attempts would outrun the job's
  # timeout-minutes.
  run_shard || {
    elapsed=$(( $(date +%s) - ${E2E_JOB_START_EPOCH:-0} ))
    # Budget gate: a retry needs a full shard-time inside the job's
    # timeout-minutes. 3600s minus a 25-minute reserve — the worst
    # measured shard is ~21min under shared-host pressure — leaves
    # 2100s; past that, GitHub cancels the retry mid-flight, burns
    # pool time, and the failure degrades to a timeout signature.
    if (( elapsed > 2100 )); then
      echo "::error::sandbox:none shard failed on ${RUNNER_NAME:-this runner} after ${elapsed}s of the 3600s job budget — not enough left for a retry"
      exit 1
    fi
    echo "::warning::sandbox:none shard failed on ${RUNNER_NAME:-this runner} after ${elapsed}s; retrying once (transient shared-host pressure class)"
    run_shard
  }
fi
