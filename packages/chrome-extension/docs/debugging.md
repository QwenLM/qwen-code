# Debugging Guide for Qwen CLI Chrome Extension

This document outlines the debugging process for the Qwen CLI Chrome Extension.

## Debugging Setup

The extension provides several debugging options to help troubleshoot issues.

### Development Mode

To start the extension in development mode with debugging enabled:

```bash
npm run dev
```

This will:
- Launch Chrome with the extension loaded
- Open DevTools automatically
- Start a test server at http://localhost:3000
- Provide a test page for functionality verification

### Native Host Logging

The native host logs are stored at:
- **macOS/Linux**: `/tmp/qwen-bridge-host.log`
- **Windows**: `%TEMP%\qwen-bridge-host.log`

To monitor the logs in real-time:
```bash
npm run logs
```

Or directly:
```bash
tail -f /tmp/qwen-bridge-host.log
```

### Chrome Extension Debugging

1. Open Chrome Extensions page (`chrome://extensions/`)
2. Enable "Developer mode"
3. Find the Qwen CLI Chrome Extension extension
4. Click "Inspect views" on the service worker to open DevTools for background scripts
5. Use the popup/panel's DevTools for UI debugging

## Common Debugging Scenarios

### Connection Issues

If the extension can't connect to the native host:

1. Verify Node.js is installed: `node --version`
2. Check the native host installation: `./native-host/scripts/smart-install.sh`
3. Check logs: `/tmp/qwen-bridge-host.log`
4. Verify extension ID matches the one in native host manifest

### Qwen CLI Communication Issues

If the extension can't communicate with Qwen CLI:

1. Verify Qwen CLI is installed: `qwen --version`
2. Check that Qwen CLI is running when the extension tries to connect
3. Check the extension's console logs for error messages
4. Verify the MCP server configuration

### Content Script Issues

If content scripts aren't working properly:

1. Check the content script logs in the page's DevTools console
2. Verify the content script is properly injected
3. Check for CSP restrictions on the target page

## Debugging Scripts

The following scripts are available for debugging:

- `npm run dev`: Full development environment with Chrome auto-launch
- `npm run logs`: Tail the native host log file
- `npm run clean`: Clean all build artifacts and logs
- `npm run dev:chrome`: Start Chrome with extension loaded and DevTools open

## Troubleshooting Tips

### Check Extension Status
Check the extension's status in the extension popup or through the API.

### Verify Permissions
Ensure all required permissions are granted in the extension settings.

### Network Requests
Monitor network requests to ensure proper communication between components.

### Console Messages
Watch console messages in both the extension's background script and content scripts.
