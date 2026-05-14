#!/usr/bin/env bash
###############################################################################
# build-standalone.sh
#
# 将 qwen-code 打包成一个自包含的目录，可以在没有 Node.js / npm 的
# Linux x64 服务器上直接运行。
#
# 产出: build/qwen-code-standalone/
#   ├── bin/qwen          <- 入口 launcher（用户 PATH 指向这里即可）
#   ├── node/             <- 嵌入的 Node.js 运行时
#   ├── dist/             <- esbuild bundle + vendor assets
#   └── native_modules/   <- 平台专属 .node 二进制（node-pty, clipboard）
#
# 使用方式:
#   bash scripts/build-standalone.sh
#   # 然后把 build/qwen-code-standalone.tar.gz 传到远程机器解压即可
###############################################################################

set -euo pipefail

# ============================= 配置 ============================
# 目标平台
TARGET_PLATFORM="linux"
TARGET_ARCH="x64"

# Node.js 版本 - 使用 LTS
NODE_VERSION="22.14.0"
NODE_DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.xz"

# native 模块版本（和 package.json 中一致）
NODE_PTY_VERSION="1.2.0-beta.10"
CLIPBOARD_VERSION="0.0.5"

# ============================= 路径 ============================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build"
STANDALONE_DIR="${BUILD_DIR}/qwen-code-standalone"

echo "============================================"
echo "  Qwen Code Standalone Builder"
echo "  Target: ${TARGET_PLATFORM}-${TARGET_ARCH}"
echo "  Node.js: v${NODE_VERSION}"
echo "============================================"
echo ""

# ============================= 清理 ============================
echo "[1/6] 清理旧构建..."
rm -rf "${STANDALONE_DIR}"
mkdir -p "${STANDALONE_DIR}"

# ============================= Bundle ============================
echo "[2/6] 构建 esbuild bundle..."
cd "${PROJECT_ROOT}"

# 检查 dist/cli.js 是否已存在且足够新
if [ -f "${PROJECT_ROOT}/dist/cli.js" ]; then
  echo "  -> 发现已有 dist/cli.js，跳过 bundle（如需重新构建请先 rm -rf dist/）"
else
  npm run bundle
fi

# 拷贝 dist 目录
echo "  -> 拷贝 dist/ 到 standalone 目录..."
cp -r "${PROJECT_ROOT}/dist" "${STANDALONE_DIR}/dist"

# ============================= Node.js ============================
echo "[3/6] 下载 Node.js v${NODE_VERSION} (${TARGET_PLATFORM}-${TARGET_ARCH})..."
NODE_CACHE_DIR="${BUILD_DIR}/cache"
NODE_TARBALL="${NODE_CACHE_DIR}/node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.xz"
mkdir -p "${NODE_CACHE_DIR}"

if [ -f "${NODE_TARBALL}" ]; then
  echo "  -> 使用缓存: ${NODE_TARBALL}"
else
  echo "  -> 下载中..."
  curl -# -L -o "${NODE_TARBALL}" "${NODE_DIST_URL}"
fi

echo "  -> 解压 Node.js..."
mkdir -p "${STANDALONE_DIR}/node"
# 只提取 bin/node（运行时只需要这一个二进制）
tar -xJf "${NODE_TARBALL}" \
  --strip-components=1 \
  -C "${STANDALONE_DIR}/node" \
  "node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}/bin/node" \
  "node-v${NODE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}/LICENSE"

echo "  -> Node.js 二进制大小: $(du -sh "${STANDALONE_DIR}/node/bin/node" | awk '{print $1}')"

# ============================= Native Modules ============================
echo "[4/6] 下载平台专属 native 模块..."
NATIVE_DIR="${STANDALONE_DIR}/native_modules"
mkdir -p "${NATIVE_DIR}"

# --- node-pty ---
echo "  -> 下载 @lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}@${NODE_PTY_VERSION}..."
NPM_REGISTRY="https://registry.npmjs.org"
PTY_PKG_NAME="@lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}"
PTY_TARBALL_URL="${NPM_REGISTRY}/${PTY_PKG_NAME}/-/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}-${NODE_PTY_VERSION}.tgz"

PTY_TMP="${BUILD_DIR}/cache/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}-${NODE_PTY_VERSION}"
if [ ! -d "${PTY_TMP}" ]; then
  mkdir -p "${PTY_TMP}"
  curl -# -L "${PTY_TARBALL_URL}" | tar -xz -C "${PTY_TMP}"
fi

# 创建 node_modules 目录结构（和 require 路径一致）
PTY_DEST="${NATIVE_DIR}/node_modules/@lydell/node-pty-${TARGET_PLATFORM}-${TARGET_ARCH}"
mkdir -p "${PTY_DEST}"
cp -r "${PTY_TMP}/package/"* "${PTY_DEST}/"

