#!/bin/bash

# Quebec Electrical Agents - Web App Installation Script
# Installs both FastAPI backend and Next.js frontend

set -e

echo "🚀 Quebec Electrical Agents - Web App Installation"
echo "=================================================="
echo ""

# Check Python
echo "📋 Checking prerequisites..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.10+ first."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d'.' -f1)
PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d'.' -f2)

if [ "$PYTHON_MAJOR" -lt 3 ] || [ "$PYTHON_MINOR" -lt 10 ]; then
    echo "❌ Python version must be 3.10 or higher. Current: $PYTHON_VERSION"
    exit 1
fi
echo "✅ Python $PYTHON_VERSION detected"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version must be 18 or higher. Current: $(node -v)"
    exit 1
fi
echo "✅ Node.js $(node -v) detected"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed"
    exit 1
fi
echo "✅ npm $(npm -v) detected"

# Install backend dependencies
echo ""
echo "📦 Installing backend dependencies (Python)..."
cd backend

# Create virtual environment (optional but recommended)
read -p "Create Python virtual environment? (recommended) (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    echo "✅ Virtual environment created and activated"
fi

pip install -r requirements.txt

if [ $? -eq 0 ]; then
    echo "✅ Backend dependencies installed"
else
    echo "❌ Failed to install backend dependencies"
    exit 1
fi

# Create .env from example
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file (please configure your API keys)"
fi

# Create necessary directories
mkdir -p uploads/photos uploads/plans logs data

cd ..

# Install frontend dependencies
echo ""
echo "📦 Installing frontend dependencies (Node.js)..."
cd frontend

npm install

if [ $? -eq 0 ]; then
    echo "✅ Frontend dependencies installed"
else
    echo "❌ Failed to install frontend dependencies"
    exit 1
fi

# Create .env from example
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created frontend .env file"
fi

cd ..

echo ""
echo "✅ Installation complete!"
echo ""
echo "📚 Next steps:"
echo ""
echo "Backend (Terminal 1):"
echo "   cd backend"
echo "   python main.py"
echo "   → http://localhost:8000"
echo ""
echo "Frontend (Terminal 2):"
echo "   cd frontend"
echo "   npm run dev"
echo "   → http://localhost:3001"
echo ""
echo "📖 Read README.md for detailed usage instructions"
echo ""
