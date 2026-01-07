# Installation Guide for Qwen CLI Chrome Extension

This document describes how to install the Qwen CLI Chrome Extension.

## Prerequisites

1. **Node.js**: Install from [nodejs.org](https://nodejs.org/) (version 18 or higher)
2. **Qwen CLI**: Install the Qwen CLI tool (optional but recommended for full functionality)
3. **Chrome Browser**: Version 88 or higher

## Installation Steps

### Method 1: Full Installation (Recommended)

```bash
cd packages/chrome-extension
npm run install:all
```

This command will:
1. Guide you through Chrome extension installation
2. Automatically configure the Native Host
3. Save the Extension ID for future use
4. Start the debugging environment

### Method 2: Component Installation

You can install components separately:

```bash
# Install Chrome extension only
npm run install:extension

# Configure Native Host only
npm run install:host
```

### Method 3: Manual Installation

#### Chrome Extension Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `packages/chrome-extension/extension` folder
5. Note the Extension ID that appears (you'll need this for the next step)

#### Native Host Installation

The Native Messaging Host allows the Chrome extension to communicate with Qwen CLI.

For macOS/Linux:
```bash
cd packages/chrome-extension/native-host
./scripts/smart-install.sh
```

When prompted, enter your Chrome Extension ID.

For Windows:
1. Run Command Prompt as Administrator
2. Navigate to the `packages/chrome-extension/native-host` directory
3. Run the installation script: `install.bat`
4. Enter your Chrome Extension ID when prompted

## Verification

To verify the installation:

1. Run the development environment:
   ```bash
   npm run dev
   ```

2. You should see Chrome launch with the extension installed and DevTools open.

3. Check that the extension appears in the Chrome toolbar.

## Updates

To update the host configuration (if you get a new extension ID):
```bash
npm run update:host
```
