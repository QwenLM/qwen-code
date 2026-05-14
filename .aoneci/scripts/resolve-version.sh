#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# resolve-version.sh
#
# 解析最终构建版本号：
#   - 手动指定了 MANUAL_VERSION 则直接使用
#   - 否则从 package.json 读取基础版本，生成
#     {base_version}-preview.{timestamp} 格式
#
# 输出写入 $WORKSPACE_DIR/.resolved_version 供后续步骤读取
#
# 环境变量:
#   MANUAL_VERSION  - 手动指定的版本号（可为空）
#   WORKSPACE_DIR   - 输出目录，默认 /workspace
#   SOURCE_DIR      - 源码根目录（读取 package.json）
# ──────────────────────────────────────────────────────────
set -eux

MANUAL_VERSION="${MANUAL_VERSION:-}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"

mkdir -p "${WORKSPACE_DIR}"

if [ -n "${MANUAL_VERSION}" ]; then
  RESOLVED="${MANUAL_VERSION}"
else
  BASE_VERSION=$(node -e "process.stdout.write(require('${SOURCE_DIR}/package.json').version)")
  TIMESTAMP=$(TZ=CST-8 date +%Y%m%d%H%M%S)
  RESOLVED="${BASE_VERSION}-preview.${TIMESTAMP}"
fi

BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "${RESOLVED}" > "${WORKSPACE_DIR}/.resolved_version"
echo "${BUILD_TIME}" > "${WORKSPACE_DIR}/.build_time"
echo "=== RESOLVED VERSION: ${RESOLVED} ==="
echo "=== BUILD TIME: ${BUILD_TIME} ==="
