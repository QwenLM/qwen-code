# Quebec Electrical Agents - Web Application 🚀⚡

**Full-stack web application for Quebec electrical project management with AI agents, PGI dashboard, and photo GPS geolocation.**

[![FastAPI](https://img.shields.io/badge/FastAPI-0.109.0-009688?logo=fastapi)](https://fastapi.tiangolo.com/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-000000?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Recharts](https://img.shields.io/badge/Recharts-2.14-22B5BF)](https://recharts.org/)

## 🌟 Overview

This is a modern web application that combines a FastAPI backend with a Next.js 14 frontend to provide comprehensive project management tools for Quebec's electrical industry. The system features:

- **AI-Powered Chat Interface** with real-time streaming responses
- **PGI (ERP) Dashboard** with interactive data visualizations
- **Photo GPS Geolocation** to map site photos on electrical plans
- **CEQ/RBQ/RSST/CSA Compliance** checking and reporting
- **Split-Pane UI** with Chat on left and Artifacts on right
- **Cyberpunk Industrial Dark Theme** with glowing effects

---

## 🏗️ Architecture

### Technology Stack

**Backend (FastAPI):**
- FastAPI 0.109.0 - High-performance async Python web framework
- Server-Sent Events (SSE) - Real-time streaming responses
- EXIF/GPS Processing - Extract photo coordinates with Pillow and piexif
- AI Integration - OpenAI GPT-4 and Anthropic Claude support
- Electrical Analysis - OCR (pytesseract) and Computer Vision (OpenCV)
- Vector Database - FAISS for Quebec electrical standards knowledge base

**Frontend (Next.js 14):**
- Next.js 14.2 with App Router - Modern React framework
- TypeScript - Type-safe development
- Tailwind CSS - Utility-first CSS with custom Cyberpunk theme
- Recharts - Data visualization library (Bar, Line, Pie charts)
- Lucide React - Beautiful icon library
- React Dropzone - Drag & drop file uploads

### System Architecture

```
┌─────────────────────────────────────────────┐
│         Next.js 14 Frontend (Port 3001)     │
│  ┌─────────────┐      ┌─────────────────┐  │
│  │ Chat Panel  │      │ Artifact Panel  │  │
│  │  (Left)     │ ◄──► │   (Right)       │  │
│  │             │      │  - PGI Dashboard│  │
│  │ - SSE Stream│      │  - Photo GPS    │  │
│  │ - Messages  │      │  - Code/Docs    │  │
│  └─────────────┘      └─────────────────┘  │
└──────────────┬──────────────────────────────┘
               │ HTTP/SSE
               ↓
┌──────────────────────────────────────────────┐
│       FastAPI Backend (Port 8000)            │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │   AI     │  │   PGI    │  │Photo GPS  │  │
│  │ Service  │  │ Detector │  │ Service   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│  ┌──────────────────────────────────────┐   │
│  │      API Routes                      │   │
│  │  /api/stream - Chat streaming        │   │
│  │  /api/pgi/analyze - PGI detection    │   │
│  │  /api/photos/upload - Photo upload   │   │
│  │  /api/plans/upload - Plan upload     │   │
│  └──────────────────────────────────────┘   │
└───────────────┬──────────────────────────────┘
                │
                ↓
┌───────────────────────────────────────────────┐
│          Python Services                      │
│  - OCR (Tesseract)                           │
│  - Computer Vision (OpenCV)                  │
│  - FAISS Vector Database                     │
│  - EXIF/GPS Processing                       │
└───────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- **Python 3.10+** with pip
- **Node.js 18+** with npm
- **Tesseract OCR** installed
- **OpenAI or Anthropic API key** (optional - has mock mode)

### Installation

```bash
cd packages/quebec-electrical-agents/webapp

# Backend setup
cd backend
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your API keys

# Frontend setup
cd ../frontend
npm install
cp .env.example .env
```

### Running the Application

**Option 1: Separate terminals (Recommended for development)**

```bash
# Terminal 1: Start backend
cd backend
python main.py
# Backend starts on http://localhost:8000

# Terminal 2: Start frontend
cd frontend
npm run dev
# Frontend starts on http://localhost:3001
```

**Option 2: Production mode**

```bash
# Backend
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000

# Frontend
cd frontend
npm run build
npm start
```

### Access the Application

Open your browser and navigate to:
- **Frontend:** http://localhost:3001
- **Backend API Docs:** http://localhost:8000/api/docs
- **Backend Health:** http://localhost:8000/api/health

---

## 💡 Features

### 1. AI Chat Interface with Streaming

The left panel provides a real-time chat interface powered by AI models (GPT-4 or Claude).

**Key Features:**
- **Server-Sent Events (SSE)** for real-time streaming responses
- Automatic **PGI data detection** in AI responses
- Message history with timestamps
- Stop streaming capability
- Cyberpunk-styled message bubbles with role indicators

**Usage:**
```typescript
// Frontend automatically connects to /api/stream
// Backend streams response chunk by chunk
POST /api/stream
{
  "messages": [{"role": "user", "content": "Show me KORLCC project status"}],
  "temperature": 0.7,
  "detect_pgi": true
}

// Response: SSE stream
data: {"type": "text", "content": "Voici le projet KORLCC..."}
data: {"type": "pgi", "data": {...}} // Triggers artifact panel
data: {"type": "done"}
```

### 2. PGI Dashboard (Artifact Panel)

When the AI detects project management data in its response, it automatically generates a PGI (Progiciel de Gestion Intégré / ERP) dashboard displayed in the right panel.

**Dashboard Components:**

**A. Summary Statistics**
- Total budget across all projects
- Total labor hours this week
- Total materials cost
- Real-time alerts for budget overruns and urgent projects

**B. Rentabilité (Profitability) - Bar Chart**
- Shows Budget vs Spent vs Remaining for each project
- Color-coded bars (Cyan, Purple, Green)
- Interactive tooltips
- Projects: KORLCC, Alexis Nihon, Urgences

**C. Main d'œuvre (Labor) - Line Chart**
- 7-day labor hours trend
- Dual-line chart showing hours and worker count
- Date-based X-axis
- Tracks labor costs and productivity

**D. Matériel (Materials) - Pie Chart**
- Material costs by category
- Interactive legend
- Percentage labels on slices
- Detailed table below with quantities and costs

**E. Project Cards**
- Individual cards for each active project
- Status badges (active, urgent, completed, pending)
- Progress bars with gradient animations
- Budget breakdown

**PGI Data Detection:**

The backend automatically detects PGI-relevant keywords in AI responses:

```python
# Triggers when response contains:
- "projet", "budget", "rentabilité"
- "main d'œuvre", "matériel"
- "KORLCC", "Alexis Nihon", "Urgences"
- "dashboard", "tableau de bord"

# Extracts:
- Budget amounts: "budget: 450,000 $"
- Percentages: "71% complete"
- Labor hours: "45 heures"
- Material costs: "coût: 12,500 $"
```

**Example Response Triggering PGI Dashboard:**

```
User: "Show me project status"

AI Response: "Voici un aperçu de vos projets:

KORLCC
- Budget: 450,000 $
- Dépensé: 320,000 $ (71%)
- Main d'œuvre: 45h cette semaine

Alexis Nihon
- Budget: 680,000 $
- Dépensé: 480,000 $ (70.6%)
..."

→ Backend detects budget data → Generates PGI JSON → Sends to frontend
→ Frontend renders PGI Dashboard with Recharts
```

### 3. Photo GPS Geolocation

Upload photos taken on-site with GPS coordinates, and they'll automatically be positioned on electrical floor plans.

**Workflow:**

1. **Upload Photos**
   ```bash
   POST /api/photos/upload
   # Accepts multiple image files (JPG, PNG)
   # Extracts EXIF data including GPS coordinates
   ```

2. **Upload Electrical Plan**
   ```bash
   POST /api/plans/upload
   # PDF or image of electrical floor plan
   ```

3. **Map Photos to Plan**
   ```bash
   POST /api/photos/map-to-plan
   {
     "photo_paths": ["/uploads/photo1.jpg", ...],
     "plan_path": "/uploads/plan.pdf",
     "reference_points": [
       {"x": 100, "y": 100, "lat": 45.5017, "lon": -73.5673},
       {"x": 1000, "y": 800, "lat": 45.5020, "lon": -73.5670}
     ]
   }
   # Returns photos with calculated plan coordinates
   ```

4. **View in Artifact Panel**
   - Electrical plan displayed
   - Pink pulsing markers show photo locations
   - Click markers to view full photo
   - Hover for quick preview with metadata

**GPS Extraction:**

```python
# Backend extracts from EXIF:
- GPS Latitude/Longitude (decimal degrees)
- GPS Altitude
- Capture timestamp
- Camera make/model
- Photo dimensions
```

**Coordinate Mapping:**

Uses reference points to map GPS coordinates (lat/lon) to pixel coordinates (x/y) on the plan:

```python
# Simple linear interpolation
# Production: Use affine transformation or polynomial mapping
lat_ratio = (photo_gps.lat - ref1.lat) / (ref2.lat - ref1.lat)
lon_ratio = (photo_gps.lon - ref1.lon) / (ref2.lon - ref1.lon)

photo_x = ref1.x + (lon_ratio * (ref2.x - ref1.x))
photo_y = ref1.y + (lat_ratio * (ref2.y - ref1.y))
```

### 4. Split-Pane Layout

The interface uses a resizable split-pane layout:

**Left Panel (Chat):**
- Chat history
- Input box with send button
- Streaming indicator
- Stop streaming button

**Right Panel (Artifacts):**
- PGI Dashboard
- Photo GPS plan viewer
- Code snippets
- BOM reports
- Compliance documents

**Resizing:**
- Drag the divider between panels
- Minimum width: 30%
- Maximum width: 70%
- Smooth animation on resize

### 5. Cyberpunk Industrial Design System

Custom dark theme with vibrant accent colors and glowing effects.

**Color Palette:**
```css
--cyber-blue: #00f0ff    /* Primary - Cyan */
--cyber-purple: #b000ff  /* Secondary - Purple */
--cyber-pink: #ff006e    /* Accent - Pink */
--cyber-yellow: #ffbe0b  /* Warning - Yellow */
--cyber-green: #00ff41   /* Success - Green */
```

**Visual Effects:**
- Pulsing glow animations on icons
- Gradient borders with hue rotation
- Glass morphism (backdrop blur)
- Custom scrollbars with glowing thumbs
- Grid background pattern
- Hover scale animations
- Card shadows with colored glow

**Typography:**
- Inter font family
- Gradient headings (cyan → purple → pink)
- Monospace for code and coordinates

---

## 📁 Project Structure

```
webapp/
├── backend/                      # FastAPI Backend
│   ├── main.py                   # Main application entry
│   ├── requirements.txt          # Python dependencies
│   ├── .env.example              # Environment template
│   ├── api/
│   │   ├── stream.py             # SSE chat streaming
│   │   ├── photos.py             # Photo upload & GPS
│   │   ├── plans.py              # Plan upload
│   │   └── pgi.py                # PGI data API
│   └── services/
│       ├── ai_service.py         # AI chat (OpenAI/Anthropic)
│       ├── pgi_detector.py       # PGI data detection
│       └── photo_gps.py          # GPS extraction & mapping
│
├── frontend/                     # Next.js Frontend
│   ├── package.json              # Node dependencies
│   ├── next.config.js            # Next.js config
│   ├── tsconfig.json             # TypeScript config
│   ├── tailwind.config.ts        # Tailwind + Cyberpunk theme
│   ├── .env.example              # Environment template
│   ├── app/
│   │   ├── layout.tsx            # Root layout
│   │   ├── page.tsx              # Main page (split-pane)
│   │   └── globals.css           # Global styles + Cyberpunk
│   ├── components/
│   │   ├── layout/
│   │   │   └── Header.tsx        # App header
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx    # Chat interface (SSE)
│   │   │   └── MessageBubble.tsx # Message display
│   │   ├── artifact/
│   │   │   └── ArtifactPanel.tsx # Artifact renderer
│   │   ├── pgi/
│   │   │   └── Dashboard.tsx     # PGI with Recharts
│   │   └── components/
│   │       └── PlanWithPhotos.tsx # Photo GPS viewer
│   └── types/
│       └── artifact.ts           # TypeScript interfaces
│
└── README.md                     # This file
```

---

## 🔧 API Reference

### Backend Endpoints

**Health & Status**
```
GET /                  # Root health check
GET /api/health        # Service status
```

**AI Chat Streaming**
```
POST /api/stream
Body: {
  messages: Message[],
  temperature: 0.7,
  max_tokens: 2000,
  detect_pgi: true,
  model: "gpt-4-turbo-preview"
}
Response: SSE stream
```

**PGI Dashboard**
```
POST /api/pgi/analyze
Body: { text: string }
Response: { detected: bool, data: PGIData }

GET /api/pgi/sample
Response: Sample PGI dashboard data
```

**Photo Upload & GPS**
```
POST /api/photos/upload
Body: multipart/form-data (files[])
Response: { photos: PhotoMetadata[] }

POST /api/photos/map-to-plan
Body: {
  photo_paths: string[],
  plan_path: string,
  reference_points: Array<{x, y, lat, lon}>
}
Response: { photos: PhotoOnPlan[] }

GET /api/photos/{filename}/metadata
Response: PhotoMetadata
```

**Plan Upload**
```
POST /api/plans/upload
Body: multipart/form-data (file, project_name)
Response: { plan: PlanMetadata }

GET /api/plans/{filename}
Response: PlanMetadata

DELETE /api/plans/{filename}
Response: { success: bool }
```

---

## 🎨 Customization

### Changing AI Model

Edit `backend/services/ai_service.py`:

```python
# Use OpenAI
ai = AIService(model="gpt-4-turbo-preview")

# Use Claude
ai = AIService(model="claude-3-opus-20240229")

# Use local Ollama
ai = AIService(model="llama2")
```

### Customizing PGI Detection

Edit `backend/services/pgi_detector.py`:

```python
# Add custom keywords
self.pgi_keywords = [
    "projet", "budget", "rentabilité",
    "your_custom_keyword_here"
]

# Add custom extraction patterns
self.patterns = {
    "budget": re.compile(r"budget[:\s]+(\$?[\d\s,]+)\$?", re.IGNORECASE),
    "your_pattern": re.compile(r"your_regex_here")
}
```

### Styling the Frontend

Edit `frontend/app/globals.css`:

```css
/* Change color palette */
:root {
  --primary: 195 100% 50%;  /* Cyan */
  --secondary: 280 100% 50%; /* Purple */
  --accent: 327 100% 50%;    /* Pink */
}

/* Modify glow effects */
.cyber-glow {
  animation: pulse-glow 2s ease-in-out infinite;
  box-shadow: 0 0 20px currentColor;
}
```

---

## 🧪 Testing

### Backend Tests (Python)

```bash
cd backend
pytest tests/ -v --cov=. --cov-report=html
```

### Frontend Tests (Jest)

```bash
cd frontend
npm test
npm run test:coverage
```

---

## 📊 Performance Optimization

### Backend
- **Async/Await**: All routes use async for non-blocking I/O
- **Streaming**: SSE reduces memory usage for large responses
- **Caching**: Image processing results cached

### Frontend
- **React.memo**: Heavy components (PGI Dashboard) are memoized
- **useCallback**: Event handlers wrapped to prevent re-renders
- **Code Splitting**: Next.js automatic code splitting
- **Image Optimization**: Next.js Image component for photos

---

## 🔒 Security

- **CORS**: Restricted to localhost origins
- **Input Validation**: Pydantic models validate all inputs
- **File Upload**: Size limits (50MB) and type checking
- **API Keys**: Environment variables, never committed
- **CSP**: Content Security Policy headers
- **SQL Injection**: Using ORMs prevents SQL injection

---

## 🐛 Troubleshooting

**Backend won't start:**
```bash
# Check Python version
python --version  # Should be 3.10+

# Reinstall dependencies
pip install -r requirements.txt --force-reinstall

# Check port availability
lsof -i :8000
```

**Frontend build errors:**
```bash
# Clear Next.js cache
rm -rf .next

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check Node version
node --version  # Should be 18+
```

**SSE streaming not working:**
- Check browser console for CORS errors
- Verify backend is running on port 8000
- Disable browser extensions that block SSE

**GPS coordinates not extracting:**
- Ensure photos have EXIF data (not stripped)
- Check Pillow is installed: `pip install Pillow`
- Verify photo format is JPG (PNG often lacks GPS)

---

## 📝 License

See LICENSE file in project root.

---

## 👥 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

---

## 📧 Support

- **Email**: support@electrical-agents-quebec.ca
- **Documentation**: https://docs.electrical-agents-quebec.ca
- **Issues**: https://github.com/qwen-code/quebec-electrical-agents/issues

---

## 🙏 Acknowledgments

- **FastAPI**: For amazing async Python framework
- **Next.js**: For powerful React framework
- **Recharts**: For beautiful chart library
- **OpenAI & Anthropic**: For AI capabilities
- **Quebec Electrical Standards**: CEQ, RBQ, RSST, CSA

---

**Built with ⚡ for Quebec's electrical industry**

*Conforme CEQ • RBQ • RSST • CSA depuis 2025* 🇨🇦
