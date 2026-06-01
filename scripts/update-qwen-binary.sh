#!/usr/bin/env bash
###############################################################################
# update-qwen-binary.sh
#
# 从 OSS 下载 qwen-code standalone 二进制包并安装/更新。
# 支持首次安装、覆盖 npm 版本、以及后续自我更新。
#
# 使用方式（一行命令远程执行）:
#   curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/binary/update-qwen-binary.sh | bash
#
# 或者下载后本地执行:
#   bash update-qwen-binary.sh
#   bash update-qwen-binary.sh --version 0.14.1
#   bash update-qwen-binary.sh --install-dir /opt/qwen-code
###############################################################################

set -euo pipefail

# ============================= 配置 ============================
# OSS 基础 URL（tarball 和版本信息文件都放在这个路径下）
OSS_BASE_URL="${QWEN_OSS_BASE_URL:-https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/binary}"

# 默认安装目录
INSTALL_DIR="${QWEN_INSTALL_DIR:-${HOME}/.qwen-code}"

# qwen 命令的 symlink 位置
BIN_DIR="${QWEN_BIN_DIR:-}"

# ============================= 颜色 ============================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}❌ $1${NC}"; }

# ============================= 参数解析 ============================
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      VERSION="$2"; shift 2 ;;
    --install-dir)
      INSTALL_DIR="$2"; shift 2 ;;
    --bin-dir)
      BIN_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --version, -v VERSION   指定版本号 (默认: 最新版本)"
      echo "  --install-dir DIR       安装目录 (默认: ~/.qwen-code)"
      echo "  --bin-dir DIR           symlink 目录 (默认: 自动检测)"
      echo "  -h, --help              显示帮助"
      echo ""
      echo "Environment Variables:"
      echo "  QWEN_OSS_BASE_URL   OSS 基础 URL"
      echo "  QWEN_INSTALL_DIR    安装目录"
      echo "  QWEN_BIN_DIR        symlink 目录"
      exit 0
      ;;
    *)
      log_error "未知选项: $1"; exit 1 ;;
  esac
done

# ============================= 工具函数 ============================

# 检测下载工具
detect_download_tool() {
  if command -v curl &>/dev/null; then
    echo "curl"
  elif command -v wget &>/dev/null; then
    echo "wget"
  else
    log_error "未找到 curl 或 wget，请先安装其中之一"
    exit 1
  fi
}

# 下载文件
# 参数: $1=URL $2=输出文件（如果为 - 则输出到 stdout）
download() {
  local url="$1"
  local output="${2:--}"
  local tool
  tool=$(detect_download_tool)

  if [[ "${tool}" == "curl" ]]; then
    if [[ "${output}" == "-" ]]; then
      curl -fsSL "${url}"
    else
      curl -fSL -# -o "${output}" "${url}"
    fi
  else
    if [[ "${output}" == "-" ]]; then
      wget -qO - "${url}"
    else
      wget -q --show-progress -O "${output}" "${url}"
    fi
  fi
}

# 获取当前安装的版本
get_installed_version() {
  local version_file="${INSTALL_DIR}/.version"
  if [[ -f "${version_file}" ]]; then
    cat "${version_file}"
  else
    echo "none"
  fi
}

# 自动选择 bin 目录
auto_detect_bin_dir() {
  # 优先使用用户指定的
  if [[ -n "${BIN_DIR}" ]]; then
    echo "${BIN_DIR}"
    return
  fi

  # 检查已有 qwen 命令的位置
  local existing
  existing="$(command -v qwen 2>/dev/null || true)"
  if [[ -n "${existing}" ]]; then
    dirname "${existing}"
    return
  fi

  # 尝试常见的用户可写 bin 目录
  local candidates=(
    "${HOME}/.local/bin"
    "${HOME}/bin"
    "${HOME}/.npm-global/bin"
    "/usr/local/bin"
  )

  for dir in "${candidates[@]}"; do
    if [[ -d "${dir}" ]] && [[ -w "${dir}" ]]; then
      echo "${dir}"
      return
    fi
  done

  # 都没有就创建 ~/.local/bin
  echo "${HOME}/.local/bin"
}

