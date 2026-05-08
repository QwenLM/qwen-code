#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# prepare-artifact.sh
#
# 整理构建产物到最终上传目录：
#   - 从 build/ 拷贝 tarball 和 SHA256
#   - 从 standalone 目录拷贝 metadata.json
#   - 生成最终的 SHA256SUMS 校验文件
#
# 环境变量:
#   ARTIFACT_DIR    - 产物输出根目录
#   ARCH            - 目标架构 (amd64 | arm64)
#   WORKSPACE_DIR   - CI 工作目录，默认 /workspace
#   SOURCE_DIR      - 源码根目录
#   SKIP_METADATA   - 非空时跳过 metadata.json 生成
# ──────────────────────────────────────────────────────────
set -eu

ARTIFACT_DIR="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
ARCH="${ARCH:?ARCH is required}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"
SKIP_METADATA="${SKIP_METADATA:-}"

case "${ARCH}" in
  amd64) TARGET_PLATFORM="linux" ;;
  arm64) TARGET_PLATFORM="linux" ;;
  *) echo "unsupported arch: ${ARCH}" >&2; exit 1 ;;
esac

VERSION=$(cat "${WORKSPACE_DIR}/.resolved_version")
BUILD_DIR="${WORKSPACE_DIR}/build"
STANDALONE_DIR="${BUILD_DIR}/qwen-code"
TARBALL_NAME="qwen-code-${VERSION}-${TARGET_PLATFORM}-${ARCH}.tar.gz"

echo "=== VERSION: ${VERSION} ==="

rm -rf "${ARTIFACT_DIR}"
mkdir -p "${ARTIFACT_DIR}"

# 拷贝 tarball
cp "${BUILD_DIR}/${TARBALL_NAME}" "${ARTIFACT_DIR}/${TARBALL_NAME}"

# 生成 SHA256
(cd "${ARTIFACT_DIR}" && sha256sum "${TARBALL_NAME}" > SHA256SUMS)

# metadata.json
if [ -z "${SKIP_METADATA}" ] && [ -f "${STANDALONE_DIR}/metadata.json" ]; then
  cp "${STANDALONE_DIR}/metadata.json" "${ARTIFACT_DIR}/metadata.json"
else
  echo ">>> Skipping metadata.json"
fi

echo "=== artifact contents ==="
ls -lh "${ARTIFACT_DIR}"
if [ -z "${SKIP_METADATA}" ] && [ -f "${ARTIFACT_DIR}/metadata.json" ]; then
  echo "=== metadata ==="
  cat "${ARTIFACT_DIR}/metadata.json"
fi
echo "=== SHA256SUMS ==="
cat "${ARTIFACT_DIR}/SHA256SUMS"
