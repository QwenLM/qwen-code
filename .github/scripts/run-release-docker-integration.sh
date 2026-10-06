#!/usr/bin/env bash
set -euo pipefail

cleanup_release_containers() {
  container_ids="$(timeout 30 docker ps -aq --filter "label=org.qwen-code.ci.owner=${RELEASE_CONTAINER_OWNER}" 2>/dev/null)" || container_ids=''
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

sandbox_revision="$(git rev-parse HEAD)"
sandbox_image="$(node -p "require('./packages/cli/package.json').config.sandboxImageUri")-release-${sandbox_revision}"

# The job-start disk floor gate predates this build: run 37374675168 passed
# it and the runner still died on ENOSPC 24 minutes into this step (#13479).
# Gate the build's own filesystem — the docker data root — at a build-sized
# floor, so a saturated host fails fast with a legible error and a re-run
# lands on an instance with headroom instead of the runner worker crashing
# mid-build. 8 GiB covers a cold builder stage (monorepo install + bundle
# layers) plus the final image with margin. Self-hosted only, like every
# other check-disk-floor.sh call site: an ephemeral hosted runner starts
# with an order of magnitude more free disk than this floor.
check_docker_data_root_floor() {
  if [ "$RUNNER_ENVIRONMENT" != 'self-hosted' ]; then
    return 0
  fi
  if [ ! -f .github/scripts/check-disk-floor.sh ]; then
    echo "::warning::docker data root floor gate skipped: .github/scripts/check-disk-floor.sh not present at this ref on ${RUNNER_NAME:-this runner}"
    return 0
  fi
  docker_root="$(timeout 60 docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -z "$docker_root" ] || [ ! -d "$docker_root" ]; then
    echo "::warning::docker data root floor gate skipped: docker data root '${docker_root:-<unreadable>}' is not a readable directory on ${RUNNER_NAME:-this runner}"
    return 0
  fi
  DISK_FLOOR_MIN_FREE_KB="${DISK_FLOOR_MIN_FREE_KB:-8388608}" bash .github/scripts/check-disk-floor.sh "$docker_root"
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

if ! docker image inspect "$sandbox_image" > /dev/null 2>&1; then
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    # Host build mutex, shared with the E2E lane and held only while an image
    # is prepared.
    exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"
    if ! flock --wait 1800 7; then
      echo "::error::docker build lock not acquired within 30 minutes"
      exit 1
    fi
  fi
  timeout 20m docker image prune --all --force --filter 'label=org.qwen-code.ci.sandbox=true' --filter 'until=24h' || echo "::warning::old CI sandbox image cleanup failed on ${RUNNER_NAME:-this runner}"
  # The labelled prune cannot reach untagged images, and this lane passes
  # --no-prune to the build: an image that went dangling after the daily
  # 02:30 UTC sweep would otherwise never be reclaimed.
  timeout 20m docker image prune --force --filter 'until=24h' || echo "::warning::dangling image cleanup failed on ${RUNNER_NAME:-this runner}"
  # Image pruning does not reclaim BuildKit's intermediate install/build
  # layers. The daily host sweep (ecs-runner/qwen-docker-cleanup) bounds them
  # at 30 GB, but this lane builds at the end of the pool's day, hours after
  # that sweep. Every daemon call in this branch is bounded so a slow daemon
  # GC cannot hold the host build mutex past the E2E lane's 30-minute lock
  # wait. No --keep-storage here: it is a reserve, not a quota, so on a host
  # with less cache than the reserve — exactly the hosts this line exists
  # for — it would reclaim nothing.
  timeout 20m docker builder prune --all --force --filter 'until=24h' || echo "::warning::docker build cache cleanup failed on ${RUNNER_NAME:-this runner}"
  check_docker_data_root_floor
  # See e2e.yml: closing the lock descriptors in the child keeps a descendant
  # that outlives this job from holding the lock.
  npm run build:sandbox -- -s --no-prune -i "$sandbox_image" 7>&- 8>&- 9>&-
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    flock --unlock 7
    exec 7>&-
  fi
fi
sandbox_image_id="$(docker image inspect --format '{{.Id}}' "$sandbox_image")"
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
# same filesystem.
check_docker_data_root_floor

# The package.json docker test scripts each rebuild the sandbox image. Run
# vitest directly here so this job reuses the image built above.
QWEN_SANDBOX=docker npx vitest run --root ./integration-tests cli 9>&-
QWEN_SANDBOX=docker npx vitest run --root ./integration-tests interactive 9>&-
