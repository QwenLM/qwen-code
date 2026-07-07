#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# upload-oss.sh
#
# 上传 qwen-code standalone 构建产物到 OSS。默认使用 AoneCI zero-trust
# BOOTSTRAP_TOKEN 换取目标云临时 STS 凭证，并同时写入公网与上海金融云。
#
# 最终链接格式:
#   https://<bucket>.<endpoint>/public-datasets/aone-release/<group>/<project>/<version>/<file>
#
# 环境变量:
#   ARTIFACT_DIR            - 产物根目录
#   ARCH                    - 目标架构
#   SOURCE_DIR              - 源码根目录（定位脚本）
#   WORKSPACE_DIR           - CI 工作目录，默认 /workspace
#   OSS_GROUP               - OSS 路径中的 group
#   OSS_PROJECT             - OSS 路径中的 project
#   BOOTSTRAP_TOKEN         - AoneCI 项目级 zero-trust bootstrap token
#   OSS_UPLOAD_TARGETS      - 上传目标，默认 "public finance"
#   OSS_CREDENTIAL_MODE     - 默认 zerotrust；显式 aksk 时使用旧 AK/SK 回退
#   SKIP_METADATA           - 非空时跳过 metadata 上传和指针更新
#   SKIP_LATEST_POINTER     - 非空时只跳过 latest metadata 指针更新
#   SKIP_ROOT_SCRIPTS       - 非空时不覆盖项目根目录下的 deploy/upgrade 脚本
#   OSS_RELEASE_CHANNELS    - 可选，逗号/空格分隔的 metadata 指针，如 beta,dataworks
# ──────────────────────────────────────────────────────────
set -eu

ARTIFACT_DIR="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
ARCH="${ARCH:?ARCH is required}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSS_GROUP="${OSS_GROUP:?OSS_GROUP is required}"
OSS_PROJECT="${OSS_PROJECT:?OSS_PROJECT is required}"
OSS_ACCESS_KEY_ID="${OSS_ACCESS_KEY_ID:-}"
OSS_ACCESS_KEY_SECRET="${OSS_ACCESS_KEY_SECRET:-}"
OSS_UPLOAD_TARGETS="${OSS_UPLOAD_TARGETS:-public finance}"
SKIP_METADATA="${SKIP_METADATA:-}"
SKIP_LATEST_POINTER="${SKIP_LATEST_POINTER:-}"
SKIP_ROOT_SCRIPTS="${SKIP_ROOT_SCRIPTS:-}"
OSS_RELEASE_CHANNELS="${OSS_RELEASE_CHANNELS:-}"

# shellcheck disable=SC1091
. "${SCRIPT_DIR}/oss-targets.sh"

case "${ARCH}" in
  amd64) TARGET_PLATFORM="linux" ;;
  arm64) TARGET_PLATFORM="linux" ;;
  *) echo "unsupported arch: ${ARCH}" >&2; exit 1 ;;
esac

VERSION=$(cat "${WORKSPACE_DIR}/.resolved_version")
OSS_PREFIX="public-datasets/aone-release/${OSS_GROUP}/${OSS_PROJECT}/${VERSION}"
OSS_PROJECT_ROOT="public-datasets/aone-release/${OSS_GROUP}/${OSS_PROJECT}"

# 支持新旧 tarball 命名（新格式不含 arch）
TARBALL_NEW="qwen-code-standalone-${VERSION}.tar.gz"
TARBALL_OLD="qwen-code-${VERSION}-${TARGET_PLATFORM}-${ARCH}.tar.gz"
if [ -f "${ARTIFACT_DIR}/${TARBALL_NEW}" ]; then
  TARBALL="${TARBALL_NEW}"
elif [ -f "${ARTIFACT_DIR}/${TARBALL_OLD}" ]; then
  TARBALL="${TARBALL_OLD}"
else
  echo "ERROR: tarball not found (tried ${TARBALL_NEW} and ${TARBALL_OLD})" >&2
  exit 1
fi

find_script() {
  local name="$1"
  for candidate in \
    "${SOURCE_DIR:+${SOURCE_DIR}/.aoneci/scripts/${name}}" \
    "${AONE_CI_SOURCE:+${AONE_CI_SOURCE}/.aoneci/scripts/${name}}" \
    "${SCRIPT_DIR}/${name}"; do
    if [ -n "${candidate}" ] && [ -f "${candidate}" ]; then
      echo "${candidate}"
      return
    fi
  done
}

DEPLOY_SCRIPT="$(find_script "deploy-qwen.sh" || true)"
UPGRADE_SCRIPT="$(find_script "upgrade-qwen.sh" || true)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

target_script_copy() {
  local source_file="$1"
  local name="$2"
  local base_url="$3"
  local output_file="${TMP_DIR}/${OSS_TARGET}-${name}"
  local escaped_base="${base_url//&/\\&}"
  sed "s#__QWEN_OSS_BASE_URL__#${escaped_base}#g" "${source_file}" > "${output_file}"
  printf '%s' "${output_file}"
}

upload_metadata_pointer() {
  local channel="$1"
  case "${channel}" in
    *[!A-Za-z0-9._-]*|.|..|"")
      echo "Invalid OSS release channel: ${channel}" >&2
      exit 1
      ;;
  esac
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/metadata.json" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/${channel}/metadata.json"
  echo ">>> [${OSS_TARGET}] ${channel} pointer updated"
}

TARGETS="$(oss_upload_targets)"
TARGET_SUMMARY="$(oss_targets_one_line)"
PRIMARY_OSS_BASE=""
PRIMARY_OSS_ROOT=""

