#!/bin/bash

# Quebec Electrical Agents - Electron Quick Start
# Runs the Electron desktop application

set -e

echo "⚡ Starting Quebec Electrical Agents - Electron Edition"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Are you in the correct directory?"
    echo "   Run this script from: packages/quebec-electrical-agents-electron/"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Dependencies not installed. Running npm install..."
    npm install
    echo ""
fi

# Check if Qwen Code CLI is installed
if ! command -v qwen &> /dev/null; then
    echo "⚠️  Warning: Qwen Code CLI not found!"
    echo ""
    echo "The application requires Qwen Code CLI to function."
    echo "Install it with:"
    echo ""
    echo "    npm install -g @qwen-code/qwen-code@latest"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Start the application
echo "🚀 Launching application..."
echo ""
npm start
