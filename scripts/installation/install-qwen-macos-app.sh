#!/bin/bash

# Qwen Code macOS Desktop App Installation Script
# Installs Qwen Code as a native macOS desktop application
#
# Usage: bash install-qwen-macos-app.sh [--auto]
#
# Options:
#   --auto    Non-interactive mode, skip prompts and install directly
#
# This script is designed to be run after installing qwen-code via
# the main installation script, or standalone if qwen is already installed.

# Re-execute with bash if running with sh
if [ -z "${BASH_VERSION}" ]; then
    if command -v bash >/dev/null 2>&1; then
        exec bash -- "${0}" "$@"
    else
        echo "Error: This script requires bash."
        exit 1
    fi
fi

set -eo pipefail

# ============================================
# Color definitions
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}❌ $1${NC}"; }

# ============================================
# Parse arguments
# ============================================
AUTO_MODE=false
for arg in "$@"; do
    case "$arg" in
        --auto) AUTO_MODE=true ;;
    esac
done

# ============================================
# Configuration
# ============================================
APP_NAME="Qwen Code"
APP_PATH="/Applications/${APP_NAME}.app"

# Icon path: bundled alongside this script in the repository
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICON_PATH="${SCRIPT_DIR}/qwen-icon.png"

# ============================================
# Pre-flight checks
# ============================================
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║   Qwen Code — macOS Desktop App Installer                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
    log_error "This script only supports macOS."
    exit 1
fi

# Check qwen is installed
if ! command -v qwen &>/dev/null; then
    log_error "qwen CLI is not installed."
    echo ""
    echo "Please install qwen-code first:"
    echo "  bash -c \"\$(curl -fsSL ${ASSETS_BASE}/installation/install-qwen.sh)\""
    echo ""
    exit 1
fi

QWEN_VERSION=$(qwen --version 2>/dev/null || echo "unknown")
log_info "Detected qwen version: ${QWEN_VERSION}"

# Check if app already exists
APP_ALREADY_INSTALLED=false
if [ -d "$APP_PATH" ]; then
    APP_ALREADY_INSTALLED=true
    log_warning "Qwen Code.app already exists in /Applications."
fi

# ============================================
# Interactive prompt (skip in auto mode)
# ============================================
if [ "$AUTO_MODE" = false ]; then
    echo ""
    echo "This will install a desktop app that lets you launch Qwen Code"
    echo "from Spotlight (Cmd+Space), Launchpad, or the Applications folder."
    echo ""
    
    if [ "$APP_ALREADY_INSTALLED" = true ]; then
        read -p "Reinstall Qwen Code.app? (y/N) " -n 1 -r
    else
        read -p "Continue? (Y/n) " -n 1 -r
    fi
    echo
    
    if [ "$APP_ALREADY_INSTALLED" = true ]; then
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Aborted."
            exit 0
        fi
    else
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            echo "Aborted."
            exit 0
        fi
    fi
fi

# ============================================
# Remove existing app if reinstalling
# ============================================
if [ -d "$APP_PATH" ]; then
    rm -rf "$APP_PATH"
    log_info "Removed existing Qwen Code.app"
fi

# ============================================
# Build the app
# ============================================
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
log_info "Building Qwen Code.app..."

# Create AppleScript source
cat > "${TMP_DIR}/QwenCode.applescript" << 'APPLESCRIPT'
tell application "Terminal"
    activate
    do script "qwen"
end tell
APPLESCRIPT

# Compile to .app
osacompile -o "${TMP_DIR}/${APP_NAME}.app" "${TMP_DIR}/QwenCode.applescript" 2>/dev/null

# ============================================
# Install icon
# ============================================
log_info "Applying Qwen icon..."

if [ -f "$ICON_PATH" ]; then
    # Create iconset for multi-resolution support
    ICONSET_DIR="${TMP_DIR}/qwen-icon.iconset"
    mkdir -p "$ICONSET_DIR"
    
    sips -z 16 16   "$ICON_PATH" --out "${ICONSET_DIR}/icon_16x16.png"       >/dev/null 2>&1
    sips -z 32 32   "$ICON_PATH" --out "${ICONSET_DIR}/icon_16x16@2x.png"     >/dev/null 2>&1
    sips -z 32 32   "$ICON_PATH" --out "${ICONSET_DIR}/icon_32x32.png"        >/dev/null 2>&1
    sips -z 64 64   "$ICON_PATH" --out "${ICONSET_DIR}/icon_32x32@2x.png"     >/dev/null 2>&1
    sips -z 128 128 "$ICON_PATH" --out "${ICONSET_DIR}/icon_128x128.png"      >/dev/null 2>&1
    sips -z 256 256 "$ICON_PATH" --out "${ICONSET_DIR}/icon_128x128@2x.png"   >/dev/null 2>&1
    sips -z 256 256 "$ICON_PATH" --out "${ICONSET_DIR}/icon_256x256.png"      >/dev/null 2>&1
    sips -z 512 512 "$ICON_PATH" --out "${ICONSET_DIR}/icon_256x256@2x.png"   >/dev/null 2>&1
    sips -z 512 512 "$ICON_PATH" --out "${ICONSET_DIR}/icon_512x512.png"      >/dev/null 2>&1
    cp "$ICON_PATH" "${ICONSET_DIR}/icon_512x512@2x.png"
    
    # Convert to ICNS
    iconutil -c icns "$ICONSET_DIR" -o "${TMP_DIR}/qwen-icon.icns" 2>/dev/null
    
    # Replace app icon
    cp "${TMP_DIR}/qwen-icon.icns" "${TMP_DIR}/${APP_NAME}.app/Contents/Resources/applet.icns"
    log_success "Icon applied from bundled qwen-icon.png"
else
    log_warning "Icon file not found at ${ICON_PATH}, using default AppleScript icon"
fi

# ============================================
# Install to /Applications
# ============================================
cp -R "${TMP_DIR}/${APP_NAME}.app" "/Applications/"
log_success "Installed to: ${APP_PATH}"

# ============================================
# Post-install: refresh icon cache
# ============================================
rm ~/Library/Application\ Support/Dock/*.db 2>/dev/null || true
killall Dock 2>/dev/null || true

# ============================================
# Summary
# ============================================
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ✨  Qwen Code Desktop App installed successfully!         ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Launch methods:${NC}"
echo "  • Spotlight:  Cmd + Space → type 'Qwen Code' → Enter"
echo "  • Launchpad:  Find the 'Qwen Code' icon"
echo "  • Finder:     Open /Applications/Qwen Code.app"
echo ""
echo -e "${BLUE}What it does:${NC}"
echo "  Opens Terminal and automatically runs the 'qwen' command."
echo ""
echo -e "${BLUE}Uninstall:${NC}"
echo "  rm -rf '/Applications/Qwen Code.app'"
echo ""
