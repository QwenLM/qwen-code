#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# upload-oss.sh
#
# 上传 qwen-code standalone 构建产物到阿里云 OSS。
#
# 最终链接格式:
#   https://<bucket>.oss-cn-shanghai.aliyuncs.com/public-datasets/aone-release/<group>/<project>/<version>/<file>
#
# 同时上传 deploy-qwen.sh / upgrade-qwen.sh 到:
#   - 版本目录: .../<version>/deploy-qwen.sh
#   - 固定路径: .../<project>/deploy-qwen.sh （始终指向最新）
#
# 环境变量:
#   ARTIFACT_DIR            - 产物根目录
#   ARCH                    - 目标架构
#   SOURCE_DIR              - 源码根目录（定位脚本）
#   WORKSPACE_DIR           - CI 工作目录，默认 /workspace
#   OSS_GROUP               - OSS 路径中的 group
#   OSS_PROJECT             - OSS 路径中的 project
#   OSS_ENDPOINT            - OSS endpoint URL
#   OSS_BUCKET              - OSS bucket 名
#   OSS_ACCESS_KEY_ID       - AK ID
#   OSS_ACCESS_KEY_SECRET   - AK Secret
#   SKIP_METADATA           - 非空时跳过 metadata 上传和 latest 更新
#   SKIP_LATEST_POINTER     - 非空时只跳过 latest metadata 指针更新
#   SKIP_ROOT_SCRIPTS       - 非空时不覆盖项目根目录下的 deploy/upgrade 脚本
#   OSS_RELEASE_CHANNELS    - 可选，逗号/空格分隔的 metadata 指针，如 beta,dataworks
# ──────────────────────────────────────────────────────────
set -eu

ARTIFACT_DIR="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
ARCH="${ARCH:?ARCH is required}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
OSS_GROUP="${OSS_GROUP:?OSS_GROUP is required}"
OSS_PROJECT="${OSS_PROJECT:?OSS_PROJECT is required}"
OSS_ENDPOINT="${OSS_ENDPOINT:-https://oss-cn-shanghai.aliyuncs.com}"
OSS_BUCKET="${OSS_BUCKET:-dataworks-notebook-cn-shanghai}"
OSS_ACCESS_KEY_ID="${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
OSS_ACCESS_KEY_SECRET="${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"
SKIP_METADATA="${SKIP_METADATA:-}"
SKIP_LATEST_POINTER="${SKIP_LATEST_POINTER:-}"
SKIP_ROOT_SCRIPTS="${SKIP_ROOT_SCRIPTS:-}"
OSS_RELEASE_CHANNELS="${OSS_RELEASE_CHANNELS:-}"

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

# ── 定位部署脚本 ──
find_script() {
  local name="$1"
  for candidate in \
    "${SOURCE_DIR:+${SOURCE_DIR}/.aoneci/scripts/${name}}" \
    "${AONE_CI_SOURCE:+${AONE_CI_SOURCE}/.aoneci/scripts/${name}}" \
    "$(dirname "$0")/${name}"; do
    if [ -n "${candidate}" ] && [ -f "${candidate}" ]; then
      echo "${candidate}"
      return
    fi
  done
}

DEPLOY_SCRIPT=$(find_script "deploy-qwen.sh")
UPGRADE_SCRIPT=$(find_script "upgrade-qwen.sh")

# ── 安装 ossutil ──
if ! command -v ossutil64 &>/dev/null && ! command -v ossutil &>/dev/null; then
  curl -fsSL "https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil-v1.7.18-linux-amd64.zip" -o /tmp/ossutil.zip
  unzip -o /tmp/ossutil.zip -d /tmp/ossutil
  chmod +x /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64
  cp /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64 /usr/local/bin/ossutil64
fi
OSSUTIL=$(command -v ossutil64 || command -v ossutil)

# ── 配置 ossutil ──
${OSSUTIL} config \
  -e "${OSS_ENDPOINT}" \
  -i "${OSS_ACCESS_KEY_ID}" \
  -k "${OSS_ACCESS_KEY_SECRET}"

# ── 上传构建产物 ──
${OSSUTIL} cp -f "${ARTIFACT_DIR}/${TARBALL}"  "oss://${OSS_BUCKET}/${OSS_PREFIX}/${TARBALL}"
${OSSUTIL} cp -f "${ARTIFACT_DIR}/SHA256SUMS"  "oss://${OSS_BUCKET}/${OSS_PREFIX}/SHA256SUMS"

