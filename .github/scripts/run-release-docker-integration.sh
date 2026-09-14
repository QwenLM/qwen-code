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
  docker image prune --all --force --filter 'label=org.qwen-code.ci.sandbox=true' --filter 'until=24h' || echo "::warning::old CI sandbox image cleanup failed on ${RUNNER_NAME:-this runner}"
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

# The package.json docker test scripts each rebuild the sandbox image. Run
# vitest directly here so this job reuses the image built above.
QWEN_SANDBOX=docker npx vitest run --root ./integration-tests cli 9>&-
QWEN_SANDBOX=docker npx vitest run --root ./integration-tests interactive 9>&-
