#!/usr/bin/env bash
###############################################################################
# install-standalone.sh
#
# 安装/更新 qwen-code standalone 二进制包。
#
# 功能:
#   1. 解压 qwen-code-standalone.tar.gz 到指定目录
#   2. 检测是否已有 qwen 命令（npm 安装或旧版 standalone）
#   3. 创建 symlink 替换旧的 qwen 命令
#   4. 重复执行即为更新（覆盖旧版本）
#
# 使用方式:
#   bash install-standalone.sh qwen-code-standalone.tar.gz
#   bash install-standalone.sh qwen-code-standalone.tar.gz --install-dir /opt/qwen
#
# 默认安装目录: $HOME/.qwen-code
# 默认 symlink: /usr/local/bin/qwen（需要 sudo）
###############################################################################

set -euo pipefail

# ============================= 参数解析 ============================
TARBALL=""
INSTALL_DIR="${HOME}/.qwen-code"
SYMLINK_DIR="/usr/local/bin"

usage() {
  echo "Usage: $0 <tarball> [--install-dir DIR] [--symlink-dir DIR]"
  echo ""
  echo "Options:"
  echo "  --install-dir DIR   安装目录 (默认: \$HOME/.qwen-code)"
  echo "  --symlink-dir DIR   symlink 目录 (默认: /usr/local/bin)"
  echo ""
  echo "Examples:"
  echo "  $0 qwen-code-standalone.tar.gz"
  echo "  $0 qwen-code-standalone.tar.gz --install-dir /opt/qwen"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --symlink-dir)
      SYMLINK_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo "ERROR: 未知选项: $1" >&2
      usage
      ;;
    *)
      if [ -z "${TARBALL}" ]; then
        TARBALL="$1"
      else
        echo "ERROR: 多余的参数: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

if [ -z "${TARBALL}" ]; then
  echo "ERROR: 请指定 tarball 文件路径" >&2
  usage
fi

if [ ! -f "${TARBALL}" ]; then
  echo "ERROR: 文件不存在: ${TARBALL}" >&2
  exit 1
fi

SYMLINK_PATH="${SYMLINK_DIR}/qwen"

echo "============================================"
echo "  Qwen Code Standalone Installer"
echo "============================================"
echo ""
echo "  tarball:     ${TARBALL}"
echo "  安装目录:    ${INSTALL_DIR}"
echo "  symlink:     ${SYMLINK_PATH}"
echo ""

# ============================= 检测已有安装 ============================
EXISTING_QWEN="$(which qwen 2>/dev/null || true)"

if [ -n "${EXISTING_QWEN}" ]; then
  echo "[检测] 发现已有 qwen 命令: ${EXISTING_QWEN}"

  # 判断是 npm 安装还是 standalone 安装
  if head -1 "${EXISTING_QWEN}" 2>/dev/null | grep -q "node"; then
    echo "  -> 类型: npm 安装 (Node.js 脚本)"
    echo "  -> 安装后将被 standalone 版本替换"
  elif head -1 "${EXISTING_QWEN}" 2>/dev/null | grep -q "bash"; then
    echo "  -> 类型: standalone 安装 (bash launcher)"
    echo "  -> 将被更新为新版本"
  else
    echo "  -> 类型: 未知"
  fi
  echo ""

  # 如果是 symlink，记录它指向的位置
  if [ -L "${EXISTING_QWEN}" ]; then
    echo "  -> symlink 指向: $(readlink -f "${EXISTING_QWEN}")"
  fi
  echo ""
fi

# ============================= 安装 ============================
echo "[1/3] 解压到 ${INSTALL_DIR}..."

# 如果目标目录已存在，备份旧版本
if [ -d "${INSTALL_DIR}" ]; then
  BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"
  echo "  -> 备份旧版本到: ${BACKUP_DIR}"
  mv "${INSTALL_DIR}" "${BACKUP_DIR}"
fi

mkdir -p "${INSTALL_DIR}"

