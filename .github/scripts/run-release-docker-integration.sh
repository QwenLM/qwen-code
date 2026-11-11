#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=.github/scripts/apt-mirror-probe.sh
source "$(dirname "${BASH_SOURCE[0]}")/apt-mirror-probe.sh"

cleanup_release_containers() {
  if ! container_ids="$(timeout 30 docker ps -aq --filter "label=org.qwen-code.ci.owner=${RELEASE_CONTAINER_OWNER}" 2>/dev/null)"; then
    echo "::warning::failed to list release containers for ${RELEASE_CONTAINER_OWNER}; they cannot be removed"
    container_ids=''
  fi
  if [ -n "$container_ids" ]; then
    printf '%s\n' "$container_ids" | xargs -r timeout 60 docker rm -f > /dev/null 2>&1 || echo "::warning::failed to remove release containers for ${RELEASE_CONTAINER_OWNER}"
  fi
}

if [ "${1:-}" = 'cleanup' ]; then
  cleanup_release_containers
  remaining="$(timeout 30 docker ps -aq --filter "label=org.qwen-code.ci.owner=${RELEASE_CONTAINER_OWNER}")"
  if [ -n "$remaining" ]; then
    echo "::error::release containers remain for ${RELEASE_CONTAINER_OWNER}: ${remaining//$'\n'/,}"
    exit 1
  fi
  exit 0
fi

trap cleanup_release_containers EXIT
trap 'exit 1' INT TERM

# The test retry below reserves time inside the 120-minute job, so capture
# the epoch at the start of the step: the image build and the gates above
# spend that budget too.
release_step_start_epoch="$(date +%s)"

sandbox_revision="$(git rev-parse HEAD)"
sandbox_image="$(node -p "require('./packages/cli/package.json').config.sandboxImageUri")-release-${sandbox_revision}"

# The job-start disk floor gate predates this build: run 37374675168 passed
# it and the runner still died on ENOSPC 24 minutes into this step (#13479).
# Gate the build's own filesystem — the docker data root — so a saturated
# host fails fast with a legible error and a re-run lands on an instance
# with headroom instead of the runner worker crashing mid-step. The floor is
# the caller's: the pre-build call charges a build-sized budget (8 GiB
# covers a cold builder stage — monorepo install plus bundle layers — and
# the final image, with margin); the pre-vitest call charges the repo's
# calibrated job floor (check-disk-floor.sh's default), because the build
# budget is spent by then and charging it twice would fail every host the
# first gate admitted with less than that much headroom left. Self-hosted
# only, like every other check-disk-floor.sh call site: an ephemeral hosted
# runner starts with an order of magnitude more free disk than either floor.
check_docker_data_root_floor() {
  min_free_kb="$1"
  checkpoint="$2"
  if [ "$RUNNER_ENVIRONMENT" != 'self-hosted' ]; then
    return 0
  fi
  # Validate this gate's own knobs first: the helper validates what it is
  # handed under ITS variable names, so a malformed DISK_FLOOR_DOCKER_*
  # value would otherwise surface as a bad DISK_FLOOR_MIN_FREE_KB — and the
  # pre-vitest knob's typo only after the whole image build.
  for knob in DISK_FLOOR_DOCKER_MIN_FREE_KB DISK_FLOOR_DOCKER_POST_MIN_FREE_KB DISK_FLOOR_DOCKER_MIN_FREE_INODES; do
    if [ -n "${!knob:-}" ] && ! [[ "${!knob}" =~ ^[0-9]{1,18}$ ]]; then
      echo "::error::${knob} must be a non-negative integer of at most 18 digits"
      return 1
    fi
  done
  if [ ! -f .github/scripts/check-disk-floor.sh ]; then
    echo "::warning::docker data root floor gate skipped: .github/scripts/check-disk-floor.sh not present at this ref on ${RUNNER_NAME:-this runner}"
    return 0
  fi
  docker_root="$(timeout 60 docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -z "$docker_root" ] || [ ! -d "$docker_root" ]; then
    echo "::warning::docker data root floor gate skipped: docker data root '${docker_root:-<unreadable>}' is not a readable directory on ${RUNNER_NAME:-this runner}"
    return 0
  fi
  # Dedicated knobs, not the job-start gate's DISK_FLOOR_MIN_FREE_KB and
  # DISK_FLOOR_MIN_FREE_INODES: one env setting must not move both floors.
  # The free-space floor arrives as an argument because the two checkpoints
  # size it differently; the inode floor stays shared. An unset override is
  # forwarded empty so the helper's own default (its :- fallback) applies:
  # copying the calibrated value here would drift the next time the helper
  # is retuned. A failure is re-labelled with this gate's knobs so the
  # operator is not sent to the job-start gate's variables.
  if ! DISK_FLOOR_MIN_FREE_KB="$min_free_kb" \
    DISK_FLOOR_MIN_FREE_INODES="${DISK_FLOOR_DOCKER_MIN_FREE_INODES:-}" \
    bash .github/scripts/check-disk-floor.sh "$docker_root"; then
    echo "::error::docker data root floor gate failed at the ${checkpoint} checkpoint for ${docker_root} on ${RUNNER_NAME:-this runner}; its knobs are DISK_FLOOR_DOCKER_MIN_FREE_KB (pre-build), DISK_FLOOR_DOCKER_POST_MIN_FREE_KB (pre-vitest, pre-retry) and DISK_FLOOR_DOCKER_MIN_FREE_INODES, not the job-start gate's DISK_FLOOR_MIN_FREE_KB / DISK_FLOOR_MIN_FREE_INODES"
    return 1
  fi
}

