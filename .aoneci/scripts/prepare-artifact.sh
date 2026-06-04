#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# prepare-artifact.sh
#
# 整理构建产物到最终上传目录：
#   - 查找 tarball（支持新旧命名格式）
#   - 从 standalone 目录拷贝 metadata.json
#   - 生成 SHA256SUMS 校验文件
#
# 环境变量:
#   ARTIFACT_DIR    - 产物输出根目录
#   ARCH            - 目标架构 (amd64 | arm64)，可选
#   WORKSPACE_DIR   - CI 工作目录，默认 /workspace
#   SOURCE_DIR      - 源码根目录
#   SKIP_METADATA   - 非空时跳过 metadata.json
# ──────────────────────────────────────────────────────────
set -eu

ARTIFACT_DIR="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
ARCH="${ARCH:-amd64}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"
SKIP_METADATA="${SKIP_METADATA:-}"

VERSION=$(cat "${WORKSPACE_DIR}/.resolved_version" 2>/dev/null || \
  node -e "const v=require('${SOURCE_DIR}/package.json').version; if(!v) process.exit(1); console.log(v)" 2>/dev/null || \
  echo "")

if [ -z "${VERSION}" ]; then
  echo "ERROR: cannot determine version" >&2
  exit 1
fi

BUILD_DIR="${WORKSPACE_DIR}/build"
STANDALONE_DIR="${BUILD_DIR}/qwen-code"

# 支持新旧两种 tarball 命名格式
TARBALL_NEW="qwen-code-standalone-${VERSION}.tar.gz"
TARBALL_OLD="qwen-code-${VERSION}-linux-${ARCH}.tar.gz"

echo "=== VERSION: ${VERSION} ==="

rm -rf "${ARTIFACT_DIR}"
mkdir -p "${ARTIFACT_DIR}"

# 查找并拷贝 tarball（新格式 + 兼容旧格式）
TARBALL_NAME=""
for candidate in "${BUILD_DIR}/${TARBALL_NEW}" "${ARTIFACT_DIR}/../${TARBALL_NEW}" \
                 "${BUILD_DIR}/${TARBALL_OLD}" "${ARTIFACT_DIR}/../${TARBALL_OLD}"; do
  if [ -f "${candidate}" ]; then
    TARBALL_NAME="$(basename "${candidate}")"
    cp "${candidate}" "${ARTIFACT_DIR}/${TARBALL_NAME}"
    break
  fi
done

if [ -z "${TARBALL_NAME}" ]; then
  echo "ERROR: no tarball found (tried ${TARBALL_NEW} and ${TARBALL_OLD})" >&2
  exit 1
fi

# 拷贝兼容格式（如果存在且和主 tarball 不同名）
for candidate in "${BUILD_DIR}/${TARBALL_OLD}" "${ARTIFACT_DIR}/../${TARBALL_OLD}"; do
  if [ -f "${candidate}" ] && [ "${TARBALL_NAME}" != "${TARBALL_OLD}" ]; then
    cp "${candidate}" "${ARTIFACT_DIR}/${TARBALL_OLD}"
    echo ">>> Compat tarball copied: ${TARBALL_OLD}"
    break
  fi
done

# 生成 SHA256（包含所有 tarball）
(cd "${ARTIFACT_DIR}" && sha256sum *.tar.gz > SHA256SUMS)

# metadata.json
METADATA_FILE=""
for candidate in "${STANDALONE_DIR}/metadata.json" "${STANDALONE_DIR}/META.json"; do
  if [ -f "${candidate}" ]; then
    METADATA_FILE="${candidate}"
    break
  fi
done

if [ -z "${SKIP_METADATA}" ] && [ -n "${METADATA_FILE}" ]; then
  cp "${METADATA_FILE}" "${ARTIFACT_DIR}/metadata.json"
else
  echo ">>> Skipping metadata.json"
fi

echo "=== artifact contents ==="
ls -lh "${ARTIFACT_DIR}"
if [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
  echo "=== metadata ==="
  cat "${ARTIFACT_DIR}/metadata.json"
fi
echo "=== SHA256SUMS ==="
cat "${ARTIFACT_DIR}/SHA256SUMS"
