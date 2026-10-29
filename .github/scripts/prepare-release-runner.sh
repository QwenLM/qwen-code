#!/usr/bin/env bash
set -euo pipefail
umask 077
# Reject symlinked or non-canonical paths before recursive changes.
RWS="${RUNNER_WORKSPACE:?}"
while [ "${RWS%/}" != "$RWS" ]; do RWS="${RWS%/}"; done
if [ -L "$RWS" ]; then
  echo "::error::refusing to wipe: runner workspace is a symlink: ${RWS}"
  exit 1
fi
RWS_LEX="$(realpath -m -s -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize ${RUNNER_WORKSPACE}"; exit 1; }
RWS="$(realpath -m -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize ${RUNNER_WORKSPACE}"; exit 1; }
if [ "$RWS" != "$RWS_LEX" ]; then
  echo "::error::refusing to wipe: runner workspace resolves through a symlinked component: ${RWS_LEX} resolves to ${RWS}"
  exit 1
fi
while [ "${RWS%/}" != "$RWS" ]; do RWS="${RWS%/}"; done
if [ -z "$RWS" ]; then echo "::error::refusing to wipe: runner workspace resolved to /"; exit 1; fi
case "$RWS" in
  ..|../*|*/..|*/../*) echo "::error::refusing runner workspace path containing '..': ${RWS}"; exit 1 ;;
esac
WS="${GITHUB_WORKSPACE:?}"
while [ "${WS%/}" != "$WS" ]; do WS="${WS%/}"; done
# Heal only a corrupt leaf whose canonical parent remains contained.
if [ -L "$WS" ] || [ ! -d "$WS" ]; then
  HEAL_PARENT="$(realpath -m -- "$(dirname -- "$WS")" 2>/dev/null)" || { echo "::error::refusing to heal: realpath unavailable, cannot canonicalize the parent of ${WS}"; exit 1; }
  case "$HEAL_PARENT" in
    "$RWS"|"$RWS"/*) ;;
    *) echo "::error::refusing to heal workspace outside the runner workspace: ${WS} (parent: ${HEAL_PARENT}, runner workspace: ${RWS})"; exit 1 ;;
  esac
  if [ -L "$WS" ]; then
    # Keep attacker-controlled link text out of workflow commands.
    heal_target="$(readlink -- "$WS" 2>/dev/null || printf '%s' '<unreadable>')"
    heal_target="$(printf '%s' "$heal_target" | tr -d '\r\n' | cut -c1-200)"
    echo "::warning::healing workspace ${WS}: it was a symlink"
    printf 'heal: %s pointed at %s\n' "$WS" "$heal_target"
  else
    echo "::warning::healing workspace ${WS}: it was not a directory"
  fi
  # Remove the raw link path; never resolve its target.
  rm -f -- "$WS" || { echo "::error::refusing to continue: could not remove ${WS}"; exit 1; }
  mkdir -- "$WS" || { echo "::error::refusing to continue: could not recreate ${WS}"; exit 1; }
fi
WS_LEX="$(realpath -m -s -- "$WS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize ${GITHUB_WORKSPACE}"; exit 1; }
WS="$(realpath -m -- "$WS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize ${GITHUB_WORKSPACE}"; exit 1; }
if [ "$WS" != "$WS_LEX" ]; then
  echo "::error::refusing to wipe: workspace resolves through a symlinked component: ${WS_LEX} resolves to ${WS}"
  exit 1
fi
while [ "${WS%/}" != "$WS" ]; do WS="${WS%/}"; done
case "$WS" in
  ..|../*|*/..|*/../*) echo "::error::refusing to wipe path containing '..': ${WS}"; exit 1 ;;
esac
# Deny known roots, then allow only runner-workspace descendants.
case "$WS" in
  /|/home|/root|/usr*|/etc*|/var|"") echo "::error::refusing to wipe suspicious workspace path: ${WS}"; exit 1 ;;
esac
case "$WS" in
  "$RWS"/*) ;;
  *) echo "::error::refusing to wipe workspace outside the runner workspace: ${WS} (runner workspace: ${RWS})"; exit 1 ;;
esac
# Path geometry is validated before ownership changes.
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"
if [ "$RUNNER_UID" != "0" ]; then
  chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace ownership; checkout may fail on leftover root-owned files"
fi
chmod -R u+rwX "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chmod -R u+rwX "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace write permissions; checkout may fail on leftover read-only files"
find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
# Isolate Git, npm, Docker, and gh state inherited across pool jobs.
release_state="$(mktemp -d "${RUNNER_TEMP:?}/release-state.XXXXXX")" || exit 1
: > "${release_state}/gitconfig" || exit 1
: > "${release_state}/npmrc" || exit 1
mkdir "${release_state}/docker" || exit 1
mkdir "${release_state}/gh" || exit 1
{
  echo 'GIT_CONFIG_COUNT=0'
  echo 'GIT_CONFIG_NOSYSTEM=1'
  echo 'GIT_CONFIG_PARAMETERS='
  echo "GIT_CONFIG_GLOBAL=${release_state}/gitconfig"
  echo "NPM_CONFIG_USERCONFIG=${release_state}/npmrc"
  echo "DOCKER_CONFIG=${release_state}/docker"
  echo "GH_CONFIG_DIR=${release_state}/gh"
} >> "${GITHUB_ENV:?}"
mkdir -p "${release_state}/bin" "${release_state}/maven"
{
  echo "RELEASE_RUNNER_STATE=${release_state}"
  echo "NPM_CONFIG_PREFIX=${release_state}"
  echo "MAVEN_OPTS=-Dmaven.repo.local=${release_state}/maven"
} >> "${GITHUB_ENV}"
echo "${release_state}/bin" >> "${GITHUB_PATH:?}"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Release hosts require Node 22")'
bash "$(dirname -- "$0")/check-disk-floor.sh" "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