if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
  mkdir -p "${HOME}/.cache/qwen-code-ci"
  # Same protocol as e2e.yml: the host daemon lock is held shared for the whole
  # step and never upgraded, so preparing an image cannot be starved by the
  # test phase of a run already on the host (run 33637097713).
  exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"
  if ! flock --shared --wait 1800 9; then
    echo "::error::docker daemon read lock not acquired within 30 minutes"
    exit 1
  fi
  exec 8>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build-release-${sandbox_revision}.lock"
  if ! flock --wait 1800 8; then
    echo "::error::docker build coordinator lock not acquired within 30 minutes"
    exit 1
  fi
fi

# Reclaim on every path, before any gate samples the data root: while these
# prunes lived inside the image-missing branch, a re-run that found the
# image cached reached the pre-vitest gate on the same still-saturated
# filesystem that had just failed it, and no retry could recover. They need
# no build mutex — the daily host sweep (ecs-runner/qwen-docker-cleanup)
# runs both with no lock at all — but they do run under the shared daemon
# lock, so each keeps its time bound. This lane passes --no-prune to the
# build, and `until` on images is creation age, so the first line takes
# dangling images older than a day; one that went dangling today waits for
# the daily 02:30 UTC host sweep instead.
timeout 20m docker image prune --force --filter 'until=24h' || echo "::warning::dangling image cleanup failed on ${RUNNER_NAME:-this runner}"
# Image pruning does not reclaim BuildKit's intermediate install/build
# layers. The daily host sweep bounds them at 30 GB, but this lane builds at
# the end of the pool's day, hours after that sweep. No --keep-storage here:
# it is a reserve, not a quota, so on a host with less cache than the
# reserve — exactly the hosts this line exists for — it would reclaim
# nothing.
timeout 20m docker builder prune --all --force --filter 'until=24h' || echo "::warning::docker build cache cleanup failed on ${RUNNER_NAME:-this runner}"

# The presence probe runs with the shared host locks held, so it keeps the
# same bound as every other daemon call — and a timeout must not read as
# "image absent": rebuilding against a wedged daemon would hang with the
# locks held until the job timeout.
image_inspect_status=0
timeout 60 docker image inspect "$sandbox_image" > /dev/null 2>&1 || image_inspect_status=$?
if [ "$image_inspect_status" -eq 124 ]; then
  echo "::error::docker image inspect timed out after 60s on ${RUNNER_NAME:-this runner}; the daemon is wedged — failing instead of holding the shared locks"
  exit 1
fi
if [ "$image_inspect_status" -ne 0 ]; then
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    # Host build mutex, shared with the E2E lane and held only while an image
    # is prepared.
    exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"
    if ! flock --wait 1800 7; then
      echo "::error::docker build lock not acquired within 30 minutes"
      exit 1
    fi
  fi
  # Every daemon call this script makes is time-bounded so a wedged daemon
  # GC cannot hold the shared locks past a peer lane's 30-minute wait. The
  # E2E lane runs this same labelled prune under this same mutex unbounded;
  # bounding that side too is a cross-lane change tracked separately.
  timeout 20m docker image prune --all --force --filter 'label=org.qwen-code.ci.sandbox=true' --filter 'until=24h' || echo "::warning::old CI sandbox image cleanup failed on ${RUNNER_NAME:-this runner}"
  check_docker_data_root_floor "${DISK_FLOOR_DOCKER_MIN_FREE_KB:-8388608}" pre-build
  # This lane prunes the builder cache above, so its apt layers stay cold, and
  # its routed host (`ecs-qwen-hk4-host`, or `ubuntu-latest` when the ECS pool
  # is unavailable) already reaches `deb.debian.org` at MB/s — there the probe
  # keeps the built-in source, as designed. It applies the probe the E2E leg
  # uses (#16214) so a host whose default is throttled builds against a faster
  # endpoint; the always-cold builder cache is unchanged here (#16271).
  apply_apt_mirror
  # See e2e.yml: closing the lock descriptors in the child keeps a descendant
  # that outlives this job from holding the lock.
  if ! npm run build:sandbox -- -s --no-prune -i "$sandbox_image" 7>&- 8>&- 9>&-; then
    echo "::error::sandbox image build failed for ${sandbox_image}; the Docker integration tests did not run"
    exit 1
  fi
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    flock --unlock 7
    exec 7>&-
  fi
