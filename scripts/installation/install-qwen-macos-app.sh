#!/bin/bash
# install-qwen-macos-app.sh - Install Qwen Code as a macOS Desktop Application
# Usage: bash install-qwen-macos-app.sh

set -e

APP_NAME="Qwen Code"
APP_PATH="/Applications/${APP_NAME}.app"
ICON_URL="https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/icons/qwen-icon.png"
TMP_DIR=$(mktemp -d)

echo "🚀 Installing Qwen Code as a macOS Desktop Application..."

# Check if qwen is installed
if ! command -v qwen &> /dev/null; then
    echo "❌ Error: qwen CLI is not installed."
    echo "   Please install qwen first: https://github.com/QwenLM/qwen-code"
    echo "   Or run: brew install qwen-code"
    exit 1
fi

# Check if app already exists
if [ -d "$APP_PATH" ]; then
    echo "⚠️  Qwen Code.app already exists in /Applications."
    read -p "Do you want to reinstall? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
    rm -rf "$APP_PATH"
    echo "🗑️  Removed existing Qwen Code.app"
fi

# Create AppleScript
cat > "${TMP_DIR}/QwenCode.applescript" << 'EOF'
tell application "Terminal"
    activate
    do script "qwen"
end tell
EOF

# Compile AppleScript to .app
echo "📦 Building Qwen Code.app..."
osacompile -o "${TMP_DIR}/${APP_NAME}.app" "${TMP_DIR}/QwenCode.applescript" 2>/dev/null

# Download icon if possible
echo "🎨 Downloading Qwen icon..."
ICON_TMP="${TMP_DIR}/qwen-icon.png"
if curl -fsSL "$ICON_URL" -o "$ICON_TMP" 2>/dev/null; then
    # Convert PNG to ICNS
    ICONSET_DIR="${TMP_DIR}/qwen-icon.iconset"
    mkdir -p "$ICONSET_DIR"
    
    sips -z 16 16 "$ICON_TMP" --out "${ICONSET_DIR}/icon_16x16.png" >/dev/null 2>&1
    sips -z 32 32 "$ICON_TMP" --out "${ICONSET_DIR}/icon_16x16@2x.png" >/dev/null 2>&1
    sips -z 32 32 "$ICON_TMP" --out "${ICONSET_DIR}/icon_32x32.png" >/dev/null 2>&1
    sips -z 64 64 "$ICON_TMP" --out "${ICONSET_DIR}/icon_32x32@2x.png" >/dev/null 2>&1
    sips -z 128 128 "$ICON_TMP" --out "${ICONSET_DIR}/icon_128x128.png" >/dev/null 2>&1
    sips -z 256 256 "$ICON_TMP" --out "${ICONSET_DIR}/icon_128x128@2x.png" >/dev/null 2>&1
    sips -z 256 256 "$ICON_TMP" --out "${ICONSET_DIR}/icon_256x256.png" >/dev/null 2>&1
    sips -z 512 512 "$ICON_TMP" --out "${ICONSET_DIR}/icon_256x256@2x.png" >/dev/null 2>&1
    sips -z 512 512 "$ICON_TMP" --out "${ICONSET_DIR}/icon_512x512.png" >/dev/null 2>&1
    cp "$ICON_TMP" "${ICONSET_DIR}/icon_512x512@2x.png"
    
    iconutil -c icns "$ICONSET_DIR" -o "${TMP_DIR}/qwen-icon.icns" 2>/dev/null
    
    # Replace app icon
    cp "${TMP_DIR}/qwen-icon.icns" "${TMP_DIR}/${APP_NAME}.app/Contents/Resources/applet.icns"
    echo "✅ Icon installed successfully"
else
    echo "⚠️  Could not download icon, using default"
fi

# Move to Applications
cp -R "${TMP_DIR}/${APP_NAME}.app" "/Applications/"
echo "📍 Installed to: $APP_PATH"

# Clean up
rm -rf "$TMP_DIR"

echo ""
echo "✨ Qwen Code Desktop App installed successfully!"
echo ""
echo "Usage:"
echo "  - Spotlight: Press Cmd+Space, type 'Qwen Code'"
echo "  - Launchpad: Find 'Qwen Code' icon"
echo "  - Applications: Open /Applications/Qwen Code.app"
echo ""
echo "Uninstall:"
echo "  rm -rf '/Applications/Qwen Code.app'"