# 兼容旧格式：下游依赖 qwen-code-{version}-linux-{arch}.tar.gz
if [ -f "${ARTIFACT_DIR}/${TARBALL_OLD}" ] && [ "${TARBALL}" != "${TARBALL_OLD}" ]; then
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/${TARBALL_OLD}" "oss://${OSS_BUCKET}/${OSS_PREFIX}/${TARBALL_OLD}"
  echo ">>> Compat tarball uploaded: ${TARBALL_OLD}"
fi

if [ -z "${SKIP_METADATA}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/metadata.json" "oss://${OSS_BUCKET}/${OSS_PREFIX}/metadata.json"
else
  echo ">>> Skipping metadata.json upload"
fi

# ── 上传部署脚本 ──
if [ -n "${DEPLOY_SCRIPT}" ]; then
  ${OSSUTIL} cp -f "${DEPLOY_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PREFIX}/deploy-qwen.sh"
  if [ -z "${SKIP_ROOT_SCRIPTS}" ]; then
    ${OSSUTIL} cp -f "${DEPLOY_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/deploy-qwen.sh"
    echo ">>> deploy-qwen.sh uploaded to version dir and project root"
  else
    echo ">>> SKIP_ROOT_SCRIPTS set, deploy-qwen.sh only in version dir"
  fi
else
  echo ">>> WARNING: deploy-qwen.sh not found, skipping"
fi

if [ -n "${UPGRADE_SCRIPT}" ]; then
  if [ -z "${SKIP_ROOT_SCRIPTS}" ]; then
    ${OSSUTIL} cp -f "${UPGRADE_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/upgrade-qwen.sh"
    echo ">>> upgrade-qwen.sh uploaded"
  else
    echo ">>> SKIP_ROOT_SCRIPTS set, skipping upgrade-qwen.sh"
  fi
fi

# ── 更新 latest 指向 ──
if [ -z "${SKIP_METADATA}" ] && [ -z "${SKIP_LATEST_POINTER}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
  ${OSSUTIL} cp -f "${ARTIFACT_DIR}/metadata.json" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/latest/metadata.json"
  echo ">>> latest pointer updated"
else
  echo ">>> Skipping latest pointer update"
fi

# ── 更新 channel 指向 ──
if [ -z "${SKIP_METADATA}" ] && [ -n "${OSS_RELEASE_CHANNELS}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
  CHANNELS=$(printf '%s' "${OSS_RELEASE_CHANNELS}" | tr ',[:space:]' '\n' | sed '/^$/d')
  for CHANNEL in ${CHANNELS}; do
    case "${CHANNEL}" in
      *[!A-Za-z0-9._-]*|.|..|"")
        echo "Invalid OSS release channel: ${CHANNEL}" >&2
        exit 1
        ;;
    esac
    ${OSSUTIL} cp -f "${ARTIFACT_DIR}/metadata.json" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/${CHANNEL}/metadata.json"
    echo ">>> ${CHANNEL} pointer updated"
  done
else
  echo ">>> Skipping channel pointer update"
fi

# ── 打印下载链接 ──
OSS_HOST="${OSS_BUCKET}.oss-cn-shanghai.aliyuncs.com"
OSS_BASE="https://${OSS_HOST}/${OSS_PREFIX}"
OSS_ROOT="https://${OSS_HOST}/${OSS_PROJECT_ROOT}"

echo ""
echo "============================================"
echo "  Qwen Code Standalone — Upload Complete"
echo "  Version: ${VERSION}"
echo "  Arch:    ${ARCH}"
echo "============================================"
echo ""
echo "Download links:"
echo "  Binary:   ${OSS_BASE}/${TARBALL}"
echo "  SHA256:   ${OSS_BASE}/SHA256SUMS"
echo "  Metadata: ${OSS_BASE}/metadata.json"
echo ""
echo "One-click deploy:"
echo "  curl -fsSL ${OSS_ROOT}/deploy-qwen.sh | bash -s -- --version ${VERSION}"
echo ""
echo "Quick install (manual):"
echo "  curl -fsSL ${OSS_BASE}/${TARBALL} -o qwen-code.tar.gz"
echo "  tar -xzf qwen-code.tar.gz && ./qwen-code/bin/qwen"
echo "============================================"
