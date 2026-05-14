#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# deploy-qwen.sh
#
# 一键部署 / 升级 qwen-code 到 Linux 服务器。
#
# 全流程：
#   1. 从 OSS 下载指定版本的 bundle 包
#   2. 校验 SHA256
#   3. 解压到安装目录
#   4. 创建 /usr/local/bin/qwen 软链接
#   5. 验证安装
#
# 前提条件：系统已安装 Node.js >= 20
#
# 用法:
#   curl -fsSL <oss_url>/deploy-qwen.sh | bash
#   curl -fsSL <oss_url>/deploy-qwen.sh | bash -s -- --version 0.14.8-dataworks.3
#   bash deploy-qwen.sh --version 0.14.8-dataworks.3
#   bash deploy-qwen.sh --install-dir /opt/qwen-code
#
# 环境变量 (均可通过命令行参数覆盖):
#   QWEN_VERSION      - 版本号（可通过 --version 传入）
#   QWEN_ARCH         - 架构 (amd64|arm64)，默认自动检测
#   QWEN_INSTALL_DIR  - 安装目录，默认 /usr/local/qwen-code
#   QWEN_ARCHIVE      - 已下载的本地 tar.gz 路径，存在时跳过下载
# ──────────────────────────────────────────────────────────
set -euo pipefail

# ── 默认配置 ──
OSS_BUCKET="dataworks-notebook-cn-shanghai"
OSS_HOST="${OSS_BUCKET}.oss-cn-shanghai.aliyuncs.com"
OSS_PREFIX="public-datasets/aone-release/alishu/qwen-code"

VERSION="${QWEN_VERSION:-}"
ARCH="${QWEN_ARCH:-}"
INSTALL_DIR="${QWEN_INSTALL_DIR:-/usr/local/qwen-code}"
ARCHIVE="${QWEN_ARCHIVE:-}"
CREATE_SYMLINK="true"

# ── 解析命令行参数 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      VERSION="$2";      shift 2 ;;
    --arch)         ARCH="$2";         shift 2 ;;
    --install-dir)  INSTALL_DIR="$2";  shift 2 ;;
    --archive)      ARCHIVE="$2";      shift 2 ;;
    --no-symlink)   CREATE_SYMLINK="false"; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \{0,1\}//p }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ── 颜色输出 ──
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi
info()  { echo -e "${GREEN}>>>${NC} $*"; }
warn()  { echo -e "${YELLOW}>>> WARNING:${NC} $*"; }
error() { echo -e "${RED}>>> ERROR:${NC} $*" >&2; }

# ── 检查 Node.js ──
if ! command -v node &>/dev/null; then
  error "Node.js not found. Please install Node.js >= 20 first."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "${NODE_MAJOR}" -lt 20 ]; then
  error "Node.js >= 20 required, current: $(node --version)"
  exit 1
fi
info "Node.js $(node --version) detected"

# ── 自动检测架构 ──
if [ -z "${ARCH}" ]; then
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
      error "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac
fi

echo ""
echo "============================================"
echo "  Qwen Code Deploy"
echo "  Arch:        ${ARCH}"
echo "  Install Dir: ${INSTALL_DIR}"
echo "============================================"
echo ""

