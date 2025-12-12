# Quick Start Guide - Web App (5 Minutes) ⚡

Get the Quebec Electrical Agents web application running in 5 minutes!

## Prerequisites (1 minute)

Check you have these installed:

```bash
# Check Python (need 3.10+)
python3 --version

# Check Node.js (need 18+)
node --version

# Check npm
npm --version
```

**Missing Python?**
- [Download Python 3.10+](https://www.python.org/downloads/)

**Missing Node.js?**
- [Download Node.js 18+](https://nodejs.org/)

## Installation (2 minutes)

### Option 1: Automated Install (Recommended)

```bash
cd packages/quebec-electrical-agents/webapp
./install.sh
```

The script will:
- ✅ Check Python and Node.js versions
- ✅ Install backend dependencies (Python packages)
- ✅ Install frontend dependencies (npm packages)
- ✅ Create `.env` files
- ✅ Create necessary directories
- ✅ Optionally create Python virtual environment

### Option 2: Manual Install

```bash
cd packages/quebec-electrical-agents/webapp

# Backend
cd backend
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
cd ..

# Frontend
cd frontend
npm install
cp .env.example .env
cd ..
```

## Run the App (30 seconds)

### Option 1: Quick Start Script (Easiest)

```bash
./start.sh
```

This automatically starts both backend and frontend in parallel!

### Option 2: Manual Start (Two Terminals)

**Terminal 1 - Backend:**
```bash
cd backend
source venv/bin/activate  # If you created one
python main.py
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

## Access the Application

Once running, open your browser:

- **Frontend:** http://localhost:3001
- **Backend API:** http://localhost:8000
- **API Documentation:** http://localhost:8000/docs

## First Steps (1 minute)

### Try These Commands in the Chat:

1. **Basic Query:**
   ```
   What are the main Quebec electrical standards?
   ```

2. **Project Information:**
   ```
   Show me the budget breakdown for all active projects
   ```
   → Dashboard will auto-populate with charts!

3. **Compliance Check:**
   ```
   Verify CEQ section 26-700 compliance for a 200A service
   ```

4. **Upload Photos:**
   - Click "Photos" tab in artifacts panel
   - Upload photos with GPS EXIF data
   - See them mapped to coordinates

## Navigation

The app has two main panels:

**Left Panel - Chat:**
- Send messages to AI
- See streaming responses
- Attach files

**Right Panel - Artifacts:**
- **PGI Dashboard:** Auto-populated budget charts
- **Photos:** GPS-tagged photos from site
- **Plans:** Electrical floor plans
- **Compliance:** CEQ/RBQ/RSST/CSA checklists

## Sample Data

Try loading the sample PGI data:

```bash
# The sample data is at:
backend/data/sample_pgi_data.json

# Ask the AI:
"Load the sample PGI data and show me the dashboard"
```

**Sample includes:**
- 5 projects (KORLCC, Alexis Nihon, Urgences, St-Laurent, Verdun)
- 7 days of labor tracking
- 9 material categories
- 3 active alerts

## Troubleshooting

### "Module not found" errors

**Solution:**
```bash
# Backend
cd backend
pip install -r requirements.txt

# Frontend
cd frontend
rm -rf node_modules package-lock.json
npm install
```

### Backend won't start

**Check Python version:**
```bash
python3 --version
# Must be 3.10 or higher
```

**Check if port 8000 is in use:**
```bash
# On Linux/Mac
lsof -i :8000

# On Windows
netstat -ano | findstr :8000
```

**Solution:** Kill the process or change port in `backend/.env`:
```env
PORT=8001
```

### Frontend won't start

**Check Node.js version:**
```bash
node --version
# Must be 18 or higher
```

**Check if port 3001 is in use:**
```bash
# On Linux/Mac
lsof -i :3001

# On Windows
netstat -ano | findstr :3001
```

**Solution:** Kill the process or change port:
```bash
# Start on different port
PORT=3002 npm run dev
```

### No data in dashboard

**Causes:**
- AI response didn't trigger PGI detection
- No budget/project keywords mentioned

**Solution:**
Ask explicitly for project data:
```
Show me budget information for KORLCC project with budget 450,000$ and spending 320,000$
```

### Photos not showing GPS

**Reasons:**
- Photos don't have GPS EXIF data
- GPS stripped by photo editor
- Unsupported format (use JPG)

**Solution:**
- Use original photos from camera/phone
- Enable location services when taking photos
- Don't edit photos before uploading

## Development Mode

### Backend with Auto-Reload

```bash
cd backend

# Install uvicorn with reload
pip install uvicorn[standard]

# Run with auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend with Turbopack

```bash
cd frontend

# Run with turbopack (faster)
npm run dev -- --turbo
```

### View Logs

**Backend logs:**
- Terminal output shows all API requests
- Check `backend/logs/` directory

**Frontend logs:**
- Browser DevTools Console (F12)
- Terminal shows build/compile logs

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         User's Browser                  │
│                                          │
│  ┌──────────────────────────────────┐  │
│  │   Next.js Frontend (Port 3001)   │  │
│  │   - React components             │  │
│  │   - Recharts visualizations      │  │
│  │   - SSE connection to backend    │  │
│  └──────────────┬───────────────────┘  │
└─────────────────┼───────────────────────┘
                  │ HTTP / SSE
                  ↓
┌─────────────────────────────────────────┐
│    FastAPI Backend (Port 8000)          │
│                                          │
│  ┌──────────────────────────────────┐  │
│  │   API Endpoints                  │  │
│  │   - /chat (SSE streaming)        │  │
│  │   - /pgi/* (dashboard data)      │  │
│  │   - /photos/* (GPS extraction)   │  │
│  │   - /compliance/* (CEQ checks)   │  │
│  └──────────────┬───────────────────┘  │
│                 │                       │
│  ┌──────────────┴───────────────────┐  │
│  │   Services                       │  │
│  │   - PGIDetector (auto-detect)    │  │
│  │   - PhotoGPSService (EXIF)       │  │
│  │   - ComplianceChecker (CEQ)      │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## What to Do Next

1. ✅ Explore the chat interface
2. ✅ Ask about Quebec electrical codes
3. ✅ Upload sample photos with GPS
4. ✅ View PGI dashboard with budget data
5. ✅ Check compliance for different standards
6. ✅ Try uploading electrical plans

## Example Prompts

```
> What is CEQ section 6-304 about stove installations?

> Calculate the wire size needed for a 200A service 50 meters from the panel

> Show me the labor hours breakdown for the last week

> List all RBQ requirements for master electrician license

> Generate a compliance checklist for a residential installation

> What's the current spending on materials for the KORLCC project?
```

## Advanced Features

### API Direct Access

```bash
# Get PGI data (JSON)
curl http://localhost:8000/pgi/rentabilite

# Upload photo with GPS
curl -X POST http://localhost:8000/photos/upload \
  -F "file=@photo.jpg"

# Run compliance check
curl -X POST http://localhost:8000/compliance/check \
  -H "Content-Type: application/json" \
  -d '{"standard": "CEQ", "section": "6-304"}'
```

### SSE Streaming Example

```javascript
const eventSource = new EventSource('http://localhost:8000/chat/stream');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('AI response:', data.content);
};
```

## Need Help?

- 📖 Read full [README.md](README.md)
- 🐛 Check [backend/logs/](backend/logs/) for errors
- 💬 Open GitHub issue
- 📧 Contact support

---

**You're ready to go!** ⚡🇨🇦

*Conforme CEQ • RBQ • RSST • CSA*
