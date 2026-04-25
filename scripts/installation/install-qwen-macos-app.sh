#!/bin/bash

# Qwen Code macOS Desktop App Installation Script
#
# Usage: bash install-qwen-macos-app.sh [--auto]
#
# Options:
#   --auto    Non-interactive mode, skip prompts and install directly
#
# This script is designed to be run after installing qwen-code via
# the main installation script, or standalone if qwen is already installed.

if [ -z "${BASH_VERSION}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash -- "${0}" "$@"
  else
    echo "Error: This script requires bash."
    exit 1
  fi
fi

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

AUTO_MODE=false
for arg in "$@"; do
  case "$arg" in
    --auto) AUTO_MODE=true ;;
  esac
done

APP_NAME='Qwen Code'
SYSTEM_APP_DIR='/Applications'
USER_APP_DIR="${HOME}/Applications"
SYSTEM_APP_PATH="${SYSTEM_APP_DIR}/${APP_NAME}.app"
USER_APP_PATH="${USER_APP_DIR}/${APP_NAME}.app"
INSTALL_URL='https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh'
ICON_URL='https://raw.githubusercontent.com/QwenLM/qwen-code/main/scripts/installation/qwen-icon.png'

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
LOCAL_ICON_PATH=""
if [ -n "${SCRIPT_DIR}" ]; then
  LOCAL_ICON_PATH="${SCRIPT_DIR}/qwen-icon.png"
fi

echo -e "${CYAN}"
echo '╔═══════════════════════════════════════════════════════════╗'
echo '║   Qwen Code — macOS Desktop App Installer                ║'
echo '╚═══════════════════════════════════════════════════════════╝'
echo -e "${NC}"

if [[ "$(uname)" != 'Darwin' ]]; then
  log_error 'This script only supports macOS.'
  exit 1
fi

if ! command -v qwen >/dev/null 2>&1; then
  log_error 'qwen CLI is not installed.'
  echo ''
  echo 'Please install qwen-code first:'
  echo "  bash -c \"\$(curl -fsSL ${INSTALL_URL})\""
  echo ''
  exit 1
fi

QWEN_VERSION="$(qwen --version 2>/dev/null || echo 'unknown')"
log_info "Detected qwen version: ${QWEN_VERSION}"

existing_app_path=''
if [ -d "${SYSTEM_APP_PATH}" ]; then
  existing_app_path="${SYSTEM_APP_PATH}"
elif [ -d "${USER_APP_PATH}" ]; then
  existing_app_path="${USER_APP_PATH}"
fi

if [ -n "${existing_app_path}" ]; then
  log_warning "${APP_NAME}.app already exists at ${existing_app_path}"
fi

if [ "${AUTO_MODE}" = false ]; then
  echo ''
  echo 'This will install a desktop app that lets you launch Qwen Code'
  echo 'from Spotlight (Cmd+Space), Launchpad, or the Applications folder.'
  echo ''

  if [ -n "${existing_app_path}" ]; then
    read -r -p "Reinstall ${APP_NAME}.app? (y/N) " -n 1 REPLY
  else
    read -r -p 'Continue? (Y/n) ' -n 1 REPLY
  fi
  echo

  if [ -n "${existing_app_path}" ]; then
    [[ ! ${REPLY:-} =~ ^[Yy]$ ]] && {
      echo 'Aborted.'
      exit 0
    }
  else
    [[ ${REPLY:-} =~ ^[Nn]$ ]] && {
      echo 'Aborted.'
      exit 0
    }
  fi
fi

if [ -d "${SYSTEM_APP_PATH}" ] && [ ! -w "${SYSTEM_APP_DIR}" ]; then
  log_error "${SYSTEM_APP_PATH} already exists, but ${SYSTEM_APP_DIR} is not writable."
  echo ''
  echo "The installer will not fall back to ${USER_APP_DIR} because Spotlight or Launchpad"
  echo "may keep launching the stale system app from ${SYSTEM_APP_PATH}."
  echo ''
  echo 'Please update or remove the existing system app with administrator privileges, then rerun this installer:'
  echo "  sudo rm -rf '${SYSTEM_APP_PATH}'"
  echo ''
  echo "Or reinstall from an account that can write to ${SYSTEM_APP_DIR}."
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo ''
log_info "Building ${APP_NAME}.app..."

