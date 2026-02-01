#!/bin/bash

# Build script for Chrome extension package

echo "Building Chrome Qwen Bridge..."

# Ensure we're in the project root directory (where both scripts/ and extension/ are)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Build latest assets into dist/extension
npm run build

# Create a zip file for Chrome Web Store / unpacked install
echo "Creating extension package..."
cd dist
zip -r ../chrome-extension.zip extension/
cd ..

echo "✅ Build complete!"
echo "   Extension package: chrome-extension.zip"
echo "   Extension files: dist/extension/"
