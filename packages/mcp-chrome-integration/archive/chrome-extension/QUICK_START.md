# Quick Start Guide for Qwen CLI Chrome Extension

Get started quickly with the Qwen CLI Chrome Extension.

## New

### 准备工作

```
# 首次运行
npm i -g qwen-cli-chrome-bridge-host

qwen mcp add --transport stdio chrome-browser "chrome-browser-mcp"

# 启动 host 服务
qwen-bridge-host

# 检查 qwen 是否装载 mcp 正常
$ qwen mcp list
Configured MCP servers:

✓ chrome-browser: chrome-browser-mcp  (stdio) - Connected
# 如果显示 Disconnected 可稍等一会之后再执行。
```

### chrome 插件

1. 开启 chrome 开发者模式之后，加载 `packages/chrome-extension/dist/extension` 目录下的插件
2. 点击插件图标，自动启动 qwen 服务

### 操作

1. 点击 "Extract Page Data" 按钮，提取页面数据
2. 点击 "Capture Screenshot" 按钮，截图
3. 点击 "Show me the network requests" 按钮，显示网络请求
4. 点击 "Show me the console logs" 按钮，显示 console 日志

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
4. Select the `packages/chrome-extension/dist/extension` folder (先运行 `npm run build`)
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
