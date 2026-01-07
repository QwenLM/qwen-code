#!/bin/bash

# Build script for Chrome extension package

echo "Building Chrome Qwen Bridge..."

# Ensure we're in the right directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create dist directory
mkdir -p dist

# Copy extension files to dist
echo "Copying extension files..."
cp -r extension dist/

# Create a zip file for Chrome Web Store
echo "Creating extension package..."
cd dist
zip -r ../chrome-extension.zip extension/
cd ..

echo "✅ Build complete!"
echo "   Extension package: chrome-extension.zip"
echo "   Extension files: dist/extension/"