fi
# Fails closed under set -e: the id read runs with the locks held, and an
# empty id must never reach QWEN_SANDBOX_IMAGE.
sandbox_image_id="$(timeout 60 docker image inspect --format '{{.Id}}' "$sandbox_image")"
export QWEN_SANDBOX_IMAGE="$sandbox_image_id"
if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
  flock --unlock 8
  exec 8>&-
fi

# Run 37374675168 actually died in the vitest phase, ~15 minutes after the
# build finished: re-gate now that the build's peak and the image it leaves
# behind have landed on this filesystem. The gate sits outside the
# image-missing branch so a re-run that finds the image already cached on a
# still-saturated host is gated before vitest writes container layers to the
# same filesystem. It charges the repo's calibrated job floor
# (check-disk-floor.sh's default), not the build budget: the build has
# already consumed that headroom, so re-charging it here would fail the lane
# after the build succeeded. DISK_FLOOR_DOCKER_POST_MIN_FREE_KB tunes this
# checkpoint independently of the pre-build floor.
check_docker_data_root_floor "${DISK_FLOOR_DOCKER_POST_MIN_FREE_KB:-}" pre-vitest

# The package.json docker test scripts each rebuild the sandbox image. Run
# vitest directly here so this job reuses the image built above.
#
# One retry per suite, for a failure that vitest's own per-test retries did
# not absorb. It cannot rescue a deterministic failure — the second attempt
# fails the same way — so a repeated failure stays red. Reclaim this attempt's
# containers first so a leaked one cannot poison the retry, and re-sample the
# disk floor: the failed attempt's container layers are not all reclaimed by
# the cleanup, so a retry must not start below the floor the first attempt
# was admitted on.
# scripts/tests/release-workflow.test.js binds this budget to the job's
# `timeout-minutes`, so retuning either must update both.
DOCKER_TEST_STEP_BUDGET_SECONDS=6600
# A retry admitted after a fast failure still spends the suite's own length,
# so the gate charges the larger of the failed attempt and the suite's
# expected duration. Measured failures: `cli` 1685s and 2317s, `interactive`
# ~21 minutes in the passing release job. The charge is an estimate, so a
# retry slower than expected can still overrun the step budget; over-refusing a
# retry whose first attempt hung is the safe direction.
DOCKER_TEST_CLI_EXPECTED_SECONDS=2400
DOCKER_TEST_INTERACTIVE_EXPECTED_SECONDS=1260
run_docker_test_suite() {
  QWEN_SANDBOX=docker npx vitest run --root ./integration-tests "$1" 9>&-
}

for suite in cli interactive; do
  attempt_start_epoch="$(date +%s)"
  if run_docker_test_suite "$suite"; then
    continue
  fi
  now_epoch="$(date +%s)"
  attempt_seconds=$(( now_epoch - attempt_start_epoch ))
  elapsed_seconds=$(( now_epoch - release_step_start_epoch ))
  # The retry is admitted only when the time already spent in this step plus
  # its charge plus the suites still to run fit the step's share of
  # `timeout-minutes: 120`: the step starts ~8 minutes into the job, so 110
  # minutes leaves margin, and `interactive` — which follows `cli` — has to
  # run after a `cli` retry.
  expected_suite_seconds="$DOCKER_TEST_CLI_EXPECTED_SECONDS"
  remaining_suite_seconds=0
  if [ "$suite" = 'cli' ]; then
    remaining_suite_seconds="$DOCKER_TEST_INTERACTIVE_EXPECTED_SECONDS"
  else
    expected_suite_seconds="$DOCKER_TEST_INTERACTIVE_EXPECTED_SECONDS"
  fi
  retry_seconds="$attempt_seconds"
  if [ "$expected_suite_seconds" -gt "$retry_seconds" ]; then
    retry_seconds="$expected_suite_seconds"
  fi
  if (( elapsed_seconds + retry_seconds + remaining_suite_seconds > DOCKER_TEST_STEP_BUDGET_SECONDS )); then
    reserve_detail=''
    if [ "$remaining_suite_seconds" -gt 0 ]; then
      reserve_detail=", ${remaining_suite_seconds}s reserved for the remaining suite"
    fi
    echo "::error::Docker integration tests (${suite}) failed after ${attempt_seconds}s (${elapsed_seconds}s of the ${DOCKER_TEST_STEP_BUDGET_SECONDS}s step budget already spent, ${retry_seconds}s charged for the retry${reserve_detail}); a retry would overrun the 120-minute job timeout"
    exit 1
  fi
  cleanup_release_containers
  check_docker_data_root_floor "${DISK_FLOOR_DOCKER_POST_MIN_FREE_KB:-}" pre-retry
  echo "::warning::Docker integration tests (${suite}) failed after ${attempt_seconds}s; retrying once"
  if ! run_docker_test_suite "$suite"; then
    echo "::error::Docker integration tests (${suite}) failed again after a retry"
    exit 1
  fi
done
