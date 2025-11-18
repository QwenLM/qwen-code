# Quebec Electrical Agents - Electron Edition ⚡

**Desktop application for Quebec electrical project management powered by Qwen Code AI**

[![Electron](https://img.shields.io/badge/Electron-28.1.0-47848F?logo=electron)](https://www.electronjs.org/)
[![Qwen Code](https://img.shields.io/badge/Qwen_Code-Latest-00D4FF)](https://github.com/QwenLM/qwen-code)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 🌟 Overview

This is a modern **Electron desktop application** that provides a professional interface for Quebec electrical project management, powered by **Qwen Code CLI** as the AI backend. The application combines the power of Qwen's AI capabilities with a beautiful Cyberpunk Industrial dark-themed UI specifically designed for Quebec's electrical industry.

### Key Features

✅ **Qwen Code Integration** - Spawns and communicates with Qwen Code CLI
✅ **AI Chat Interface** - Real-time streaming chat with Qwen AI
✅ **PGI Dashboard** - Automatic project data visualization (Budget, Labor, Materials)
✅ **Photo GPS** - Extract EXIF GPS from site photos and map to electrical plans
✅ **Compliance Checking** - CEQ, RBQ, RSST, CSA standards verification
✅ **Cyberpunk Theme** - Beautiful dark UI with glowing effects
✅ **Offline-First** - Desktop app, no cloud dependencies
✅ **Secure** - Context isolation, preload script security

---

## 📋 Prerequisites

Before installing, ensure you have:

### Required

- **Node.js 20+** ([Download](https://nodejs.org/))
- **Qwen Code CLI** installed globally:
  ```bash
  npm install -g @qwen-code/qwen-code@latest
  ```
- **npm** (comes with Node.js)

### Optional

- **Tesseract OCR** (for plan analysis)
- **Git** (for source install)

---

## 🚀 Installation

### Option 1: Install from Source (Recommended for Development)

```bash
# Clone the repository
cd /path/to/qwen-code/packages/quebec-electrical-agents-electron

# Install dependencies
npm install

# Start the application
npm start
```

### Option 2: Build Executable

```bash
# Install dependencies
npm install

# Build for your platform
npm run build              # Auto-detect platform
npm run build:mac          # macOS
npm run build:win          # Windows
npm run build:linux        # Linux

# Find the built app in dist/ directory
```

---

## 💻 Usage

### Starting the Application

```bash
# Development mode (with DevTools)
npm run dev

# Production mode
npm start
```

### First Launch

1. **Application starts** and automatically initializes Qwen Code CLI
2. **Status indicator** in top-right shows "En ligne" (Online) when ready
3. **Start chatting** with the AI in the Chat view

### Using the Chat

```
Example queries:
> Montre-moi le statut du projet KORLCC
> Quels sont les budgets des projets Alexis Nihon et Urgences?
> Vérifie la conformité CEQ pour le projet en cours
> Combien d'heures de main d'œuvre cette semaine?
```

**Features:**
- Type your message and press **Enter** or click **Envoyer**
- Use **Shift+Enter** for newlines
- Attach files with the **📎 button**
- **Real-time streaming** responses appear word-by-word

### PGI Dashboard

The application automatically detects project management data in AI responses:

**Triggers:**
- Mentions of projects: KORLCC, Alexis Nihon, Urgences
- Keywords: budget, rentabilité, main d'œuvre, matériel

**What it shows:**
- Budget total vs dépensé per project
- Completion percentage with progress bars
- Project status (Active, Urgent)
- Spending breakdowns

**Example:**
```
User: "Affiche les budgets KORLCC et Alexis Nihon"
AI: *streams response with budget data*
→ Dashboard auto-populates with project cards
→ Notification: "Données PGI détectées"
```

### Photo GPS

Upload photos taken on-site with GPS coordinates:

1. Click **"Photos GPS"** in sidebar
2. Click **"Upload Photos avec GPS"**
3. Select one or more photos (.jpg, .jpeg, .png)
4. Application extracts:
   - GPS coordinates (latitude, longitude, altitude)
   - Camera make/model
   - Capture timestamp
5. Photos displayed in grid with GPS data

**Use cases:**
- Document site conditions with exact locations
- Map equipment installations to floor plans
- Track progress photos geographically

### Plans

Upload electrical floor plans:

1. Click **"Plans"** in sidebar
2. Click **"Upload Plan (PDF/Image)"**
3. Select PDF or image file
4. Plan added to list with timestamp

### Compliance

Check CEQ, RBQ, RSST, and CSA compliance:

1. Click **"Conformité"** in sidebar
2. View status cards for each standard
3. Click **"Exécuter Vérification Complète"**
4. AI performs comprehensive audit
5. Results appear in chat

---

## 🏗️ Architecture

### Technology Stack

```
Frontend:
├── HTML5 + CSS3 (Cyberpunk Industrial theme)
├── Vanilla JavaScript (no frameworks)
└── Electron 28.1.0

Backend:
├── Qwen Code CLI (spawned process)
├── Node.js child_process
└── IPC via Electron

Data:
├── electron-store (local storage)
└── EXIF GPS extraction (exif-parser)
```

### Application Structure

```
quebec-electrical-agents-electron/
├── electron/
│   ├── main.js           # Main process (spawns Qwen, IPC)
│   └── preload.js        # Security bridge (contextBridge)
├── src/
│   ├── index.html        # UI structure
│   ├── styles.css        # Cyberpunk theme (500+ lines)
│   └── app.js            # Application logic (700+ lines)
├── assets/               # Icons, images
├── dist/                 # Built executables
└── package.json          # Dependencies & scripts
```

### Process Architecture

```
┌─────────────────────────────────────┐
│     Electron Main Process           │
│  (main.js - Node.js environment)    │
│                                      │
│  ┌──────────────────────────────┐  │
│  │   Qwen Code CLI Process      │  │
│  │   (child_process.spawn)      │  │
│  │                               │  │
│  │   stdin  ←  Send messages     │  │
│  │   stdout →  Receive responses │  │
│  │   stderr →  Error logging     │  │
│  └──────────────────────────────┘  │
│                                      │
│  ┌──────────────────────────────┐  │
│  │   IPC Handlers               │  │
│  │   - qwen-init                │  │
│  │   - qwen-send                │  │
│  │   - extract-photo-gps        │  │
│  │   - select-file              │  │
│  └──────────────────────────────┘  │
└──────────────┬───────────────────────┘
               │ IPC Communication
               ↓
┌─────────────────────────────────────┐
│   Electron Renderer Process         │
│  (Browser - Chromium environment)   │
│                                      │
│  ┌──────────────────────────────┐  │
│  │   Preload Script             │  │
│  │   (contextBridge security)   │  │
│  └──────────────────────────────┘  │
│                                      │
│  ┌──────────────────────────────┐  │
│  │   App UI (index.html)        │  │
│  │   - Chat interface           │  │
│  │   - PGI Dashboard            │  │
│  │   - Photo GPS viewer         │  │
│  │   - Plans manager            │  │
│  │   - Compliance checker       │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

### IPC Communication Flow

```
User Action (Renderer)
      │
      ↓
window.electronAPI.qwenSend(message)  ← Preload bridge
      │
      ↓
ipcRenderer.invoke('qwen-send', message)
      │
      ↓
ipcMain.handle('qwen-send', ...) ← Main process handler
      │
      ↓
qwenProcess.stdin.write(message)  ← Send to Qwen CLI
      │
      ↓
qwenProcess.stdout.on('data', ...) ← Receive response
      │
      ↓
mainWindow.webContents.send('qwen-output', data)
      │
      ↓
window.electronAPI.onQwenOutput(callback)  ← Renderer receives
      │
      ↓
Update UI, detect PGI data, render dashboard
```

---

## 🎨 Cyberpunk Industrial Theme

### Color Palette

```css
--cyber-blue: #00f0ff    /* Primary - Cyan glow */
--cyber-purple: #b000ff  /* Secondary - Purple */
--cyber-pink: #ff006e    /* Accent - Pink alerts */
--cyber-yellow: #ffbe0b  /* Warning - Yellow */
--cyber-green: #00ff41   /* Success - Green */
```

### Visual Effects

- **Pulsing glow animations** on logo and status indicators
- **Gradient text** for headings (blue → purple → pink)
- **Box shadows with glow** on cards and buttons
- **Grid background pattern** for cyberpunk aesthetic
- **Custom scrollbars** with glowing thumbs
- **Smooth transitions** on all interactive elements
- **Hover animations** with scale and glow effects

### Screenshots

*(Application in action)*

**Chat Interface:**
- Split layout with navigation sidebar
- Real-time streaming responses
- Message bubbles with avatars
- Timestamp display

**PGI Dashboard:**
- Project cards with progress bars
- Budget breakdowns (Total, Spent, Remaining)
- Status badges (Active, Urgent)
- Cyberpunk gradient styling

**Photo GPS:**
- Grid layout of photos
- GPS coordinates display
- Camera metadata
- Hover effects

---

## 🔧 Configuration

### Qwen Code CLI Settings

The application uses Qwen Code with the `--yolo` flag for automatic mode. To customize:

Edit `electron/main.js`:

```javascript
// Line ~80
qwenProcess = spawn(QWEN_CLI_COMMAND, ['--yolo'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true
});
```

**Available Qwen flags:**
- `--yolo` - Automatic mode (no confirmations)
- `--model <model>` - Specify AI model
- `--vlm-switch-mode <mode>` - Vision model switching

### Electron Window Settings

Edit `electron/main.js`:

```javascript
// Line ~40
mainWindow = new BrowserWindow({
  width: 1600,          // Adjust window width
  height: 1000,         // Adjust window height
  minWidth: 1200,       // Minimum width
  minHeight: 800,       // Minimum height
  backgroundColor: '#0f172a',  // Background color
  // ...
});
```

### Storage

Application uses `electron-store` for persistent data:

```javascript
// Access via window.electronAPI
await window.electronAPI.storeSet('key', 'value');
const value = await window.electronAPI.storeGet('key');
await window.electronAPI.storeClear();
```

**Stored data:**
- User preferences
- Recent projects
- Chat history (optional)

**Storage location:**
- macOS: `~/Library/Application Support/quebec-electrical-agents-electron/`
- Windows: `%APPDATA%\quebec-electrical-agents-electron\`
- Linux: `~/.config/quebec-electrical-agents-electron/`

---

## 🐛 Troubleshooting

### Qwen Code CLI Not Found

**Error:** `Qwen process failed to start`

**Solution:**
```bash
# Install Qwen Code globally
npm install -g @qwen-code/qwen-code@latest

# Verify installation
qwen --version

# Restart the Electron app
```

### Application Won't Start

**Check:**
1. Node.js version: `node --version` (should be 20+)
2. Dependencies installed: `npm install`
3. Console errors: Run with `npm run dev` to see logs

**Logs location:**
- stdout: Terminal/console
- Application logs: Check DevTools console (F12)

### No GPS Data in Photos

**Reasons:**
- Photos not taken with GPS enabled
- GPS data stripped by photo editor
- Unsupported image format (use JPG)

**Solution:**
- Use original photos from camera/phone
- Enable GPS in camera settings
- Check "Location Services" enabled

### UI Not Responding

**Solutions:**
1. **Reload:** Press `Cmd+R` (Mac) or `Ctrl+R` (Win/Linux)
2. **DevTools:** Press `F12` to check console errors
3. **Restart:** Close and reopen application

### High CPU Usage

**Causes:**
- Qwen Code processing large request
- Background AI model loading

**Normal behavior:**
- CPU spike during AI responses
- Returns to normal after completion

**If persistent:**
- Check Qwen process: `ps aux | grep qwen`
- Restart application
- Update Qwen Code to latest version

---

## 📚 API Reference

### Electron API (Renderer)

Accessible via `window.electronAPI`:

#### Qwen Methods

```javascript
// Initialize Qwen Code CLI
const result = await window.electronAPI.qwenInit();
// Returns: { success: boolean, error?: string }

// Send message to Qwen
const result = await window.electronAPI.qwenSend(message);
// Returns: { success: boolean, response?: string, error?: string }

// Stop Qwen process
const result = await window.electronAPI.qwenStop();
// Returns: { success: boolean }
```

#### Event Listeners

```javascript
// Listen for Qwen output
window.electronAPI.onQwenOutput((data) => {
  console.log('Qwen said:', data);
});

// Listen for Qwen errors
window.electronAPI.onQwenError((error) => {
  console.error('Qwen error:', error);
});

// Listen for Qwen stopped
window.electronAPI.onQwenStopped((code) => {
  console.log('Qwen exited with code:', code);
});
```

#### File Operations

```javascript
// Select single file
const filePath = await window.electronAPI.selectFile({
  title: 'Select File',
  filters: [{ name: 'Images', extensions: ['jpg', 'png'] }]
});

// Select multiple files
const filePaths = await window.electronAPI.selectFiles({
  title: 'Select Photos'
});

// Read file
const result = await window.electronAPI.readFile(filePath);
// Returns: { success: boolean, data: string (base64), path: string, name: string }
```

#### Photo GPS

```javascript
// Extract GPS from photo
const result = await window.electronAPI.extractPhotoGPS(photoPath);
// Returns: {
//   success: boolean,
//   gps: {
//     latitude: number,
//     longitude: number,
//     altitude?: number,
//     timestamp?: string,
//     make?: string,
//     model?: string
//   },
//   path: string
// }
```

#### Storage

```javascript
// Get stored value
const value = await window.electronAPI.storeGet('myKey');

// Set stored value
await window.electronAPI.storeSet('myKey', { data: 'value' });

// Clear all storage
await window.electronAPI.storeClear();
```

---

## 🧪 Development

### Running in Dev Mode

```bash
# Start with DevTools open
npm run dev

# Watch mode (auto-reload)
nodemon --exec npm start
```

### Building

```bash
# Build for current platform
npm run build

# Build for all platforms
npm run build:mac
npm run build:win
npm run build:linux
```

**Output:**
- macOS: `.dmg` and `.zip` in `dist/`
- Windows: `.exe` installer and portable in `dist/`
- Linux: `.AppImage`, `.deb`, `.rpm` in `dist/`

### Debugging

**Main Process:**
- Add `console.log` statements in `electron/main.js`
- View output in terminal where you ran `npm start`

**Renderer Process:**
- Open DevTools: Press `F12` or `Cmd+Option+I` (Mac)
- Use `console.log`, `debugger`, breakpoints
- Inspect elements, network, storage

**Qwen Process:**
- Qwen stdout/stderr logged to console
- Check `qwenProcess` logs in main process

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create feature branch: `git checkout -b feature/AmazingFeature`
3. Commit changes: `git commit -m 'Add AmazingFeature'`
4. Push to branch: `git push origin feature/AmazingFeature`
5. Open Pull Request

---

## 📄 License

MIT License - see LICENSE file

---

## 🙏 Acknowledgments

- **Qwen Code Team** - Amazing AI CLI tool ([QwenLM/qwen-code](https://github.com/QwenLM/qwen-code))
- **Electron** - Desktop app framework
- **Quebec Electrical Standards** - CEQ, RBQ, RSST, CSA

---

## 📧 Support

- **Issues:** [GitHub Issues](https://github.com/your-repo/issues)
- **Email:** support@quebec-electrical-agents.ca
- **Documentation:** This README + inline code comments

---

## 🚀 Roadmap

- [ ] Multi-language support (EN/FR)
- [ ] PDF report generation
- [ ] Cloud sync (optional)
- [ ] Real-time collaboration
- [ ] Mobile companion app
- [ ] Advanced plan analysis with OCR
- [ ] 3D visualization of electrical layouts
- [ ] Integration with RBQ permit system

---

**Built with ⚡ for Quebec's electrical industry**

*Conforme CEQ • RBQ • RSST • CSA* 🇨🇦