# 确保 bin 目录在 PATH 中
ensure_bin_in_path() {
  local bin_dir="$1"

  # 已在 PATH 中则跳过
  if echo "${PATH}" | tr ':' '\n' | grep -qx "${bin_dir}"; then
    return 0
  fi

  log_warning "${bin_dir} 不在 PATH 中"

  # 尝试写入 shell profile
  local profile=""
  case "$(basename "${SHELL:-bash}")" in
    zsh)  profile="${HOME}/.zshrc" ;;
    bash) profile="${HOME}/.bashrc" ;;
    fish) profile="" ;; # fish 语法不同，跳过
    *)    profile="${HOME}/.profile" ;;
  esac

  if [[ -n "${profile}" ]] && [[ -w "${profile}" || ! -f "${profile}" ]]; then
    if ! grep -q "${bin_dir}" "${profile}" 2>/dev/null; then
      echo "" >> "${profile}"
      echo "# Qwen Code binary (added by update-qwen-binary.sh)" >> "${profile}"
      echo "export PATH=\"${bin_dir}:\$PATH\"" >> "${profile}"
      log_info "已添加 ${bin_dir} 到 ${profile}"
    fi
  fi

  # 当前 session 立即生效
  export PATH="${bin_dir}:${PATH}"
  log_info "提示: 新终端会自动生效，当前终端请执行: export PATH=\"${bin_dir}:\$PATH\""
}

# ============================= 主流程 ============================

echo ""
echo "=========================================="
echo "   Qwen Code Binary Installer / Updater"
echo "=========================================="
echo ""

# 1. 获取最新版本号
if [[ -z "${VERSION}" ]]; then
  log_info "获取最新版本信息..."
  VERSION=$(download "${OSS_BASE_URL}/latest-version.txt" "-" 2>/dev/null | tr -d '[:space:]') || true

  if [[ -z "${VERSION}" ]]; then
    log_error "无法获取最新版本信息"
    log_info "请检查网络连接，或使用 --version 手动指定版本号"
    exit 1
  fi
fi

log_info "目标版本: ${VERSION}"

# 2. 检查是否需要更新
INSTALLED_VERSION=$(get_installed_version)
if [[ "${INSTALLED_VERSION}" == "${VERSION}" ]]; then
  log_success "当前已是最新版本 (${VERSION})，无需更新"
  exit 0
fi

if [[ "${INSTALLED_VERSION}" != "none" ]]; then
  log_info "当前版本: ${INSTALLED_VERSION} -> 更新到: ${VERSION}"
else
  log_info "首次安装版本: ${VERSION}"
fi

# 3. 检测已有 qwen 命令
EXISTING_QWEN="$(command -v qwen 2>/dev/null || true)"
if [[ -n "${EXISTING_QWEN}" ]]; then
  if head -1 "${EXISTING_QWEN}" 2>/dev/null | grep -q "node"; then
    log_info "检测到 npm 安装的 qwen: ${EXISTING_QWEN}"
    log_info "安装完成后将被 standalone 版本替换"
  elif head -1 "${EXISTING_QWEN}" 2>/dev/null | grep -q "bash"; then
    log_info "检测到 standalone 版的 qwen: ${EXISTING_QWEN}"
  fi
fi

# 4. 下载 tarball
TARBALL_NAME="qwen-code-standalone-${VERSION}.tar.gz"
TARBALL_URL="${OSS_BASE_URL}/${TARBALL_NAME}"
TMP_DIR=$(mktemp -d)
TMP_TARBALL="${TMP_DIR}/${TARBALL_NAME}"

