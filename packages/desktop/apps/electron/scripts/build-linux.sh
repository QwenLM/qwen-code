#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="x64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false

show_help() {
    cat << EOF
Usage: build-linux.sh [x64|arm64] [--upload] [--latest] [--script]

Arguments:
  x64|arm64    Target architecture (default: x64)
  --upload     Upload AppImage to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)

Environment variables (from .env or environment):
  QWEN_CODE_VERSION         - Optional npm version for bundled Qwen Code
                              (unset = build from current checkout)
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        x64|arm64)     ARCH="$1"; shift ;;
        --upload)      UPLOAD=true; shift ;;
        --latest)      UPLOAD_LATEST=true; shift ;;
        --script)      UPLOAD_SCRIPT=true; shift ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# Configuration
BUN_VERSION="bun-v1.3.9"  # Pinned version for reproducible builds

echo "=== Building Qwen Code Desktop AppImage (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
rm -rf "$ELECTRON_DIR/vendor"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
bun install

# 3. Download Bun binary with checksum verification
echo "Downloading Bun ${BUN_VERSION} for linux-${ARCH}..."
mkdir -p "$ELECTRON_DIR/vendor/bun"

# Map architecture names (electron uses x64/arm64, bun uses x64/aarch64)
if [ "$ARCH" = "arm64" ]; then
    BUN_DOWNLOAD="bun-linux-aarch64"
else
    BUN_DOWNLOAD="bun-linux-x64-baseline"
fi

# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Download binary and checksums
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
# Use sha256sum on Linux (not shasum)
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | sha256sum -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# 4. Vendor Qwen Code CLI package
echo "Vendoring Qwen Code CLI..."
cd "$ROOT_DIR"
bun run scripts/vendor-qwen-code.ts

# 5. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
bun run electron:build

# 6. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# Run electron-builder
# Note: electron-builder may build both archs due to config, but we only use the requested one
npx electron-builder --linux --${ARCH}

# 9. Verify the AppImage was built
# electron-builder uses Linux-style arch names: x86_64 for x64, aarch64 for arm64
if [ "$ARCH" = "x64" ]; then
    LINUX_ARCH="x86_64"
else
    LINUX_ARCH="aarch64"
fi

# electron-builder outputs: Qwen-Code-Desktop-x86_64.AppImage or Qwen-Code-Desktop-aarch64.AppImage
BUILT_APPIMAGE_NAME="Qwen-Code-Desktop-${LINUX_ARCH}.AppImage"
BUILT_APPIMAGE_PATH="$ELECTRON_DIR/release/$BUILT_APPIMAGE_NAME"

if [ ! -f "$BUILT_APPIMAGE_PATH" ]; then
    echo "ERROR: Expected AppImage not found at $BUILT_APPIMAGE_PATH"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

# Rename to our standard naming convention: Qwen-Code-Desktop-x64.AppImage, Qwen-Code-Desktop-arm64.AppImage
APPIMAGE_NAME="Qwen-Code-Desktop-${ARCH}.AppImage"
APPIMAGE_PATH="$ELECTRON_DIR/release/$APPIMAGE_NAME"
mv "$BUILT_APPIMAGE_PATH" "$APPIMAGE_PATH"
echo "Renamed $BUILT_APPIMAGE_NAME -> $APPIMAGE_NAME"

echo ""
echo "=== Build Complete ==="
echo "AppImage: $ELECTRON_DIR/release/${APPIMAGE_NAME}"
echo "Size: $(du -h "$ELECTRON_DIR/release/${APPIMAGE_NAME}" | cut -f1)"

# 10. Create manifest.json for upload script
# Read version from package.json
ELECTRON_VERSION=$(cat "$ELECTRON_DIR/package.json" | grep '"version"' | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "Creating manifest.json (version: $ELECTRON_VERSION)..."
mkdir -p "$ROOT_DIR/.build/upload"
echo "{\"version\": \"$ELECTRON_VERSION\"}" > "$ROOT_DIR/.build/upload/manifest.json"

# 11. Upload to S3 (if --upload flag is set)
if [ "$UPLOAD" = true ]; then
    echo ""
    echo "=== Uploading to S3 ==="

    # Check for S3 credentials
    if [ -z "$S3_VERSIONS_BUCKET_ENDPOINT" ] || [ -z "$S3_VERSIONS_BUCKET_ACCESS_KEY_ID" ] || [ -z "$S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY" ]; then
        cat << EOF
ERROR: Missing S3 credentials. Set these environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY

You can add them to .env or export them directly.
EOF
        exit 1
    fi

    # Build upload flags
    UPLOAD_FLAGS="--electron"
    [ "$UPLOAD_LATEST" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --latest"
    [ "$UPLOAD_SCRIPT" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --script"

    cd "$ROOT_DIR"
    bun run scripts/upload.ts $UPLOAD_FLAGS

    echo ""
    echo "=== Upload Complete ==="
fi
