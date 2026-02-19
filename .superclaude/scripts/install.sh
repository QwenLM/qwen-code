#!/bin/bash
# SuperClaude Framework Installation Script
# This script installs SuperClaude in an isolated virtual environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$SCRIPT_DIR/venv"

echo "🔧 Installing SuperClaude Framework (isolated)..."
echo "================================================"

# Check if Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    exit 1
fi

echo "✓ Python found: $(python3 --version)"

# Create virtual environment if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    echo "✓ Virtual environment created at: $VENV_DIR"
else
    echo "✓ Virtual environment already exists"
fi

# Activate virtual environment
echo "🔄 Activating virtual environment..."
source "$VENV_DIR/bin/activate"

# Upgrade pip
echo "📦 Upgrading pip..."
pip install --upgrade pip --quiet

# Install SuperClaude
echo "🚀 Installing SuperClaude Framework..."
pip install superclaude --quiet

# Verify installation
if command -v superclaude &> /dev/null; then
    VERSION=$(superclaude --version 2>&1 || echo "unknown")
    echo "✓ SuperClaude installed: $VERSION"
else
    echo "❌ SuperClaude installation failed"
    exit 1
fi

# Install slash commands
echo "📋 Installing SuperClaude slash commands..."
superclaude install 2>/dev/null || echo "⚠️  Command installation skipped (may require Claude Code restart)"

echo ""
echo "================================================"
echo "✅ SuperClaude Framework installation complete!"
echo ""
echo "To activate SuperClaude in your shell:"
echo "  source .superclaude/scripts/activate.sh"
echo ""
echo "To use in Claude Code:"
echo "  1. Restart Claude Code"
echo "  2. Commands like /sc:plan, /sc:implement will be available"
echo ""
echo "To deactivate:"
echo "  source .superclaude/scripts/deactivate.sh"
echo "================================================"
