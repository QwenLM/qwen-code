#!/usr/bin/env bash
# 本地模拟 CI upstream sync 流程（patch-apply 模式）
# 用法: bash scripts/test-local-sync.sh
#
# 在临时 worktree 中执行完整 sync 流程，验证所有 patch 能 clean apply，
# 且 rewrite-package-identity.js 能正常执行。
# 不会影响当前工作区。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPWT=""

cleanup() {
  if [ -n "$TMPWT" ] && [ -d "$TMPWT" ]; then
    echo "🧹 清理临时 worktree: $TMPWT"
    git -C "$REPO_ROOT" worktree remove --force "$TMPWT" 2>/dev/null || rm -rf "$TMPWT"
  fi
}
trap cleanup EXIT

echo "═══════════════════════════════════════════════════════════"
echo " Fork Upstream Sync - 本地测试"
echo "═══════════════════════════════════════════════════════════"
echo ""

# 确保有最新的 upstream/main
echo "📡 Fetching upstream/main..."
git -C "$REPO_ROOT" fetch upstream main 2>/dev/null || \
  git -C "$REPO_ROOT" fetch origin main 2>/dev/null || true

UPSTREAM_REF="upstream/main"
if ! git -C "$REPO_ROOT" rev-parse "$UPSTREAM_REF" >/dev/null 2>&1; then
  echo "⚠️  未找到 upstream/main remote，尝试使用 origin/main"
  UPSTREAM_REF="origin/main"
fi

UPSTREAM_SHA=$(git -C "$REPO_ROOT" rev-parse "$UPSTREAM_REF")
echo "   upstream HEAD: $UPSTREAM_SHA ($(git -C "$REPO_ROOT" log --oneline -1 "$UPSTREAM_REF"))"
echo ""

# 创建临时 worktree（模拟 CI checkout upstream/main）
TMPWT=$(mktemp -d "${TMPDIR:-/tmp}/fork-sync-test.XXXXXX")
echo "📂 创建临时 worktree: $TMPWT"
git -C "$REPO_ROOT" worktree add --detach "$TMPWT" "$UPSTREAM_REF" 2>/dev/null
echo ""

cd "$TMPWT"

# 从当前分支（而非 origin/main）取 .fork/ 目录，以测试最新的 patch
echo "📋 从当前分支获取 .fork/ 基础设施..."
CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse HEAD)
git checkout "$CURRENT_BRANCH" -- .fork/ 2>/dev/null || {
  echo "❌ 无法获取 .fork/ 目录"
  exit 1
}
echo "   ✓ .fork/ 已就位"
echo ""

# Step 1: Apply patches
echo "═══════════════════════════════════════════════════════════"
echo " Step 1: Apply fork patches"
echo "═══════════════════════════════════════════════════════════"
APPLY_RC=0
bash .fork/apply.sh 2>&1 || APPLY_RC=$?

if [ "$APPLY_RC" -ne 0 ]; then
  echo ""
  echo "❌ Patch apply 失败！(exit code: $APPLY_RC)"
  echo ""
  echo "失败详情:"
  bash .fork/apply.sh --check 2>&1 | grep -E "^(FAIL|OK):" || true
  echo ""
  echo "需要 refresh 的 patches:"
  find . -name "*.rej" -exec echo "  {}" \;
  exit 1
fi

echo ""
echo "✅ 全部 patches apply 成功"
echo ""

# Step 2: Rewrite package identity
echo "═══════════════════════════════════════════════════════════"
echo " Step 2: Rewrite package identity"
echo "═══════════════════════════════════════════════════════════"
if [ -f ".fork/rewrite-package-identity.js" ]; then
  node .fork/rewrite-package-identity.js
  echo "✅ Package identity 改写完成"
else
  echo "⚠️  rewrite-package-identity.js 不存在，跳过"
fi
echo ""

# Step 3: 验证结果
echo "═══════════════════════════════════════════════════════════"
echo " Step 3: 验证结果"
echo "═══════════════════════════════════════════════════════════"

# 检查 package.json name 是否已改写
ROOT_PKG_NAME=$(node -e "console.log(require('./package.json').name)" 2>/dev/null || echo "?")
echo "   Root package.json name: $ROOT_PKG_NAME"

# 检查有无残留 .rej 文件
REJ_COUNT=$(find . -name "*.rej" | wc -l | tr -d ' ')
if [ "$REJ_COUNT" -gt 0 ]; then
  echo "   ⚠️  发现 $REJ_COUNT 个 .rej 文件（不应存在）:"
  find . -name "*.rej" -exec echo "      {}" \;
  exit 1
fi

# 统计变更
CHANGED=$(git diff --stat HEAD | tail -1)
echo "   变更统计: $CHANGED"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo " ✅ 测试通过！Sync 流程无冲突，可正常运行。"
echo "═══════════════════════════════════════════════════════════"
