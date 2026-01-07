#!/bin/bash

# Qwen CLI Chrome Extension - Native Host Configuration Updater
# 用于在更换电脑或浏览器后更新Native Host配置

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_NAME="com.qwen.cli.bridge"

echo "==============================================="
echo "Qwen CLI Chrome Extension - Native Host Configuration Updater"
echo "==============================================="
echo ""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macOS"
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="Linux"
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
    echo "Error: Unsupported operating system"
    exit 1
fi

echo "Detected OS: $OS"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js $(node --version) is installed"
echo ""

# Create Native Host directory
echo "Creating Native Host directory..."
mkdir -p "$MANIFEST_DIR"
echo "✓ Directory created: $MANIFEST_DIR"
echo ""

# Check if host.js exists
if [[ ! -f "$SCRIPT_DIR/host.js" ]]; then
    echo "Error: host.js not found in $SCRIPT_DIR"
    exit 1
fi

# Make host.js executable
chmod +x "$SCRIPT_DIR/host.js"
echo "✓ Made host.js executable"
echo ""

# Get extension ID
echo "How would you like to configure the extension?"
echo "1) Use specific extension ID (recommended for production)"
echo "2) Use generic configuration (allows any development extension)"
echo ""
read -p "Choose option (1/2): " CONFIG_OPTION

MANIFEST_FILE="$MANIFEST_DIR/$HOST_NAME.json"

if [[ "$CONFIG_OPTION" == "1" ]]; then
    echo ""
    echo "Please enter your Chrome extension ID:"
    echo "Tip: Find it in chrome://extensions page for Qwen CLI Chrome Extension"
    read -p "Extension ID: " EXTENSION_ID

    if [[ -z "$EXTENSION_ID" ]]; then
        echo "Error: Extension ID is required"
        exit 1
    fi

    # Save extension ID for future use
    echo "$EXTENSION_ID" > "$SCRIPT_DIR/../.extension-id"

    # Create manifest with specific extension ID
    cat > "$MANIFEST_FILE" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$SCRIPT_DIR/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/",
    "chrome-extension://*/"
  ]
}
EOF
    echo ""
    echo "✓ Native Host configured for extension ID: $EXTENSION_ID"
elif [[ "$CONFIG_OPTION" == "2" ]]; then
    # Create manifest with generic configuration
    cat > "$MANIFEST_FILE" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$SCRIPT_DIR/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/"
  ]
}
EOF
    echo ""
    echo "✓ Native Host configured with generic settings (allows any development extension)"
else
    echo "Invalid option"
    exit 1
fi

echo ""
echo "✓ Manifest file created: $MANIFEST_FILE"
echo ""

# Verify configuration
echo "Verifying configuration..."
if [[ -f "$MANIFEST_FILE" ]]; then
    echo "✓ Configuration verified successfully"
    echo ""
    echo "Configuration details:"
    cat "$MANIFEST_FILE"
    echo ""
else
    echo "✗ Configuration verification failed"
    exit 1
fi

echo "==============================================="
echo "✅ Native Host configuration updated successfully!"
echo "==============================================="
echo ""
echo "Next steps:"
echo "1. Restart Chrome if it's running"
echo "2. Navigate to chrome://extensions"
echo "3. Reload the Qwen CLI Chrome Extension extension"
echo "4. Click the extension icon and connect to Qwen CLI"
echo ""
echo "Note: Run this script whenever you:"
echo "  • Switch to a new computer"
echo "  • Change browsers"
echo "  • Reinstall Chrome"
echo "  • Get a new extension ID"
echo ""
