#!/bin/bash
# Generate app icons for all platforms from a source PNG
# Usage: ./generate-icons.sh source.png

set -e

SOURCE="${1:-source.png}"

if [ ! -f "$SOURCE" ]; then
    echo "Error: Source file '$SOURCE' not found"
    echo "Usage: ./generate-icons.sh source.png"
    exit 1
fi

echo "Generating icons from: $SOURCE"

# Create temporary iconset directory for macOS
ICONSET="icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Generate all sizes for macOS iconset
echo "Generating macOS iconset..."
sips -z 16 16 "$SOURCE" --out "$ICONSET/icon_16x16.png" > /dev/null
sips -z 32 32 "$SOURCE" --out "$ICONSET/icon_16x16@2x.png" > /dev/null
sips -z 32 32 "$SOURCE" --out "$ICONSET/icon_32x32.png" > /dev/null
sips -z 64 64 "$SOURCE" --out "$ICONSET/icon_32x32@2x.png" > /dev/null
sips -z 128 128 "$SOURCE" --out "$ICONSET/icon_128x128.png" > /dev/null
sips -z 256 256 "$SOURCE" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
sips -z 256 256 "$SOURCE" --out "$ICONSET/icon_256x256.png" > /dev/null
sips -z 512 512 "$SOURCE" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
sips -z 512 512 "$SOURCE" --out "$ICONSET/icon_512x512.png" > /dev/null
sips -z 1024 1024 "$SOURCE" --out "$ICONSET/icon_512x512@2x.png" > /dev/null

# Generate .icns for macOS
echo "Creating icon.icns..."
iconutil -c icns "$ICONSET" -o icon.icns

# Generate icon.png for Linux (512x512)
echo "Creating icon.png for Linux..."
sips -z 512 512 "$SOURCE" --out icon.png > /dev/null

# Generate icon.ico for Windows using ImageMagick (if available)
# If not, we'll create individual PNGs that can be converted online
if command -v convert &> /dev/null; then
    echo "Creating icon.ico for Windows..."
    # Create multiple sizes for ICO
    sips -z 16 16 "$SOURCE" --out icon_16.png > /dev/null
    sips -z 24 24 "$SOURCE" --out icon_24.png > /dev/null
    sips -z 32 32 "$SOURCE" --out icon_32.png > /dev/null
    sips -z 48 48 "$SOURCE" --out icon_48.png > /dev/null
    sips -z 64 64 "$SOURCE" --out icon_64.png > /dev/null
    sips -z 128 128 "$SOURCE" --out icon_128.png > /dev/null
    sips -z 256 256 "$SOURCE" --out icon_256.png > /dev/null

    convert icon_16.png icon_24.png icon_32.png icon_48.png icon_64.png icon_128.png icon_256.png icon.ico

    # Clean up temp files
    rm -f icon_16.png icon_24.png icon_32.png icon_48.png icon_64.png icon_128.png icon_256.png
else
    echo "Warning: ImageMagick not installed. Skipping .ico generation."
    echo "Install with: brew install imagemagick"
    echo "Or use an online converter with the 256x256 PNG."
fi

# Clean up iconset directory
rm -rf "$ICONSET"

echo ""
echo "✅ Icons generated:"
ls -la icon.*

echo ""
echo "Next steps:"
echo "1. Update apps/electron/src/main/index.ts to use icon.icns on macOS"
echo "2. Run: bun run electron:build:resources"
