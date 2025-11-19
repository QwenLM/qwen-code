#!/bin/bash

# Quebec Electrical Agents - Electron App Installation Script
# This script automates the installation process

set -e

echo "🚀 Quebec Electrical Agents - Electron Installation"
echo "=================================================="
echo ""

# Check Node.js
echo "📋 Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version must be 20 or higher. Current: $(node -v)"
    exit 1
fi
echo "✅ Node.js $(node -v) detected"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed"
    exit 1
fi
echo "✅ npm $(npm -v) detected"

# Check Qwen Code CLI
echo ""
echo "📋 Checking Qwen Code CLI..."
if ! command -v qwen &> /dev/null; then
    echo "⚠️  Qwen Code CLI not found"
    echo ""
    read -p "Install Qwen Code CLI globally? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Installing Qwen Code CLI..."
        npm install -g @qwen-code/qwen-code@latest
        echo "✅ Qwen Code CLI installed"
    else
        echo "⚠️  Continuing without Qwen Code CLI"
        echo "   You can install it later with: npm install -g @qwen-code/qwen-code@latest"
    fi
else
    echo "✅ Qwen Code CLI $(qwen --version 2>&1 | head -1) detected"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create necessary directories
echo ""
echo "📁 Creating directories..."
mkdir -p uploads/photos uploads/plans

echo ""
echo "✅ Installation complete!"
echo ""
echo "📚 Next steps:"
echo "   1. Start the app: npm start"
echo "   2. Or dev mode: npm run dev"
echo "   3. Build executable: npm run build"
echo ""
echo "📖 Read README.md for detailed usage instructions"
echo ""
