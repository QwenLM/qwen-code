#!/usr/bin/env bash

# ============================================================================
# copy-to-package.sh
# 将 packages/ 下所有非 private 包的发包产物拷贝到根目录 .package 下
#
# 拷贝规则：
#   - 自动扫描 packages/**/package.json（忽略 dist/node_modules）
#   - 仅处理 private !== true 的包
#   - 保留 packages/ 下的相对目录结构，例如：
#       packages/cli/dist/                → .package/cli/dist/
#       packages/core/vendor/             → .package/core/vendor/
#       packages/channels/base/dist/      → .package/channel-base/dist/
#   - 始终拷贝 package.json
#   - 额外拷贝 package.json 中 files 字段声明的产物
#
# 使用方式：
#   bash scripts/copy-to-package.sh
# ============================================================================

set -euo pipefail

# 定位项目根目录（脚本位于 scripts/ 下）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_PACKAGE_JSON="${ROOT_DIR}/package.json"

# 目标路径
PACKAGE_DIR="${ROOT_DIR}/.package"

if [ ! -f "${ROOT_PACKAGE_JSON}" ]; then
  echo "❌ 错误: 根目录 package.json 不存在"
  exit 1
fi

workspace_patterns=()
while IFS= read -r workspace_pattern; do
  workspace_patterns+=("${workspace_pattern}")
done < <(
  node -e '
    const pkg = require(process.argv[1]);
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.workspaces?.packages)
        ? pkg.workspaces.packages
        : [];
    for (const workspace of workspaces) console.log(workspace);
  ' "${ROOT_PACKAGE_JSON}"
)

if [ "${#workspace_patterns[@]}" -eq 0 ]; then
  echo "❌ 错误: 根目录 package.json 未声明 workspaces"
  exit 1
fi

package_manifest="$(mktemp)"
trap 'rm -f "${package_manifest}"' EXIT

shopt -s nullglob
for workspace_pattern in "${workspace_patterns[@]}"; do
  for workspace_dir in ${ROOT_DIR}/${workspace_pattern}; do
    if [ -d "${workspace_dir}" ] && [ -f "${workspace_dir}/package.json" ]; then
      printf '%s\n' "${workspace_dir}/package.json" >> "${package_manifest}"
    fi
  done
done
shopt -u nullglob

PACKAGE_JSON_FILES=()
while IFS= read -r package_json; do
  PACKAGE_JSON_FILES+=("${package_json}")
done < <(sort -u "${package_manifest}")

if [ "${#PACKAGE_JSON_FILES[@]}" -eq 0 ]; then
  echo "❌ 错误: 未从 workspaces 中解析到任何 package.json"
  exit 1
fi

# ---- 清理旧产物 ----

if [ -d "${PACKAGE_DIR}" ]; then
  echo "🗑  清理旧的 .package 目录..."
  rm -rf "${PACKAGE_DIR}"
fi

# ---- 创建目标目录并拷贝 ----

mkdir -p "${PACKAGE_DIR}"

# ============================================================================
# 发布模式判断
# ============================================================================
#
# 判断逻辑（优先级从高到低）：
#   1. RELEASE_MODE 环境变量显式指定（最高优先级，用户手动覆盖）
#   2. DEF 平台 def_publish_env 参数：
#      - daily  → 预发环境（版本号添加 -beta.TIMESTAMP）
#      - prod/production → 线上环境（保持 x.y.z）
#   3. DEF 平台 BUILD_GIT_BRANCH 分支名：
#      - daily/xxx → 预发环境
#      - main/master/release/xxx → 线上环境
#   4. 默认：预发环境（保守策略，确保线上不会被误发 beta 包）
#
# 相关环境变量：
#   - RELEASE_MODE: 用户手动指定（daily / production）
#   - BUILD_ARGV_STR: DEF 平台构建参数字符串，如 "--def_publish_env=daily"
#   - BUILD_GIT_BRANCH: DEF 平台构建分支名
#   - BUILD_ENV: DEF 平台构建环境标识
#   - BUILD_DEST: DEF 平台构建产物目标路径
# ============================================================================

