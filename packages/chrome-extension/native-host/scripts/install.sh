#!/bin/bash

# Qwen CLI Chrome Extension - Native Host Installation Script for macOS/Linux
# This script installs the Native Messaging host for the Chrome extension

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_NAME="com.qwen.cli.bridge"
HOST_SCRIPT="$SCRIPT_DIR/../host.js"

echo "========================================"
echo "Qwen CLI Chrome Extension - Native Host Installer"
echo "========================================"
echo ""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    BROWSER="Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    BROWSER="Chrome"
else
    echo "Error: Unsupported operating system"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if qwen CLI is installed
if ! command -v qwen &> /dev/null; then
    echo "Warning: qwen CLI is not installed"
    echo "Please install qwen CLI to use all features"
    echo "Installation will continue..."
    echo ""
fi

# Create target directory if it doesn't exist
echo "Creating directory: $TARGET_DIR"
mkdir -p "$TARGET_DIR"

# Ensure host script exists and is executable
if [ ! -f "$HOST_SCRIPT" ]; then
    echo "Error: host.js not found at $HOST_SCRIPT"
    exit 1
fi
chmod +x "$HOST_SCRIPT"

# Create the manifest file with the correct path
MANIFEST_FILE="$TARGET_DIR/$HOST_NAME.json"
echo "Creating manifest: $MANIFEST_FILE"

# Get the extension ID (you need to update this after installing the extension)
read -p "Enter your Chrome extension ID (found in chrome://extensions): " EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "Error: Extension ID is required"
    exit 1
fi

# Create the manifest
cat > "$MANIFEST_FILE" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Load the Chrome extension in chrome://extensions"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked' and select: $SCRIPT_DIR/../extension"
echo "4. Copy the extension ID and re-run this script if needed"
echo "5. Click the extension icon and connect to Qwen CLI"
echo ""
echo "Host installed at: $MANIFEST_FILE"
echo "Log file location: /tmp/qwen-bridge-host.log"
echo ""
