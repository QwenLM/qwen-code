#!/bin/bash

# Quebec Electrical Agents - Web App Quick Start
# Starts both backend (FastAPI) and frontend (Next.js) in parallel

set -e

echo "⚡ Starting Quebec Electrical Agents - Web Application"
echo "=================================================="
echo ""

# Check if we're in the right directory
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo "❌ Error: backend/ or frontend/ directory not found."
    echo "   Run this script from: packages/quebec-electrical-agents/webapp/"
    exit 1
fi

# Check if dependencies are installed
echo "📋 Checking dependencies..."

if [ ! -d "backend/venv" ] && [ ! -f "backend/.venv_not_used" ]; then
    echo "⚠️  Backend virtual environment not found."
    echo "   Run ./install.sh first to install dependencies."
    read -p "Continue without venv? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "⚠️  Frontend dependencies not installed."
    echo "   Run ./install.sh first to install dependencies."
    exit 1
fi

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit
}

trap cleanup EXIT INT TERM

# Start backend
echo ""
echo "🔧 Starting backend (FastAPI)..."
cd backend

if [ -d "venv" ]; then
    source venv/bin/activate
fi

python main.py &
BACKEND_PID=$!

cd ..

# Wait for backend to start
echo "⏳ Waiting for backend to initialize..."
sleep 3

# Start frontend
echo ""
echo "🎨 Starting frontend (Next.js)..."
cd frontend
npm run dev &
FRONTEND_PID=$!

cd ..

echo ""
echo "✅ Services started!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:3001"
echo "  API Docs: http://localhost:8000/docs"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📖 Open http://localhost:3001 in your browser"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for user to press Ctrl+C
wait