# 同时放置 @lydell/node-pty（wrapper 包）
PTY_WRAPPER_DEST="${NATIVE_DIR}/node_modules/@lydell/node-pty"
mkdir -p "${PTY_WRAPPER_DEST}"
cp -r "${PROJECT_ROOT}/node_modules/@lydell/node-pty/"* "${PTY_WRAPPER_DEST}/"

# --- clipboard ---
echo "  -> 下载 @teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu@${CLIPBOARD_VERSION}..."
CLIP_PKG_NAME="@teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu"
CLIP_TARBALL_URL="${NPM_REGISTRY}/${CLIP_PKG_NAME}/-/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu-${CLIPBOARD_VERSION}.tgz"

CLIP_TMP="${BUILD_DIR}/cache/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu-${CLIPBOARD_VERSION}"
if [ ! -d "${CLIP_TMP}" ]; then
  mkdir -p "${CLIP_TMP}"
  curl -# -L "${CLIP_TARBALL_URL}" | tar -xz -C "${CLIP_TMP}"
fi

CLIP_DEST="${NATIVE_DIR}/node_modules/@teddyzhu/clipboard-${TARGET_PLATFORM}-${TARGET_ARCH}-gnu"
mkdir -p "${CLIP_DEST}"
cp -r "${CLIP_TMP}/package/"* "${CLIP_DEST}/"

# clipboard wrapper
CLIP_WRAPPER_SRC="${PROJECT_ROOT}/node_modules/@teddyzhu/clipboard"
if [ -d "${CLIP_WRAPPER_SRC}" ]; then
  CLIP_WRAPPER_DEST="${NATIVE_DIR}/node_modules/@teddyzhu/clipboard"
  mkdir -p "${CLIP_WRAPPER_DEST}"
  cp -r "${CLIP_WRAPPER_SRC}/"* "${CLIP_WRAPPER_DEST}/"
fi

# ============================= Launcher ============================
echo "[5/6] 生成 launcher 脚本..."
mkdir -p "${STANDALONE_DIR}/bin"

cat > "${STANDALONE_DIR}/bin/qwen" << 'LAUNCHER_EOF'
#!/usr/bin/env bash
###############################################################################
# qwen - Qwen Code standalone launcher
#
# 这个脚本会使用嵌入的 Node.js 运行 qwen-code bundle。
# 使用方式:
#   ./bin/qwen [args...]
#   或者将 bin/ 加入 PATH 后直接: qwen [args...]
###############################################################################

set -euo pipefail

# 获取脚本所在的真实目录（处理 symlink 的情况）
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
QWEN_HOME="$( cd -P "$( dirname "$SOURCE" )/.." && pwd )"

# 嵌入的 Node.js
NODE_BIN="${QWEN_HOME}/node/bin/node"

# 确保 Node.js 可执行
if [ ! -x "${NODE_BIN}" ]; then
  echo "ERROR: Node.js binary not found at ${NODE_BIN}" >&2
  echo "Please ensure the qwen-code-standalone directory is intact." >&2
  exit 1
fi

# 设置 NODE_PATH 让 native 模块可以被找到
export NODE_PATH="${QWEN_HOME}/native_modules/node_modules:${NODE_PATH:-}"

# 传递所有参数给 qwen-code
exec "${NODE_BIN}" "${QWEN_HOME}/dist/cli.js" "$@"
LAUNCHER_EOF

chmod +x "${STANDALONE_DIR}/bin/qwen"

# ============================= 打包 ============================
echo "[6/6] 打包成 tar.gz..."
cd "${BUILD_DIR}"
tar -czf qwen-code-standalone.tar.gz qwen-code-standalone/

FINAL_SIZE=$(du -sh "${BUILD_DIR}/qwen-code-standalone.tar.gz" | awk '{print $1}')
DIR_SIZE=$(du -sh "${STANDALONE_DIR}" | awk '{print $1}')

echo ""
echo "============================================"
echo "  ✅ 构建完成!"
echo "============================================"
echo ""
echo "  目录: ${STANDALONE_DIR}"
echo "  目录大小: ${DIR_SIZE}"
echo ""
echo "  压缩包: ${BUILD_DIR}/qwen-code-standalone.tar.gz"
echo "  压缩包大小: ${FINAL_SIZE}"
echo ""
echo "  使用方法:"
echo "    1. 上传到服务器:"
echo "       scp ${BUILD_DIR}/qwen-code-standalone.tar.gz user@server:~/"
echo ""
echo "    2. 在服务器上解压:"
echo "       tar -xzf qwen-code-standalone.tar.gz"
echo ""
echo "    3. 运行:"
echo "       ./qwen-code-standalone/bin/qwen"
echo ""
echo "    4. (可选) 加入 PATH:"
echo "       export PATH=\"\$HOME/qwen-code-standalone/bin:\$PATH\""
echo "       qwen"
echo ""
echo "    5. (可选) 替换现有 qwencode:"
echo "       sudo ln -sf \$HOME/qwen-code-standalone/bin/qwen /usr/local/bin/qwen"
echo ""
