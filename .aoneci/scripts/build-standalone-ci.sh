#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# build-standalone-ci.sh
#
# CI 环境下构建 qwen-code standalone 包。
# 基于 scripts/build-standalone.sh 的逻辑，适配 CI 流水线：
#   - 从 .resolved_version 读取版本号
#   - 支持 ARCH 参数（amd64/arm64）
#   - 产出放到 ARTIFACT_DIR
#
# 产出结构:
#   $ARTIFACT_DIR/qwen-code-standalone/
#     ├── bin/qwen            <- launcher
#     ├── node/               <- 嵌入 Node.js 运行时
#     ├── dist/               <- esbuild bundle + vendor assets
#     ├── native_modules/     <- 平台专属 .node 二进制
#     └── metadata.json       <- 版本信息
#
# 环境变量:
#   ARCH          - 目标架构 (amd64 | arm64)，默认 amd64
#   WORKSPACE_DIR - CI 工作目录，默认 /workspace
#   SOURCE_DIR    - 源码根目录
# ──────────────────────────────────────────────────────────
set -euo pipefail

ARCH="${ARCH:-amd64}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SOURCE_DIR="${SOURCE_DIR:-${AONE_CI_SOURCE:-.}}"

case "${ARCH}" in
  amd64) TARGET_PLATFORM="linux"; TARGET_ARCH="x64" ;;
  arm64) TARGET_PLATFORM="linux"; TARGET_ARCH="arm64" ;;
  *)
    echo "unsupported arch: ${ARCH}" >&2
    exit 1
    ;;
esac

VERSION=$(cat "${WORKSPACE_DIR}/.resolved_version")
BUILD_TIME=$(cat "${WORKSPACE_DIR}/.build_time" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)

NODE_VERSION="22.14.0"
NODE_DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.xz"

NODE_PTY_VERSION="1.2.0-beta.10"
CLIPBOARD_VERSION="0.0.5"
NPM_REGISTRY="https://registry.npmjs.org"

BUILD_DIR="${WORKSPACE_DIR}/build"
STANDALONE_DIR="${BUILD_DIR}/qwen-code-standalone"
CACHE_DIR="${BUILD_DIR}/cache"

echo "============================================"
echo "  Qwen Code Standalone CI Builder"
echo "  Version: ${VERSION}"
echo "  Target:  ${TARGET_PLATFORM}-${TARGET_ARCH}"
echo "  Node.js: v${NODE_VERSION}"
echo "============================================"
echo ""

# ── 清理 ──
rm -rf "${STANDALONE_DIR}"
mkdir -p "${STANDALONE_DIR}" "${CACHE_DIR}"

# ── Bundle ──
echo "[1/7] 构建 esbuild bundle..."
cd "${SOURCE_DIR}"

if [ -f "${SOURCE_DIR}/dist/cli.js" ]; then
  echo "  -> 发现已有 dist/cli.js，跳过 bundle"
else
  npm run build
  npm run bundle
fi

echo "  -> 拷贝 dist/ 到 standalone 目录..."
cp -r "${SOURCE_DIR}/dist" "${STANDALONE_DIR}/dist"

# ── 注入版本号 ──
echo "[2/7] 注入版本号 ${VERSION}..."
if [ -f "${STANDALONE_DIR}/dist/cli.js" ]; then
  node -e "
    const fs = require('fs');
    const p = '${STANDALONE_DIR}/dist/cli.js';
    let c = fs.readFileSync(p, 'utf8');
    // Replace the version marker if present, otherwise prepend
    if (c.includes('__QWEN_VERSION__')) {
      c = c.replace(/__QWEN_VERSION__/g, '${VERSION}');
    }
    fs.writeFileSync(p, c);
  " || echo "  -> 版本注入跳过（无 __QWEN_VERSION__ 占位符）"
fi

# ── Node.js ──
echo "[3/7] 下载 Node.js v${NODE_VERSION} (${TARGET_PLATFORM}-${TARGET_ARCH})..."
NODE_TARBALL="${CACHE_DIR}/node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.xz"

if [ -f "${NODE_TARBALL}" ]; then
  echo "  -> 使用缓存: ${NODE_TARBALL}"
else
  curl -# -L -o "${NODE_TARBALL}" "${NODE_DIST_URL}"
fi

mkdir -p "${STANDALONE_DIR}/node"
tar -xJf "${NODE_TARBALL}" \
  --strip-components=1 \
  -C "${STANDALONE_DIR}/node" \
  "node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}/bin/node" \
  "node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}/LICENSE"

echo "  -> Node.js 二进制大小: $(du -sh "${STANDALONE_DIR}/node/bin/node" | awk '{print $1}')"

# ── Native Modules ──
echo "[4/7] 下载平台专属 native 模块..."
NATIVE_DIR="${STANDALONE_DIR}/native_modules"
mkdir -p "${NATIVE_DIR}"

# node-pty
echo "  -> 下载 @lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}@${NODE_PTY_VERSION}..."
PTY_PKG_NAME="@lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}"
PTY_TARBALL_URL="${NPM_REGISTRY}/${PTY_PKG_NAME}/-/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}-${NODE_PTY_VERSION}.tgz"

