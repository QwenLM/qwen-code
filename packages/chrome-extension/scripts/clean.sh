#!/bin/bash

# Clean up build artifacts and temporary files for Chrome Extension

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Cleaning up Chrome Extension build artifacts..."

# Remove any dist directories and zips
rm -rf dist/
rm -rf "$ROOT_DIR/native-host/dist/"
rm -f "$ROOT_DIR/native-host/tsconfig.tsbuildinfo"
rm -f chrome-extension.zip

# Remove log files
rm -f "$HOME/.qwen/chrome-bridge/qwen-bridge-host.log"
rm -f /tmp/qwen-bridge-host.log
rm -f /tmp/qwen-server.log

# Remove saved extension ID (new unified path + legacy paths)
rm -f "$ROOT_DIR/.extension-id"
rm -f "$SCRIPT_DIR/.extension-id"
rm -f "$SCRIPT_DIR/../native-host/.extension-id"

echo "Cleanup complete!"
