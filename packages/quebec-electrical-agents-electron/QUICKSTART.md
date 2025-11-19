# Quick Start Guide - 5 Minutes ⚡

Get up and running with Quebec Electrical Agents in 5 minutes!

## Prerequisites (1 minute)

Check you have these installed:

```bash
# Check Node.js (need 20+)
node --version

# Check npm
npm --version

# Check Qwen Code CLI
qwen --version
```

**Don't have Qwen Code?**
```bash
npm install -g @qwen-code/qwen-code@latest
```

## Installation (2 minutes)

### Option 1: Automated Install (Recommended)

```bash
cd packages/quebec-electrical-agents-electron
./install.sh
```

### Option 2: Manual Install

```bash
cd packages/quebec-electrical-agents-electron
npm install
```

## Run the App (30 seconds)

```bash
npm start
```

The app will:
1. Open Electron window
2. Auto-start Qwen Code CLI
3. Show status "En ligne" when ready
4. You can start chatting!

## First Steps (1 minute)

### Try These Commands:

1. **Basic Chat:**
   ```
   Hello, what can you do?
   ```

2. **Quebec Project Info:**
   ```
   Show me the KORLCC project with budget 450,000$ and spending 320,000$
   ```
   → Dashboard will auto-populate!

3. **Compliance Check:**
   ```
   Verify CEQ section 6-304 compliance for stove installations
   ```

4. **Upload Photos:**
   - Click "Photos GPS" in sidebar
   - Click "Upload Photos avec GPS"
   - Select photos taken with smartphone

### Navigation

Click these in the sidebar:
- **Chat IA** - AI chat interface
- **Tableau PGI** - Project dashboard
- **Photos GPS** - Photo management
- **Plans** - Electrical plans
- **Conformité** - Standards compliance

## Troubleshooting

### "Qwen process failed to start"

**Solution:**
```bash
# Install Qwen Code CLI
npm install -g @qwen-code/qwen-code@latest

# Verify it works
qwen --version

# Restart the app
npm start
```

### "Module not found" errors

**Solution:**
```bash
# Clean install
rm -rf node_modules package-lock.json
npm install
npm start
```

### Status shows "Hors ligne"

**Causes:**
- Qwen Code CLI not installed
- Qwen Code failed to start
- Check console for errors

**Fix:**
- Press F12 to open DevTools
- Check Console tab for errors
- Restart app: Cmd+R (Mac) or Ctrl+R (Win/Linux)

## Development Mode

```bash
# Run with DevTools open
npm run dev
```

## Building Executable

```bash
# Build for current platform
npm run build

# Build for specific platform
npm run build:mac     # macOS
npm run build:win     # Windows
npm run build:linux   # Linux

# Find in dist/ folder
```

## Keyboard Shortcuts

- **Enter** - Send message
- **Shift+Enter** - Newline
- **Cmd/Ctrl+R** - Reload
- **F12** - DevTools
- **Cmd/Ctrl+Q** - Quit

## What to Do Next

1. ✅ Chat with AI about Quebec electrical codes
2. ✅ Ask about projects (KORLCC, Alexis Nihon, Urgences)
3. ✅ Upload photos with GPS to see geolocation
4. ✅ Check compliance for CEQ/RBQ/RSST/CSA
5. ✅ Explore all 5 views in the sidebar

## Example Prompts

```
> What is CEQ section 26-700 about?
> Calculate wire size for 200A service
> Show me budget breakdown for Alexis Nihon project
> List RSST article 185 requirements
> Generate compliance checklist for residential installation
```

## Need Help?

- 📖 Read full README.md
- 🧪 Check TESTING.md for features
- 🐛 Open GitHub issue
- 💬 Ask in the chat!

---

**You're ready to go!** ⚡🇨🇦