PTY_TMP="${CACHE_DIR}/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}-${NODE_PTY_VERSION}"
if [ ! -d "${PTY_TMP}" ]; then
  mkdir -p "${PTY_TMP}"
  curl -# -L "${PTY_TARBALL_URL}" | tar -xz -C "${PTY_TMP}"
fi

PTY_DEST="${NATIVE_DIR}/node_modules/@lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}"
mkdir -p "${PTY_DEST}"
cp -r "${PTY_TMP}/package/"* "${PTY_DEST}/"

PTY_WRAPPER_DEST="${NATIVE_DIR}/node_modules/@lydell/node-pty"
mkdir -p "${PTY_WRAPPER_DEST}"
cp -r "${SOURCE_DIR}/node_modules/@lydell/node-pty/"* "${PTY_WRAPPER_DEST}/"

# clipboard
echo "  -> 下载 @teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu@${CLIPBOARD_VERSION}..."
CLIP_PKG_NAME="@teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu"
CLIP_TARBALL_URL="${NPM_REGISTRY}/${CLIP_PKG_NAME}/-/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu-${CLIPBOARD_VERSION}.tgz"

CLIP_TMP="${CACHE_DIR}/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu-${CLIPBOARD_VERSION}"
if [ ! -d "${CLIP_TMP}" ]; then
  mkdir -p "${CLIP_TMP}"
  curl -# -L "${CLIP_TARBALL_URL}" | tar -xz -C "${CLIP_TMP}"
fi

CLIP_DEST="${NATIVE_DIR}/node_modules/@teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu"
mkdir -p "${CLIP_DEST}"
cp -r "${CLIP_TMP}/package/"* "${CLIP_DEST}/"

CLIP_WRAPPER_SRC="${SOURCE_DIR}/node_modules/@teddyzhu/clipboard"
if [ -d "${CLIP_WRAPPER_SRC}" ]; then
  CLIP_WRAPPER_DEST="${NATIVE_DIR}/node_modules/@teddyzhu/clipboard"
  mkdir -p "${CLIP_WRAPPER_DEST}"
  cp -r "${CLIP_WRAPPER_SRC}/"* "${CLIP_WRAPPER_DEST}/"
fi

# ── Launcher ──
echo "[5/7] 生成 launcher 脚本..."
mkdir -p "${STANDALONE_DIR}/bin"

cat > "${STANDALONE_DIR}/bin/qwen" << 'LAUNCHER_EOF'
#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
QWEN_HOME="$( cd -P "$( dirname "$SOURCE" )/.." && pwd )"

NODE_BIN="${QWEN_HOME}/node/bin/node"

if [ ! -x "${NODE_BIN}" ]; then
  echo "ERROR: Node.js binary not found at ${NODE_BIN}" >&2
  echo "Please ensure the qwen-code-standalone directory is intact." >&2
  exit 1
fi

export NODE_PATH="${QWEN_HOME}/native_modules/node_modules:${NODE_PATH:-}"

exec "${NODE_BIN}" "${QWEN_HOME}/dist/cli.js" "$@"
LAUNCHER_EOF

chmod +x "${STANDALONE_DIR}/bin/qwen"

# ── Metadata ──
echo "[6/7] 生成 metadata.json..."
SHORT_SHA=$(cd "${SOURCE_DIR}" && git rev-parse --short HEAD)
FULL_SHA=$(cd "${SOURCE_DIR}" && git rev-parse HEAD)

node -e "
  const meta = {
    version: '${VERSION}',
    git_sha: '${FULL_SHA}',
    git_short_sha: '${SHORT_SHA}',
    arch: '${ARCH}',
    platform: '${TARGET_PLATFORM}',
    node_version: '${NODE_VERSION}',
    build_time: '${BUILD_TIME}',
  };
  require('fs').writeFileSync('${STANDALONE_DIR}/metadata.json', JSON.stringify(meta, null, 2));
"

# ── 打包 ──
echo "[7/7] 打包成 tar.gz..."
TARBALL_NAME="qwen-code-${VERSION}-${TARGET_PLATFORM}-${ARCH}.tar.gz"
cd "${BUILD_DIR}"
tar -czf "${TARBALL_NAME}" qwen-code-standalone/

FINAL_SIZE=$(du -sh "${BUILD_DIR}/${TARBALL_NAME}" | awk '{print $1}')
DIR_SIZE=$(du -sh "${STANDALONE_DIR}" | awk '{print $1}')

# 生成 SHA256
sha256sum "${BUILD_DIR}/${TARBALL_NAME}" > "${BUILD_DIR}/SHA256SUMS"

echo ""
echo "============================================"
echo "  构建完成!"
echo "  版本: ${VERSION}"
echo "  目录大小: ${DIR_SIZE}"
echo "  压缩包: ${TARBALL_NAME} (${FINAL_SIZE})"
echo "  SHA256: $(awk '{print $1}' "${BUILD_DIR}/SHA256SUMS")"
echo "============================================"