echo ""
echo "====== DEF 平台构建信息 ======"
echo "BUILD_ARGV_STR:    ${BUILD_ARGV_STR:-"(未设置)"}"
echo "BUILD_GIT_BRANCH:  ${BUILD_GIT_BRANCH:-"(未设置)"}"
echo "BUILD_ENV:         ${BUILD_ENV:-"(未设置)"}"
echo "BUILD_DEST:        ${BUILD_DEST:-"(未设置)"}"
echo "RELEASE_MODE:      ${RELEASE_MODE:-"(未设置)"}"
echo ""

# 解析 DEF 平台构建参数（从 BUILD_ARGV_STR 中提取 --key=value 格式的值）
get_build_arg_value() {
  local build_argv_str="${1}"
  local key="${2}"
  if [ -z "${build_argv_str}" ] || [ -z "${key}" ]; then
    return
  fi
  # 匹配 --key=value 或 -key=value 格式
  echo "${build_argv_str}" | grep -oE "(^|[[:space:]])-?-${key}=[^[:space:]]+" | sed 's/.*=//'
}

DEF_PUBLISH_ENV="$(get_build_arg_value "${BUILD_ARGV_STR:-}" 'def_publish_env')"
DEF_PUBLISH_TYPE="$(get_build_arg_value "${BUILD_ARGV_STR:-}" 'def_publish_type')"
DEF_PUBLISH_VERSION="$(get_build_arg_value "${BUILD_ARGV_STR:-}" 'def_publish_version')"

echo "解析后的 DEF 参数:"
echo "def_publish_env:    ${DEF_PUBLISH_ENV:-"(未设置)"}"
echo "def_publish_type:   ${DEF_PUBLISH_TYPE:-"(未设置)"}"
echo "def_publish_version: ${DEF_PUBLISH_VERSION:-"(未设置)"}"
echo ""

# 判断发布模式
RELEASE_MODE_REASON=""
if [ -n "${RELEASE_MODE:-}" ]; then
  # 用户显式指定 RELEASE_MODE，优先使用
  RELEASE_MODE_REASON="RELEASE_MODE 环境变量手动指定"
elif [ "${DEF_PUBLISH_ENV}" = "daily" ]; then
  # DEF 平台明确指定 daily 环境
  RELEASE_MODE="daily"
  RELEASE_MODE_REASON="def_publish_env=daily（DEF 平台预发环境）"
elif [ -n "${BUILD_GIT_BRANCH:-}" ] && [[ "${BUILD_GIT_BRANCH}" =~ ^daily/ ]]; then
  # 分支名以 daily/ 开头（DEF 平台预发分支命名规范）
  RELEASE_MODE="daily"
  RELEASE_MODE_REASON="BUILD_GIT_BRANCH=${BUILD_GIT_BRANCH}（daily/ 分支，预发环境）"
elif [ "${DEF_PUBLISH_ENV}" = "prod" ] || [ "${DEF_PUBLISH_ENV}" = "production" ]; then
  # DEF 平台明确指定线上环境
  RELEASE_MODE="production"
  RELEASE_MODE_REASON="def_publish_env=${DEF_PUBLISH_ENV}（DEF 平台线上环境）"
elif [ -n "${BUILD_GIT_BRANCH:-}" ] && [[ "${BUILD_GIT_BRANCH}" =~ ^(main|master|release/) ]]; then
  # main/master/release/ 分支视为线上环境
  RELEASE_MODE="production"
  RELEASE_MODE_REASON="BUILD_GIT_BRANCH=${BUILD_GIT_BRANCH}（线上分支）"
else
  # 默认预发环境（保守策略）
  RELEASE_MODE="daily"
  RELEASE_MODE_REASON="默认值（未检测到线上环境标识，使用预发环境）"
fi

echo "====== 发布模式判断结果 ======"
if [ "${RELEASE_MODE}" = "production" ]; then
  BETA_TIMESTAMP=""
  echo "🚀 发布模式: production（线上环境）"
  echo "   版本号格式: x.y.z（不带 beta 标签）"