log_info "下载 ${TARBALL_URL}..."
if ! download "${TARBALL_URL}" "${TMP_TARBALL}"; then
  log_error "下载失败: ${TARBALL_URL}"
  log_info "请检查版本号是否正确，或网络是否可用"
  rm -rf "${TMP_DIR}"
  exit 1
fi

TARBALL_SIZE=$(du -sh "${TMP_TARBALL}" | awk '{print $1}')
log_success "下载完成 (${TARBALL_SIZE})"

# 5. 备份旧版本并解压
if [[ -d "${INSTALL_DIR}" ]]; then
  BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"
  log_info "备份旧版本到: ${BACKUP_DIR}"
  mv "${INSTALL_DIR}" "${BACKUP_DIR}"
fi

mkdir -p "${INSTALL_DIR}"

log_info "解压安装中..."
tar -xzf "${TMP_TARBALL}" --strip-components=1 -C "${INSTALL_DIR}"

# 确保可执行
chmod +x "${INSTALL_DIR}/bin/qwen"
chmod +x "${INSTALL_DIR}/node/bin/node"

# 写入版本号
echo "${VERSION}" > "${INSTALL_DIR}/.version"

# 清理临时文件
rm -rf "${TMP_DIR}"

# 6. 创建/更新 symlink
DETECTED_BIN_DIR=$(auto_detect_bin_dir)
mkdir -p "${DETECTED_BIN_DIR}"

SYMLINK_PATH="${DETECTED_BIN_DIR}/qwen"

# 如果已有 npm 安装的 qwen 在同一位置，直接替换
if [[ -f "${SYMLINK_PATH}" ]] && ! [[ -L "${SYMLINK_PATH}" ]]; then
  # 这是一个实体文件（npm 安装的），备份后替换
  log_info "备份 npm 安装的 qwen: ${SYMLINK_PATH} -> ${SYMLINK_PATH}.npm-backup"
  mv "${SYMLINK_PATH}" "${SYMLINK_PATH}.npm-backup"
fi

ln -sf "${INSTALL_DIR}/bin/qwen" "${SYMLINK_PATH}"
log_success "symlink: ${SYMLINK_PATH} -> ${INSTALL_DIR}/bin/qwen"

# 确保 bin 目录在 PATH 中
ensure_bin_in_path "${DETECTED_BIN_DIR}"

# 7. 验证安装
log_info "验证安装..."
if "${INSTALL_DIR}/bin/qwen" --version &>/dev/null; then
  QWEN_VERSION=$("${INSTALL_DIR}/bin/qwen" --version 2>/dev/null || echo "${VERSION}")
  log_success "版本: ${QWEN_VERSION}"
else
  log_info "注意: 版本验证跳过（可能是跨平台构建）"
fi

# 8. 清理旧备份（保留最近 3 个）
BACKUP_LIST=$(ls -dt "${INSTALL_DIR}.backup."* 2>/dev/null || true)
BACKUP_COUNT=$(echo "${BACKUP_LIST}" | grep -c '.' 2>/dev/null || echo "0")
if [[ "${BACKUP_COUNT}" -gt 3 ]]; then
  log_info "清理旧备份（保留最近 3 个）..."
  echo "${BACKUP_LIST}" | tail -n +4 | xargs rm -rf
fi

# 完成
echo ""
echo "=========================================="
log_success "安装/更新完成!"
echo "=========================================="
echo ""
echo "  版本:      ${VERSION}"
echo "  安装目录:  ${INSTALL_DIR}"
echo "  命令路径:  ${SYMLINK_PATH}"
echo ""
echo "  运行: qwen"
echo ""

# npm 版本清理提示
if [[ -f "${SYMLINK_PATH}.npm-backup" ]]; then
  echo "  提示: 已备份原 npm 版本到 ${SYMLINK_PATH}.npm-backup"
  echo "  如 standalone 版本工作正常，可以清理:"
  echo "    rm ${SYMLINK_PATH}.npm-backup"
  echo "    npm uninstall -g @qwen-code/qwen-code"
  echo ""
fi
