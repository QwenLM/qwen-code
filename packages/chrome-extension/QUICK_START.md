# Quick Start Guide for Qwen CLI Chrome Extension

Get started quickly with the Qwen CLI Chrome Extension.

## Installation

1. **Prerequisites**: Make sure you have Node.js installed:
   ```bash
   node --version
   ```

2. **Install the extension and native host**:
   ```bash
   cd packages/chrome-extension
   npm run install:all
   ```

## Running the Extension

1. **Start development mode**:
   ```bash
   npm run dev
   ```
   This will launch Chrome with the extension loaded and open DevTools.

2. **In Chrome**:
   - Look for the Qwen CLI Chrome Extension icon in the toolbar
   - Click the icon to open the popup interface

3. **Connect to Qwen CLI** (if installed):
   - Click "Connect to Qwen CLI" in the extension popup
   - Click "Start Qwen CLI" to launch the AI interface

## Basic Usage

- **Extract Page Content**: Click "Extract Page Data" to send the current page to Qwen
- **Take Screenshot**: Click "Capture Screenshot" to take and analyze a screenshot
- **Monitor Network**: Ask Qwen to "show me the network requests" to view recent network activity
- **View Console Logs**: Ask Qwen to "show me the console logs" to view browser console output

## Development

1. **Build the extension**:
   ```bash
   npm run build
   ```

2. **Watch for changes during development**:
   ```bash
   npm run build:ui:watch
   ```

3. **View native host logs**:
   ```bash
   npm run logs
   ```

## Next Steps

- Check out the [Development Guide](docs/development.md) for more details on the architecture
- Read the [Debugging Guide](docs/debugging.md) if you encounter issues
- Learn about the [Architecture](docs/architecture.md) for deeper understanding
