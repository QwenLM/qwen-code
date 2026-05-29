#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# upgrade-qwen.sh
#
# 一键升级 qwen-code 到最新版本。
#
# 自动从 OSS 获取最新版本号，然后调用 deploy-qwen.sh 完成
# 下载、安装全流程。
#
# 用法:
#   curl -fsSL <oss_url>/upgrade-qwen.sh | bash
#   curl -fsSL <oss_url>/upgrade-qwen.sh | bash -s -- --force
#
# 参数:
#   --force     跳过版本比较，强制重新安装
#   --dry-run   仅显示版本信息，不执行安装
#   其他参数透传给 deploy-qwen.sh
# ──────────────────────────────────────────────────────────
set -euo pipefail

# ── OSS 配置 ──
OSS_BUCKET="dataworks-notebook-cn-shanghai"
OSS_HOST="${OSS_BUCKET}.oss-cn-shanghai.aliyuncs.com"
OSS_PREFIX="public-datasets/aone-release/alishu/qwen-code"
METADATA_URL="https://${OSS_HOST}/${OSS_PREFIX}/latest/metadata.json"
DEPLOY_URL="https://${OSS_HOST}/${OSS_PREFIX}/deploy-qwen.sh"

# ── 颜色输出 ──
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; CYAN=''; NC=''
fi
info()  { echo -e "${GREEN}>>>${NC} $*"; }
warn()  { echo -e "${YELLOW}>>> WARNING:${NC} $*"; }
error() { echo -e "${RED}>>> ERROR:${NC} $*" >&2; }

# ── 解析参数 ──
FORCE="false"
DRY_RUN="false"
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)    FORCE="true"; shift ;;
    --dry-run)  DRY_RUN="true"; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \{0,1\}//p }' "$0"
      exit 0
      ;;
    *)  EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# ── 获取最新版本号 ──
info "Fetching latest version from OSS..."
METADATA=$(curl -fsSL "${METADATA_URL}" 2>/dev/null) || {
  error "Failed to fetch metadata from ${METADATA_URL}"
  exit 1
}

LATEST_VERSION=""
BUILD_TIME=""
GIT_SHA=""

parse_json_field() {
  echo "${METADATA}" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 | sed "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/"
}

if command -v node &>/dev/null; then
  LATEST_VERSION=$(echo "${METADATA}" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).version)")
  BUILD_TIME=$(echo "${METADATA}" | node -e "const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(m.build_time||m.builtAt||'')")
  GIT_SHA=$(echo "${METADATA}" | node -e "const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(m.git_short_sha||m.gitSha||'')")
elif command -v python3 &>/dev/null; then
  LATEST_VERSION=$(echo "${METADATA}" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'],end='')")
  BUILD_TIME=$(echo "${METADATA}" | python3 -c "import sys,json; m=json.load(sys.stdin); print(m.get('build_time',m.get('builtAt','')),end='')")
  GIT_SHA=$(echo "${METADATA}" | python3 -c "import sys,json; m=json.load(sys.stdin); print(m.get('git_short_sha',m.get('gitSha','')),end='')")
else
  LATEST_VERSION=$(parse_json_field "version")
  BUILD_TIME=$(parse_json_field "build_time")
  [ -z "${BUILD_TIME}" ] && BUILD_TIME=$(parse_json_field "builtAt")
  GIT_SHA=$(parse_json_field "git_short_sha")
  [ -z "${GIT_SHA}" ] && GIT_SHA=$(parse_json_field "gitSha")
fi

if [ -z "${LATEST_VERSION}" ]; then
  error "Failed to parse version from metadata"
  echo "${METADATA}"
  exit 1
fi

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Qwen Code Upgrade${NC}"
echo -e "  Latest:     ${GREEN}${LATEST_VERSION}${NC}"
[ -n "${BUILD_TIME}" ] && echo -e "  Built at:   ${BUILD_TIME}"
[ -n "${GIT_SHA}" ]    && echo -e "  Git SHA:    ${GIT_SHA}"

# ── 获取当前版本号 ──
INSTALL_DIR="${QWEN_INSTALL_DIR:-/usr/local/qwen-code}"
CURRENT_VERSION=""
LOCAL_META=""
for f in "${INSTALL_DIR}/metadata.json" "${INSTALL_DIR}/META.json"; do
  [ -f "$f" ] && LOCAL_META="$f" && break
done
if [ -n "${LOCAL_META}" ]; then
  if command -v node &>/dev/null; then
    CURRENT_VERSION=$(LOCAL_META="$LOCAL_META" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.LOCAL_META,'utf8')).version||'')" 2>/dev/null || true)
  elif command -v python3 &>/dev/null; then
    CURRENT_VERSION=$(LOCAL_META="$LOCAL_META" python3 -c "import os,json; print(json.load(open(os.environ['LOCAL_META']))['version'],end='')" 2>/dev/null || true)
  else
    CURRENT_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${LOCAL_META}" \
      | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"//;s/".*//' || true)
  fi
fi

if [ -n "${CURRENT_VERSION}" ]; then
  echo -e "  Current:    ${CURRENT_VERSION}"
fi
echo -e "${CYAN}============================================${NC}"
echo ""

# ── Dry run 模式 ──
if [ "${DRY_RUN}" = "true" ]; then
  info "Dry run mode, not installing."
  exit 0
fi

# ── 版本比较 ──
if [ "${FORCE}" != "true" ] && [ "${CURRENT_VERSION}" = "${LATEST_VERSION}" ]; then
  info "Already running the latest version (${CURRENT_VERSION}). Use --force to reinstall."
  exit 0
fi

# ── 执行升级 ──
info "Upgrading to ${LATEST_VERSION}..."
curl -fsSL "${DEPLOY_URL}" | bash -s -- --version "${LATEST_VERSION}" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
info "Upgrade complete!"