cat >"${TMP_DIR}/QwenCode.applescript" <<'APPLESCRIPT'
tell application "Terminal"
    activate
    do script "qwen"
end tell
APPLESCRIPT

osacompile -o "${TMP_DIR}/${APP_NAME}.app" "${TMP_DIR}/QwenCode.applescript" 2>/dev/null

if [ ! -d "${TMP_DIR}/${APP_NAME}.app" ]; then
  log_error 'Failed to build Qwen Code.app'
  exit 1
fi

ICON_PATH=""
if [ -n "${LOCAL_ICON_PATH}" ] && [ -f "${LOCAL_ICON_PATH}" ]; then
  ICON_PATH="${LOCAL_ICON_PATH}"
else
  DOWNLOADED_ICON_PATH="${TMP_DIR}/qwen-icon.png"
  if command -v curl >/dev/null 2>&1 && curl -fsSL "${ICON_URL}" -o "${DOWNLOADED_ICON_PATH}" 2>/dev/null; then
    ICON_PATH="${DOWNLOADED_ICON_PATH}"
  fi
fi

log_info 'Applying Qwen icon...'
if [ -n "${ICON_PATH}" ] && [ -f "${ICON_PATH}" ]; then
  ICONSET_DIR="${TMP_DIR}/qwen-icon.iconset"
  mkdir -p "${ICONSET_DIR}"

  sips -z 16 16 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_16x16.png" >/dev/null 2>&1
  sips -z 32 32 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_16x16@2x.png" >/dev/null 2>&1
  sips -z 32 32 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_32x32.png" >/dev/null 2>&1
  sips -z 64 64 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_32x32@2x.png" >/dev/null 2>&1
  sips -z 128 128 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_128x128.png" >/dev/null 2>&1
  sips -z 256 256 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_128x128@2x.png" >/dev/null 2>&1
  sips -z 256 256 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_256x256.png" >/dev/null 2>&1
  sips -z 512 512 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_256x256@2x.png" >/dev/null 2>&1
  sips -z 512 512 "${ICON_PATH}" --out "${ICONSET_DIR}/icon_512x512.png" >/dev/null 2>&1
  cp "${ICON_PATH}" "${ICONSET_DIR}/icon_512x512@2x.png"

  iconutil -c icns "${ICONSET_DIR}" -o "${TMP_DIR}/qwen-icon.icns" 2>/dev/null
  if [ -f "${TMP_DIR}/qwen-icon.icns" ]; then
    cp "${TMP_DIR}/qwen-icon.icns" "${TMP_DIR}/${APP_NAME}.app/Contents/Resources/applet.icns"
    log_success 'Icon applied'
  else
    log_warning 'Failed to generate .icns icon, using default AppleScript icon'
  fi
else
  log_warning 'Icon file not available, using default AppleScript icon'
fi

if [ -w "${SYSTEM_APP_DIR}" ]; then
  INSTALL_DIR="${SYSTEM_APP_DIR}"
else
  INSTALL_DIR="${USER_APP_DIR}"
  log_warning "No write access to ${SYSTEM_APP_DIR}; falling back to ${USER_APP_DIR}"
fi

APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
mkdir -p "${INSTALL_DIR}"
rm -rf "${APP_PATH}"
cp -R "${TMP_DIR}/${APP_NAME}.app" "${APP_PATH}"
log_success "Installed to: ${APP_PATH}"

echo ''
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ✨  Qwen Code Desktop App installed successfully!         ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ''
echo -e "${BLUE}Launch methods:${NC}"
echo '  • Spotlight:  Cmd + Space → type "Qwen Code" → Enter'
echo '  • Launchpad:  Find the "Qwen Code" icon'
echo "  • Finder:     Open ${APP_PATH}"
echo ''
echo -e "${BLUE}What it does:${NC}"
echo "  Opens Terminal and automatically runs the 'qwen' command."
echo ''
echo -e "${BLUE}Note:${NC}"
echo '  If the icon does not appear immediately, macOS may refresh it after a short delay'
echo '  or after restarting Dock manually.'
echo ''
echo -e "${BLUE}Uninstall:${NC}"
echo "  rm -rf '${APP_PATH}'"
echo ''
