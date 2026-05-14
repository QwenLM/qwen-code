#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# build-standalone-ci.sh
#
# CI 环境下构建 qwen-code bundle 包。
#
# 基于 esbuild bundle 产出，打包为可直接部署的 tarball。
# 目标机器需要系统 Node.js >= 20。
#
# 产出结构:
#   $ARTIFACT_DIR/qwen-code/
#     ├── bin/qwen            <- launcher（使用系统 node）
#     ├── dist/cli.js         <- esbuild bundle
#     ├── dist/vendor/        <- ripgrep 等工具
#     ├── dist/locales/       <- i18n
#     ├── dist/bundled/       <- 内置 skill 文档
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

VERSION=$(cat "${WORKSPACE_DIR}/.resolved_version")
BUILD_TIME=$(cat "${WORKSPACE_DIR}/.build_time" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)

BUILD_DIR="${WORKSPACE_DIR}/build"
STANDALONE_DIR="${BUILD_DIR}/qwen-code"

echo "============================================"
echo "  Qwen Code Bundle Builder"
echo "  Version: ${VERSION}"
echo "  Arch:    ${ARCH}"
echo "============================================"
echo ""

# ── 清理 ──
rm -rf "${STANDALONE_DIR}"
mkdir -p "${STANDALONE_DIR}"

# ── Step 1: Bundle ──
echo "[1/4] 构建 esbuild bundle..."
cd "${SOURCE_DIR}"

if [ -f "${SOURCE_DIR}/dist/cli.js" ]; then
  echo "  -> 发现已有 dist/cli.js，跳过 bundle"
else
  npm run build
  npm run bundle
fi

echo "  -> 拷贝 dist/ 到打包目录..."
cp -r "${SOURCE_DIR}/dist" "${STANDALONE_DIR}/dist"

# ── Step 2: 注入版本号 ──
echo "[2/4] 注入版本号 ${VERSION}..."
if [ -f "${STANDALONE_DIR}/dist/cli.js" ]; then
  node -e "
    const fs = require('fs');
    const p = '${STANDALONE_DIR}/dist/cli.js';
    let c = fs.readFileSync(p, 'utf8');
    if (c.includes('__QWEN_VERSION__')) {
      c = c.replace(/__QWEN_VERSION__/g, '${VERSION}');
    }
    fs.writeFileSync(p, c);
  " || echo "  -> 版本注入跳过（无 __QWEN_VERSION__ 占位符）"
fi

# ── Step 3: Launcher + Metadata ──
echo "[3/4] 生成 launcher 脚本和 metadata..."
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

exec node "${QWEN_HOME}/dist/cli.js" "$@"
LAUNCHER_EOF

chmod +x "${STANDALONE_DIR}/bin/qwen"

SHORT_SHA=$(cd "${SOURCE_DIR}" && git rev-parse --short HEAD)
FULL_SHA=$(cd "${SOURCE_DIR}" && git rev-parse HEAD)

node -e "
  const meta = {
    version: '${VERSION}',
    git_sha: '${FULL_SHA}',
    git_short_sha: '${SHORT_SHA}',
    arch: '${ARCH}',
    platform: 'linux',
    build_time: '${BUILD_TIME}',
  };
  require('fs').writeFileSync('${STANDALONE_DIR}/metadata.json', JSON.stringify(meta, null, 2));
"

# ── Step 4: 打包 ──
echo "[4/4] 打包成 tar.gz..."
TARBALL_NAME="qwen-code-${VERSION}-linux-${ARCH}.tar.gz"
cd "${BUILD_DIR}"
tar -czf "${TARBALL_NAME}" qwen-code/

FINAL_SIZE=$(du -sh "${BUILD_DIR}/${TARBALL_NAME}" | awk '{print $1}')
DIR_SIZE=$(du -sh "${STANDALONE_DIR}" | awk '{print $1}')

sha256sum "${BUILD_DIR}/${TARBALL_NAME}" > "${BUILD_DIR}/SHA256SUMS"

echo ""
echo "============================================"
echo "  构建完成!"
echo "  版本: ${VERSION}"
echo "  目录大小: ${DIR_SIZE}"
echo "  压缩包: ${TARBALL_NAME} (${FINAL_SIZE})"
echo "  SHA256: $(awk '{print $1}' "${BUILD_DIR}/SHA256SUMS")"
echo "============================================"