while IFS= read -r target; do
  [ -n "${target}" ] || continue
  oss_configure_target "${target}"
  OSS_BASE="$(oss_current_http_url "${OSS_PREFIX}")"
  OSS_ROOT="$(oss_current_http_url "${OSS_PROJECT_ROOT}")"
  [ -n "${PRIMARY_OSS_BASE}" ] || PRIMARY_OSS_BASE="${OSS_BASE}"
  [ -n "${PRIMARY_OSS_ROOT}" ] || PRIMARY_OSS_ROOT="${OSS_ROOT}"

  echo ">>> [${OSS_TARGET}] uploading build artifacts"
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/${TARBALL}" "oss://${OSS_BUCKET}/${OSS_PREFIX}/${TARBALL}"
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/SHA256SUMS" "oss://${OSS_BUCKET}/${OSS_PREFIX}/SHA256SUMS"

  # 兼容旧格式：下游依赖 qwen-code-{version}-linux-{arch}.tar.gz
  if [ -f "${ARTIFACT_DIR}/${TARBALL_OLD}" ] && [ "${TARBALL}" != "${TARBALL_OLD}" ]; then
    ${OSSUTIL} cp -f "${ARTIFACT_DIR}/${TARBALL_OLD}" "oss://${OSS_BUCKET}/${OSS_PREFIX}/${TARBALL_OLD}"
    echo ">>> [${OSS_TARGET}] compat tarball uploaded: ${TARBALL_OLD}"
  fi

  if [ -z "${SKIP_METADATA}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
    ${OSSUTIL} cp -f "${ARTIFACT_DIR}/metadata.json" "oss://${OSS_BUCKET}/${OSS_PREFIX}/metadata.json"
  else
    echo ">>> [${OSS_TARGET}] skipping metadata.json upload"
  fi

  if [ -n "${DEPLOY_SCRIPT}" ]; then
    TARGET_DEPLOY_SCRIPT="$(target_script_copy "${DEPLOY_SCRIPT}" "deploy-qwen.sh" "${OSS_ROOT}")"
    ${OSSUTIL} cp -f "${TARGET_DEPLOY_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PREFIX}/deploy-qwen.sh"
    if [ -z "${SKIP_ROOT_SCRIPTS}" ]; then
      ${OSSUTIL} cp -f "${TARGET_DEPLOY_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/deploy-qwen.sh"
      echo ">>> [${OSS_TARGET}] deploy-qwen.sh uploaded to version dir and project root"
    else
      echo ">>> [${OSS_TARGET}] SKIP_ROOT_SCRIPTS set, deploy-qwen.sh only in version dir"
    fi
  else
    echo ">>> [${OSS_TARGET}] WARNING: deploy-qwen.sh not found, skipping"
  fi

  if [ -n "${UPGRADE_SCRIPT}" ]; then
    TARGET_UPGRADE_SCRIPT="$(target_script_copy "${UPGRADE_SCRIPT}" "upgrade-qwen.sh" "${OSS_ROOT}")"
    if [ -z "${SKIP_ROOT_SCRIPTS}" ]; then
      ${OSSUTIL} cp -f "${TARGET_UPGRADE_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/upgrade-qwen.sh"
      echo ">>> [${OSS_TARGET}] upgrade-qwen.sh uploaded"
    else
      echo ">>> [${OSS_TARGET}] SKIP_ROOT_SCRIPTS set, skipping upgrade-qwen.sh"
    fi
  fi

  if [ -z "${SKIP_METADATA}" ] && [ -z "${SKIP_LATEST_POINTER}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
    upload_metadata_pointer "latest"
  else
    echo ">>> [${OSS_TARGET}] skipping latest pointer update"
  fi

  if [ -z "${SKIP_METADATA}" ] && [ -n "${OSS_RELEASE_CHANNELS}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
    CHANNELS=$(printf '%s' "${OSS_RELEASE_CHANNELS}" | tr ',[:space:]' '\n' | sed '/^$/d')
    for CHANNEL in ${CHANNELS}; do
      upload_metadata_pointer "${CHANNEL}"
    done
  else
    echo ">>> [${OSS_TARGET}] skipping channel pointer update"
  fi

  echo ">>> [${OSS_TARGET}] uploaded ${OSS_BASE}/${TARBALL}"
done <<EOF
${TARGETS}
EOF

OSS_BASE="${PRIMARY_OSS_BASE}"
OSS_ROOT="${PRIMARY_OSS_ROOT}"

echo ""
echo "============================================"
echo "  Qwen Code Standalone — Upload Complete"
echo "  Version: ${VERSION}"
echo "  Arch:    ${ARCH}"
echo "  Targets: ${TARGET_SUMMARY}"
echo "============================================"
echo ""
echo "Download links (first target):"
echo "  Binary:   ${OSS_BASE}/${TARBALL}"
echo "  SHA256:   ${OSS_BASE}/SHA256SUMS"
echo "  Metadata: ${OSS_BASE}/metadata.json"
echo ""
echo "One-click deploy (first target):"
echo "  curl -fsSL ${OSS_ROOT}/deploy-qwen.sh | bash -s -- --version ${VERSION}"
echo ""
echo "Quick install (manual):"
echo "  curl -fsSL ${OSS_BASE}/${TARBALL} -o qwen-code.tar.gz"
echo "  tar -xzf qwen-code.tar.gz && ./qwen-code/bin/qwen"
echo "============================================"
