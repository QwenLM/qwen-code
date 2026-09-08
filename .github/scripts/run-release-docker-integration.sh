#!/usr/bin/env bash
set -euo pipefail

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