# ════════════════════════════════════════════════════════════
# Step 1: 确定版本号
# ════════════════════════════════════════════════════════════
if [ -z "${VERSION}" ]; then
  info "No version specified, fetching latest..."
  LATEST_URL="https://${OSS_HOST}/${OSS_PREFIX}/latest/metadata.json"
  if curl -fsSL --head "${LATEST_URL}" >/dev/null 2>&1; then
    VERSION=$(curl -fsSL "${LATEST_URL}" 2>/dev/null \
      | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
  fi

  if [ -z "${VERSION}" ]; then
    error "Could not discover latest version. Please specify: --version <version>"
    exit 1
  fi
fi

info "Target version: ${VERSION}"

# ── 构造下载 URL ──
TARBALL="qwen-code-${VERSION}-linux-${ARCH}.tar.gz"
DOWNLOAD_URL="https://${OSS_HOST}/${OSS_PREFIX}/${VERSION}/${TARBALL}"
SHA256_URL="https://${OSS_HOST}/${OSS_PREFIX}/${VERSION}/SHA256SUMS"
METADATA_URL="https://${OSS_HOST}/${OSS_PREFIX}/${VERSION}/metadata.json"

RELEASES_DIR="${INSTALL_DIR}/releases"
CURRENT_LINK="${INSTALL_DIR}/current"
PREV_REF=""

TMP_DIR=$(mktemp -d)
ARCHIVE_TMP="${TMP_DIR}/${TARBALL}"
STAGE_DIR="${TMP_DIR}/stage"
trap 'rm -rf "${TMP_DIR}"' EXIT

# ── 检查版本是否存在 ──
if [ -n "${ARCHIVE}" ]; then
  info "Using local archive: ${ARCHIVE}"
  if [ ! -f "${ARCHIVE}" ]; then
    error "Archive not found: ${ARCHIVE}"
    exit 1
  fi
else
  info "Checking version availability..."
  if ! curl -fsSL --head "${DOWNLOAD_URL}" >/dev/null 2>&1; then
    error "Version ${VERSION} not found at ${DOWNLOAD_URL}"
    exit 1
  fi
  info "Version ${VERSION} found"
fi

# ════════════════════════════════════════════════════════════
# Step 2: 下载并校验
# ════════════════════════════════════════════════════════════
echo ""
info "Step 2: Downloading and validating..."

if [ -n "${ARCHIVE}" ]; then
  cp "${ARCHIVE}" "${ARCHIVE_TMP}"
else
  curl -fsSL "${DOWNLOAD_URL}" -o "${ARCHIVE_TMP}"
  info "Downloaded ${TARBALL}"
fi

# SHA256 校验
if curl -fsSL "${SHA256_URL}" -o "${TMP_DIR}/SHA256SUMS" 2>/dev/null; then
  EXPECTED=$(grep "${TARBALL}" "${TMP_DIR}/SHA256SUMS" | awk '{print $1}')
  ACTUAL=$(sha256sum "${ARCHIVE_TMP}" | awk '{print $1}')
  if [ -n "${EXPECTED}" ] && [ "${EXPECTED}" = "${ACTUAL}" ]; then
    info "Checksum verified: ${ACTUAL:0:16}..."
  elif [ -n "${EXPECTED}" ]; then
    error "Checksum mismatch! Expected: ${EXPECTED}, Got: ${ACTUAL}"
    exit 1
  fi
else
  warn "SHA256SUMS not available, skipping checksum verification"
fi

# ════════════════════════════════════════════════════════════
# Step 3: 解压并验证
# ════════════════════════════════════════════════════════════
echo ""
info "Step 3: Extracting and verifying..."

mkdir -p "${STAGE_DIR}"
tar -xzf "${ARCHIVE_TMP}" -C "${STAGE_DIR}" --strip-components=1

chmod +x "${STAGE_DIR}/bin/qwen"

# 验证 qwen 命令能运行
"${STAGE_DIR}/bin/qwen" --version 2>/dev/null \
  && info "qwen verified" \
  || warn "qwen --version check did not succeed (non-fatal for initial install)"

# 下载 metadata 到 staging
curl -fsSL "${METADATA_URL}" -o "${STAGE_DIR}/metadata.json" 2>/dev/null || true

# ════════════════════════════════════════════════════════════
# Step 4: 安装（原子切换）
# ════════════════════════════════════════════════════════════
echo ""
info "Step 4: Installing..."

# 记录旧版本
if [ -L "${CURRENT_LINK}" ]; then
  PREV_REF=$(readlink "${CURRENT_LINK}" || true)
fi

mkdir -p "${RELEASES_DIR}"

NEXT_REF="releases/${VERSION}"
NEXT_DIR="${INSTALL_DIR}/${NEXT_REF}"

if [ -e "${NEXT_DIR}" ]; then
  if [ "${PREV_REF}" = "${NEXT_REF}" ]; then
    PREV_REF="releases/${VERSION}.old.$(date +%Y%m%d%H%M%S)"
    mv "${NEXT_DIR}" "${INSTALL_DIR}/${PREV_REF}"
  else
    rm -rf "${NEXT_DIR}"
  fi
fi

mv "${STAGE_DIR}" "${NEXT_DIR}"

# 原子切换 current symlink
ln -sfn "${NEXT_REF}" "${CURRENT_LINK}"

info "Installed to ${NEXT_DIR}"

# ════════════════════════════════════════════════════════════
# Step 5: 创建全局软链接
# ════════════════════════════════════════════════════════════
if [ "${CREATE_SYMLINK}" = "true" ]; then
  echo ""
  info "Step 5: Creating symlinks..."

  QWEN_BIN="${CURRENT_LINK}/bin/qwen"

  # 查找所有已存在的 qwen 命令并逐个替换
  ALL_QWEN_PATHS=""
  if command -v qwen &>/dev/null; then
    ALL_QWEN_PATHS=$(which -a qwen 2>/dev/null || true)
  fi

  # 确保 /usr/local/bin 在列表中
  if ! echo "${ALL_QWEN_PATHS}" | grep -qx "/usr/local/bin/qwen"; then
    ALL_QWEN_PATHS="/usr/local/bin/qwen
${ALL_QWEN_PATHS}"
  fi

  STANDALONE_TARGET="${INSTALL_DIR}/current/bin/qwen"

  echo "${ALL_QWEN_PATHS}" | while IFS= read -r OLD_PATH; do
    [ -z "${OLD_PATH}" ] && continue

    OLD_DIR=$(dirname "${OLD_PATH}")

    # 如果已经是指向当前版本的 symlink，跳过
    if [ -L "${OLD_PATH}" ]; then
      LINK_TARGET=$(readlink -f "${OLD_PATH}" 2>/dev/null || true)
      EXPECTED_TARGET=$(readlink -f "${STANDALONE_TARGET}" 2>/dev/null || true)
      if [ "${LINK_TARGET}" = "${EXPECTED_TARGET}" ]; then
        info "Already up to date: ${OLD_PATH}"
        continue
      fi
    fi

    # 检查目录是否可写
    if [ ! -w "${OLD_DIR}" ]; then
      warn "No write permission, skipping: ${OLD_PATH}"
      continue
    fi

    # 备份旧文件（非 symlink 才备份）
    if [ -f "${OLD_PATH}" ] && [ ! -L "${OLD_PATH}" ]; then
      mv "${OLD_PATH}" "${OLD_PATH}.old-backup" 2>/dev/null || true
      info "Backed up: ${OLD_PATH} -> ${OLD_PATH}.old-backup"
    fi

    # 创建 symlink
    ln -sf "${STANDALONE_TARGET}" "${OLD_PATH}" 2>/dev/null \
      && info "Linked: ${OLD_PATH} -> ${STANDALONE_TARGET}" \
      || warn "Failed to link: ${OLD_PATH}"
  done

  # metadata 软链接便于升级脚本读取
  ln -sfn "current/metadata.json" "${INSTALL_DIR}/metadata.json" 2>/dev/null || true

  hash -r 2>/dev/null || true
fi

# ════════════════════════════════════════════════════════════
# 完成
# ════════════════════════════════════════════════════════════
echo ""
echo "============================================"
echo "  Qwen Code Deploy Complete"
echo ""
echo "  Version:  ${VERSION}"
echo "  Arch:     ${ARCH}"
echo "  Node.js:  $(node --version)"
echo "  Binary:   ${INSTALL_DIR}/current/bin/qwen"
echo ""
echo "  Usage:"
echo "    qwen                   # if /usr/local/bin is in PATH"
echo "    ${INSTALL_DIR}/current/bin/qwen"
echo ""
echo "  Upgrade:"
echo "    curl -fsSL https://${OSS_HOST}/${OSS_PREFIX}/upgrade-qwen.sh | bash"
echo ""
if [ -n "${PREV_REF}" ] && [ "${PREV_REF}" != "${NEXT_REF}" ]; then
echo "  Rollback to previous:"
echo "    ln -sfn ${PREV_REF} ${CURRENT_LINK}"
echo ""
fi

# 检查最终生效的 qwen 是否是新版本
FINAL_QWEN="$(command -v qwen 2>/dev/null || true)"
if [ -n "${FINAL_QWEN}" ]; then
  FINAL_REAL="$(readlink -f "${FINAL_QWEN}" 2>/dev/null || echo "${FINAL_QWEN}")"
  EXPECTED_REAL="$(readlink -f "${INSTALL_DIR}/current/bin/qwen" 2>/dev/null || true)"
  if [ "${FINAL_REAL}" != "${EXPECTED_REAL}" ]; then
    echo "  WARNING: qwen still points to old version!"
    echo "     Current: ${FINAL_QWEN} -> ${FINAL_REAL}"
    echo "     Expected: ${EXPECTED_REAL}"
    echo ""
    echo "  Fix:"
    echo "    npm uninstall -g @qwen-code/qwen-code && hash -r"
    echo ""
  fi
fi
echo "============================================"
