#!/bin/bash
# Activate SuperClaude Framework (isolated environment)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/../venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "❌ Virtual environment not found."
    echo "Run: source .superclaude/scripts/install.sh"
    return 1 2>/dev/null || exit 1
fi

# Activate the virtual environment
source "$VENV_DIR/bin/activate"

# Set SuperClaude path
export SUPERCLAUDE_HOME="$SCRIPT_DIR/.."

echo "✅ SuperClaude Framework activated"
echo "   Virtual env: $VENV_DIR"
echo ""
echo "Available commands: /sc:plan, /sc:implement, /sc:test, etc."
echo "To deactivate: source .superclaude/scripts/deactivate.sh"
