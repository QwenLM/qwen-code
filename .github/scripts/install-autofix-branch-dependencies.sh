#!/usr/bin/env bash
set -euo pipefail

# Staged from the trusted base and invoked with env -i by the workflow.
: "${WORKSPACE:?}" "${WORKDIR:?}" "${RUNNER_TEMP:?}" "${PNPM_STORE_DIR:?}"
: "${COREPACK_HOME_SOURCE:?}"
: "${QWEN_SANDBOX_IMAGE:?}" "${CHECKED_OUT_HEAD:?}" "${INSTALL_CONTAINER_NAME:?}"
exec 3>&1
exec > "${WORKDIR}/branch-dependencies.log" 2>&1

scratch=''
docker_bin=''
docker_args=()
remove_container() {
  local remaining
  remaining="$("${docker_bin}" "${docker_args[@]}" container ls -aq \
    --filter "name=^/${INSTALL_CONTAINER_NAME}$")" || return 1
  if [[ -n "${remaining}" ]]; then
    "${docker_bin}" "${docker_args[@]}" rm -f "${INSTALL_CONTAINER_NAME}" > /dev/null
  fi
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "${scratch}" ]]; then
    if remove_container; then
      rm -rf "${scratch}" || rc=1
    else
      echo 'could not stop dependency installer; refusing to continue'
      rc=1
    fi
  fi
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/branch-dependencies.log" >&3
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker_bin="$(command -v docker)"

# These overlays must cover real directories, never a branch-selected target.
for directory in "${WORKSPACE}" "${WORKSPACE}/.git" "${WORKSPACE}/dist" "${PNPM_STORE_DIR}" "${COREPACK_HOME_SOURCE}"; do
  if [[ "${directory}" != /* || ! -d "${directory}" || -L "${directory}" || "${directory}" == *,* ]]; then
    echo "invalid dependency installation directory: ${directory}"
    exit 1
  fi
done
scratch="$(mktemp -d "${RUNNER_TEMP}/autofix-install.XXXXXX")"
docker_args=(--config "${scratch}/docker-config" --context default)
mkdir -p "${scratch}/docker-config" "${scratch}/home" "${scratch}/store" "${scratch}/corepack"
# The trusted base installs with clone-or-copy, so inherited modules do not
# alias its store. Copy/reflink the cache, never hardlink back to that source.
cp --reflink=auto -a "${PNPM_STORE_DIR}/." "${scratch}/store/"
cp --reflink=auto -a "${COREPACK_HOME_SOURCE}/." "${scratch}/corepack/"

for attempt in 1 2 3; do
  attempt_rc=0
  "${docker_bin}" "${docker_args[@]}" run \
    --name "${INSTALL_CONTAINER_NAME}" \
    --init --rm -i --read-only \
    --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,nodev \
    --workdir "${WORKSPACE}" \
    --mount "type=bind,src=${WORKSPACE},dst=${WORKSPACE}" \
    --mount "type=bind,src=${WORKSPACE}/.git,dst=${WORKSPACE}/.git,readonly" \
    --mount "type=bind,src=${WORKSPACE}/dist,dst=${WORKSPACE}/dist,readonly" \
    --mount "type=bind,src=${scratch}/home,dst=/tmp/autofix-install-home" \
    --mount "type=bind,src=${scratch}/corepack,dst=/tmp/autofix-install-corepack" \
    --mount "type=bind,src=${scratch}/store,dst=${PNPM_STORE_DIR}" \
    --entrypoint /usr/bin/env "${QWEN_SANDBOX_IMAGE}" \
    -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/autofix-install-home \
    COREPACK_HOME=/tmp/autofix-install-corepack \
    CI=true QWEN_SKIP_PREPARE=1 \
    npm_config_cache=/tmp/autofix-install-home/npm-cache \
    corepack pnpm install --frozen-lockfile --prefer-offline \
    --reporter=append-only --package-import-method=clone-or-copy \
    --store-dir "${PNPM_STORE_DIR}" &
  wait "$!" || attempt_rc=$?

  # A failed Docker client can leave a writer alive. Stop it before host Git,
  # retries, or any later privileged workflow step consumes this workspace.
  remove_container
  actual_head="$(git -C "${WORKSPACE}" rev-parse HEAD)"
  dirty="$(git -C "${WORKSPACE}" status --porcelain)"
  if [[ "${actual_head}" != "${CHECKED_OUT_HEAD}" || -n "${dirty}" ]]; then
    printf '%s\n' "${dirty}"
    echo 'dependency installation changed HEAD or left the branch tree dirty'
    exit 1
  fi
  if [[ "${attempt_rc}" -eq 0 ]]; then
    exit 0
  fi
  if [[ "${attempt}" == 3 ]]; then
    exit "${attempt_rc}"
  fi
  sleep "$((attempt * 15))"
done
