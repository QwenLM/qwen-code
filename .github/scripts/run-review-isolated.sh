#!/usr/bin/env bash
set -euo pipefail

# Hosted jobs do not share a persistent host with other repository runners.
if [[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]]; then
  exec "$@"
fi
if [[ ${RUNNER_ENVIRONMENT:-} != self-hosted || $(uname -s) != Linux ]] || ! command -v bwrap >/dev/null; then
  echo 'Review isolation requires Linux and bubblewrap on self-hosted runners.' >&2
  exit 1
fi

workspace=$(cd "${GITHUB_WORKSPACE:?}" && pwd -P)
scratch=$(cd "${RUNNER_TEMP:?}" && pwd -P)
if [[ $workspace == / || $scratch == / || $workspace == "$scratch" ]]; then
  echo 'Refusing invalid review bind roots.' >&2
  exit 1
fi
home=$(mktemp -d "$scratch/review-home.XXXXXX")
mounts=()
if [[ -f ${HOME:?}/.gitconfig ]]; then
  mounts+=(--ro-bind "$HOME/.gitconfig" "$home/.gitconfig")
fi

# Keep the installed toolchain and network, but not host PIDs or daemon sockets.
# bwrap sets no_new_privs; setuid sudo cannot regain host privileges.
# Never fall back to a host invocation if namespace setup fails.
exec bwrap \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --die-with-parent --cap-drop ALL \
  --ro-bind / / --dev /dev --proc /proc \
  --tmpfs /tmp --tmpfs /run \
  --bind "$workspace" "$workspace" \
  --bind "$scratch" "$scratch" \
  ${mounts[@]+"${mounts[@]}"} \
  --unsetenv DOCKER_HOST --unsetenv DOCKER_CONTEXT --unsetenv SSH_AUTH_SOCK \
  --setenv HOME "$home" --chdir "$workspace" -- "$@"
