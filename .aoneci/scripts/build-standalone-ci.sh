#!/usr/bin/env bash
# build-standalone-ci.sh — 构建 standalone 产物
#
# 环境变量:
#   SOURCE_DIR    - 源码目录 (默认 AONE_CI_SOURCE 或 .)
#   VERSION       - 版本号 (默认从 package.json 读取)
#   STANDALONE_DIR - standalone 产物目录 (默认 $PWD/.standalone)

set -euo pipefail

SOURCE_DIR="${AONE_CI_SOURCE:-.}"
cd "$SOURCE_DIR"

# ── 确定版本号 ──
if [ -z "${VERSION:-}" ]; then
  VERSION=$(node -e "console.log(require('./package.json').version || '')" 2>/dev/null || echo "")
  if [ -z "$VERSION" ]; then
    echo "⚠️  Warning: package.json 解析失败或 version 字段为空，VERSION 将回退为空值" >&2
  fi
fi
if [ -z "$VERSION" ] || [ "$VERSION" = "undefined" ]; then
  echo "❌ 无法确定版本号" >&2
  exit 1
fi
echo "📦 Version: $VERSION"

# ── 确定 standalone 目录 ──
STANDALONE_DIR="${STANDALONE_DIR:-${PWD}/.standalone}"
if [ "$(dirname "$STANDALONE_DIR")" = "/" ]; then
  echo "❌ 工作目录在根层级，请显式设置 STANDALONE_DIR 环境变量" >&2
  exit 1
fi
echo "📁 Standalone dir: $STANDALONE_DIR"

# ── Step 0: 确保已构建 ──
if [ ! -d "dist" ]; then
  echo "[0/4] dist/ 不存在，执行构建..."
  npm run build
else
  echo "[0/4] dist/ 已存在，跳过构建"
fi

# ── Step 1: 准备 standalone 目录 ──
echo "[1/4] 准备 standalone 目录..."
rm -rf "$STANDALONE_DIR"
mkdir -p "$STANDALONE_DIR"

# 复制 dist
cp -r "${SOURCE_DIR}/dist" "${STANDALONE_DIR}/"

# 复制 vendor（如果存在）
if [ -d "${SOURCE_DIR}/vendor" ]; then
  cp -r "${SOURCE_DIR}/vendor" "${STANDALONE_DIR}/vendor"
fi

# 复制 node_modules 中需要的 native 依赖（如果有）
if [ -d "${SOURCE_DIR}/node_modules" ]; then
  # 只复制必要的 native binding（例如 @aspect 相关）
  if [ -d "${SOURCE_DIR}/node_modules/@aspect" ]; then
    mkdir -p "${STANDALONE_DIR}/node_modules"
    cp -r "${SOURCE_DIR}/node_modules/@aspect" "${STANDALONE_DIR}/node_modules/"
  fi
fi

# ── Step 2: 注入版本号 ──
echo "[2/4] 注入版本号 ${VERSION}..."
if [ -f "${STANDALONE_DIR}/dist/cli.js" ]; then
  STANDALONE_DIR="$STANDALONE_DIR" VERSION="$VERSION" node -e '
    const fs = require("fs");
    const path = require("path");
    const p = path.join(process.env.STANDALONE_DIR, "dist", "cli.js");
    let c = fs.readFileSync(p, "utf8");
    if (c.includes("__QWEN_VERSION__")) {
      c = c.replace(/__QWEN_VERSION__/g, () => process.env.VERSION);
    }
    fs.writeFileSync(p, c);
  ' || echo "  -> 版本注入跳过（无 __QWEN_VERSION__ 占位符）"
fi

# ── Node package scope ──
STANDALONE_DIR="$STANDALONE_DIR" SOURCE_DIR="$SOURCE_DIR" VERSION="$VERSION" node -e '
  const fs = require("fs");
  const path = require("path");
  let name = "@alife/dataworks-qwen-code";
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(process.env.SOURCE_DIR, "package.json"), "utf8"));
    if (rootPkg.name) name = rootPkg.name;
  } catch {}
  const pkg = {
    name,
    version: process.env.VERSION,
    type: "module",
    private: true,
  };
  fs.writeFileSync(path.join(process.env.STANDALONE_DIR, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
'

# ── Step 3: Launcher + Metadata ──
echo "[3/4] 生成 launcher 脚本和 metadata..."
mkdir -p "${STANDALONE_DIR}/bin"

cat > "${STANDALONE_DIR}/bin/qwen" << 'LAUNCHER_EOF'
#!/usr/bin/env bash
set -euo pipefail

# 解析 symlink 找到真实安装目录
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
BIN_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(dirname "$BIN_DIR")"

exec node "${ROOT_DIR}/dist/cli.js" "$@"
LAUNCHER_EOF
chmod +x "${STANDALONE_DIR}/bin/qwen"

# metadata (保持 metadata.json 文件名 + 兼容新旧字段名)
SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STANDALONE_DIR="$STANDALONE_DIR" VERSION="$VERSION" BUILD_TIME="$BUILD_TIME" \
  SHORT_SHA="$SHORT_SHA" GIT_SHA="$GIT_SHA" node -e '
  const fs = require("fs");
  const path = require("path");
  const meta = {
    version: process.env.VERSION,
    build_time: process.env.BUILD_TIME,
    git_short_sha: process.env.SHORT_SHA,
    git_sha: process.env.GIT_SHA,
  };
  fs.writeFileSync(
    path.join(process.env.STANDALONE_DIR, "metadata.json"),
    JSON.stringify(meta, null, 2) + "\n"
  );
'

# ── Step 4: 打包 ──
echo "[4/4] 打包..."
ARTIFACT_DIR="${ARTIFACT_DIR:-${PWD}/.artifacts}"
if [ "$ARTIFACT_DIR" = "/" ]; then
  echo "❌ 工作目录在根层级，请显式设置 ARTIFACT_DIR 环境变量" >&2
  exit 1
fi
mkdir -p "$ARTIFACT_DIR"
TARBALL="${ARTIFACT_DIR}/qwen-code-standalone-${VERSION}.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$STANDALONE_DIR")" "$(basename "$STANDALONE_DIR")"
echo "✅ Standalone artifact: $TARBALL"
echo "   Size: $(du -h "$TARBALL" | cut -f1)"
