#!/bin/bash
# Generate app icons for all platforms from a source PNG
# Usage: ./generate-icons.sh source.png [brand-id]

set -e

SOURCE="${1:-source.png}"
BRAND_ID="${2:-qwen-code}"
OUTPUT_DIR="brands/$BRAND_ID"

if [ ! -f "$SOURCE" ]; then
    echo "Error: Source file '$SOURCE' not found"
    echo "Usage: ./generate-icons.sh source.png [brand-id]"
    exit 1
fi

echo "Generating icons from: $SOURCE"
echo "Output brand directory: $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Create temporary iconset directory for macOS
ICONSET="$OUTPUT_DIR/icon.iconset"
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
iconutil -c icns "$ICONSET" -o "$OUTPUT_DIR/icon.icns"

# Generate icon.png for Linux (512x512)
echo "Creating icon.png for Linux..."
sips -z 512 512 "$SOURCE" --out "$OUTPUT_DIR/icon.png" > /dev/null

# Generate icon.ico for Windows using ImageMagick (if available)
# If not, we'll create individual PNGs that can be converted online
if command -v convert &> /dev/null; then
    echo "Creating icon.ico for Windows..."
    # Create multiple sizes for ICO
    sips -z 16 16 "$SOURCE" --out "$OUTPUT_DIR/icon_16.png" > /dev/null
    sips -z 24 24 "$SOURCE" --out "$OUTPUT_DIR/icon_24.png" > /dev/null
    sips -z 32 32 "$SOURCE" --out "$OUTPUT_DIR/icon_32.png" > /dev/null
    sips -z 48 48 "$SOURCE" --out "$OUTPUT_DIR/icon_48.png" > /dev/null
    sips -z 64 64 "$SOURCE" --out "$OUTPUT_DIR/icon_64.png" > /dev/null
    sips -z 128 128 "$SOURCE" --out "$OUTPUT_DIR/icon_128.png" > /dev/null
    sips -z 256 256 "$SOURCE" --out "$OUTPUT_DIR/icon_256.png" > /dev/null

    convert "$OUTPUT_DIR/icon_16.png" "$OUTPUT_DIR/icon_24.png" "$OUTPUT_DIR/icon_32.png" "$OUTPUT_DIR/icon_48.png" "$OUTPUT_DIR/icon_64.png" "$OUTPUT_DIR/icon_128.png" "$OUTPUT_DIR/icon_256.png" "$OUTPUT_DIR/icon.ico"

    # Clean up temp files
    rm -f "$OUTPUT_DIR"/icon_*.png
else
    echo "Warning: ImageMagick not installed. Skipping .ico generation."
    echo "Install with: brew install imagemagick"
    echo "Or use an online converter with the 256x256 PNG."
fi

# Clean up iconset directory
rm -rf "$ICONSET"

echo ""
echo "✅ Icons generated:"
ls -la "$OUTPUT_DIR"/icon.*

echo ""
echo "Next steps:"
echo "1. Ensure BRAND.assets points to resources/brands/$BRAND_ID/"
echo "2. Run: bun run electron:build:resources"