# 解压（strip 掉顶层 qwen-code-standalone/ 目录）
tar -xzf "${TARBALL}" --strip-components=1 -C "${INSTALL_DIR}"

echo "  -> 安装大小: $(du -sh "${INSTALL_DIR}" | awk '{print $1}')"

# 确保 launcher 和 node 可执行
chmod +x "${INSTALL_DIR}/bin/qwen"
chmod +x "${INSTALL_DIR}/node/bin/node"

# ============================= 创建 symlink ============================
echo "[2/3] 创建 symlink..."

NEED_SUDO=false
if [ -w "${SYMLINK_DIR}" ]; then
  NEED_SUDO=false
else
  NEED_SUDO=true
fi

# 如果已有 npm 安装的 qwen，先处理
if [ -n "${EXISTING_QWEN}" ] && [ "${EXISTING_QWEN}" != "${SYMLINK_PATH}" ]; then
  echo "  -> 注意: 已有 qwen 在 ${EXISTING_QWEN}"
  echo "  -> 新 symlink 将创建在 ${SYMLINK_PATH}"
  echo "  -> 请确保 ${SYMLINK_DIR} 在 PATH 中优先级高于 $(dirname "${EXISTING_QWEN}")"
  echo "  -> 或者手动移除旧版本: npm uninstall -g @qwen-code/qwen-code"
  echo ""
fi

if [ "${NEED_SUDO}" = true ]; then
  echo "  -> 需要 sudo 权限写入 ${SYMLINK_DIR}"
  sudo ln -sf "${INSTALL_DIR}/bin/qwen" "${SYMLINK_PATH}"
else
  ln -sf "${INSTALL_DIR}/bin/qwen" "${SYMLINK_PATH}"
fi

echo "  -> symlink: ${SYMLINK_PATH} -> ${INSTALL_DIR}/bin/qwen"

# ============================= 验证 ============================
echo "[3/3] 验证安装..."

# 检查 symlink 是否生效
RESOLVED_QWEN="$(which qwen 2>/dev/null || true)"
if [ -n "${RESOLVED_QWEN}" ]; then
  echo "  -> qwen 命令位置: ${RESOLVED_QWEN}"

  # 尝试运行 --version
  if "${INSTALL_DIR}/bin/qwen" --version 2>/dev/null; then
    echo "  -> 版本验证通过"
  else
    echo "  -> 注意: --version 验证跳过（目标平台可能不同）"
  fi
else
  echo "  -> WARNING: qwen 未在 PATH 中找到"
  echo "  -> 请手动添加: export PATH=\"${SYMLINK_DIR}:\$PATH\""
fi

# 清理过期备份（只保留最近 3 个）
BACKUP_COUNT=$(ls -d "${INSTALL_DIR}.backup."* 2>/dev/null | wc -l | tr -d ' ')
if [ "${BACKUP_COUNT}" -gt 3 ]; then
  echo "  -> 清理旧备份（保留最近 3 个）..."
  ls -dt "${INSTALL_DIR}.backup."* | tail -n +4 | xargs rm -rf
fi

echo ""
echo "============================================"
echo "  安装完成!"
echo "============================================"
echo ""
echo "  安装目录: ${INSTALL_DIR}"
echo "  命令路径: ${SYMLINK_PATH}"
echo ""
echo "  运行: qwen"
echo ""
echo "  更新: 重新执行本脚本即可覆盖安装"
echo "    bash $0 <新版本 tarball>"
echo ""

# 如果原有 npm 版本还在，给出提示
if [ -n "${EXISTING_QWEN}" ] && [ "${EXISTING_QWEN}" != "${SYMLINK_PATH}" ]; then
  echo "  提示: 检测到旧的 npm 安装版本仍然存在"
  echo "  如果 standalone 版本工作正常，可以移除 npm 版本:"
  echo "    npm uninstall -g @qwen-code/qwen-code"
  echo ""
fi