else
  # 生成唯一时间戳，格式：YYYYMMDDHHmm，固定使用北京时间
  BETA_TIMESTAMP="$(TZ='Asia/Shanghai' date '+%Y%m%d%H%M')"
  echo "🏷  发布模式: daily（预发环境）"
  echo "   版本号格式: x.y.z-beta.${BETA_TIMESTAMP}"
fi
echo "   判断依据: ${RELEASE_MODE_REASON}"
echo ""

copied_count=0

for package_json in "${PACKAGE_JSON_FILES[@]}"; do
  package_dir="$(dirname "${package_json}")"
  package_rel="${package_dir#${ROOT_DIR}/packages/}"
  # Flatten channels/xxx → channel-xxx，避免 tnpm 把 channels/ 误识别为包目录
  package_rel="${package_rel//channels\//channel-}"
  is_private="$(node -p "Boolean(require(process.argv[1]).private)" "${package_json}")"

  if [ "${is_private}" = "true" ]; then
    echo "⏭️  跳过 private 包: ${package_rel}"
    continue
  fi

  package_files=()
  while IFS= read -r package_file; do
    package_files+=("${package_file}")
  done < <(
    node -e '
      const pkg = require(process.argv[1]);
      const files = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ["dist"];
      for (const file of files) console.log(file);
    ' "${package_json}"
  )

  target_dir="${PACKAGE_DIR}/${package_rel}"
  mkdir -p "${target_dir}"

  echo "📦 拷贝 ${package_rel}/package.json → .package/${package_rel}/package.json"
  cp "${package_json}" "${target_dir}/package.json"

  # 按发布模式修改版本号：
  #   daily      → x.y.z-beta.TIMESTAMP（预发版本规范）
  #   production → 保持 x.y.z（tnpm 线上发布规范）
  node -e "
    const fs = require('fs');
    const pkgPath = '${target_dir}/package.json';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const base = pkg.version.replace(/-.*\$/, '');
    if ('${RELEASE_MODE}' === 'production') {
      pkg.version = base;
      console.log('🚀 ' + pkg.name + ': ' + pkg.version);
    } else {
      pkg.version = base + '-beta.${BETA_TIMESTAMP}';
      console.log('🏷  ' + pkg.name + ': ' + pkg.version);
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  "

  for package_file in "${package_files[@]}"; do
    source_path="${package_dir}/${package_file}"
    target_path="${target_dir}/${package_file}"

    if [ ! -e "${source_path}" ]; then
      echo "❌ 错误: ${package_rel} 缺少 files 中声明的产物: ${package_file}"
      exit 1
    fi

    mkdir -p "$(dirname "${target_path}")"
    echo "📦 拷贝 ${package_rel}/${package_file} → .package/${package_rel}/${package_file}"
    cp -R "${source_path}" "${target_path}"
  done

  # dist/package.json 由 prepare-package.js 生成，readPackageUp 会优先找到它
  # 必须在文件拷贝完成后同步版本，否则 qwen -v 会显示源码版本而非发布版本
  # 直接读取已处理好的根 package.json 版本，确保两者一致
  node -e "
    const fs = require('fs');
    const distPkgPath = '${target_dir}/dist/package.json';
    if (!fs.existsSync(distPkgPath)) process.exit(0);
    const rootPkg = JSON.parse(fs.readFileSync('${target_dir}/package.json', 'utf8'));
    const distPkg = JSON.parse(fs.readFileSync(distPkgPath, 'utf8'));
    distPkg.version = rootPkg.version;
    fs.writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + '\n');
    console.log('   ↳ dist/package.json 已同步: ' + distPkg.version);
  "

  copied_count=$((copied_count + 1))
done

# ---- 结果验证 ----

echo ""
echo "✅ 已拷贝 ${copied_count} 个非 private 包到 .package 目录"
echo ""
echo "目录结构（最多展示 4 层）:"
if command -v find &> /dev/null; then
  find "${PACKAGE_DIR}" -maxdepth 4 | sort
fi
