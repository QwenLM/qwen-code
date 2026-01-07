# Qwen CLI Chrome Extension - Chrome Extension

A Chrome extension that bridges your browser with Qwen CLI, enabling AI-powered analysis and interaction with web content.

> This package is part of the [Qwen Code](https://github.com/QwenLM/qwen-code) mono repository.

## Features

- **Page Data Extraction**: Extract structured data from any webpage including text, links, images, and metadata
- **Screenshot Capture**: Capture and analyze screenshots with AI
- **Console & Network Monitoring**: Monitor console logs and network requests
- **Selected Text Processing**: Send selected text to Qwen CLI for processing
- **AI Analysis**: Leverage Qwen's AI capabilities to analyze web content
- **MCP Server Integration**: Support for multiple MCP (Model Context Protocol) servers

## Architecture

```
┌─────────────────────┐
│  Chrome Extension   │
│  - Content Script   │
│  - Background Worker│
│  - Popup UI         │
└──────────┬──────────┘
           │
    Native Messaging
           │
    ┌──────▼──────────┐
    │ Native Host     │
    │ (Node.js)       │
    └──────┬──────────┘
           │
    ┌──────▼──────────┐
    │   Qwen CLI      │
    │ + MCP Servers   │
    └─────────────────┘
```

## Installation

### Prerequisites

1. **Node.js**: Install from [nodejs.org](https://nodejs.org/)
2. **Qwen CLI**: Install the Qwen CLI tool (required for full functionality)
3. **Chrome Browser**: Version 88 or higher

### Step 1: Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `chrome-extension/extension` folder
5. Note the Extension ID that appears (you'll need this for the next step)

### Step 2: Install the Native Messaging Host

The Native Messaging Host allows the Chrome extension to communicate with Qwen CLI.

#### macOS/Linux

```bash
cd chrome-extension/native-host
./install.sh
```

When prompted, enter your Chrome Extension ID.

#### Windows

1. Run Command Prompt as Administrator
2. Navigate to the `native-host` directory:
   ```cmd
   cd chrome-extension\native-host
   ```
3. Run the installation script:
   ```cmd
   install.bat
   ```
4. Enter your Chrome Extension ID when prompted

### Step 3: Configure Qwen CLI (Optional)

If you want to use MCP servers with the extension:

```bash
# Add chrome-devtools MCP server
qwen mcp add chrome-devtools

# Add other MCP servers as needed
qwen mcp add playwright-mcp
```

## Usage

### Basic Usage

1. Click the Qwen CLI Chrome Extension extension icon in Chrome
2. Click "Connect to Qwen CLI" to establish connection
3. Click "Start Qwen CLI" to launch the CLI process
4. Use the action buttons to:
   - Extract and analyze page data
   - Capture screenshots
   - Send selected text to Qwen
   - Monitor console and network logs

### Advanced Settings

In the popup's "Advanced Settings" section, you can configure:

- **MCP Servers**: Comma-separated list of MCP servers to load
- **HTTP Port**: Port for Qwen CLI HTTP server (default: 8080)
- **Auto-connect**: Automatically connect when opening the popup

### API Actions

The extension supports the following actions that can be sent to Qwen CLI:

- `analyze_page`: Analyze extracted page data
- `analyze_screenshot`: Analyze captured screenshot
- `ai_analyze`: Perform AI analysis on content
- `process_text`: Process selected text
- Custom actions based on your MCP server configurations

## Development

### Project Structure

```
chrome-extension/
├── extension/              # Chrome extension source
│   ├── manifest.json       # Extension manifest
│   ├── background/         # Service worker
│   ├── content/           # Content scripts
│   ├── popup/             # Popup UI
│   └── icons/             # Extension icons
├── native-host/           # Native messaging host
│   ├── host.js           # Node.js host script
│   ├── manifest.json     # Native host manifest
│   └── install scripts   # Platform-specific installers
└── docs/                  # Documentation
```

### Building from Source

1. Clone the repository
2. No build step required - the extension uses vanilla JavaScript
3. Load the extension as unpacked in Chrome for development

### Testing

1. Enable Chrome Developer Tools
2. Check the extension's background page console for logs
3. Native host logs are written to:
   - macOS/Linux: `/tmp/qwen-bridge-host.log`
   - Windows: `%TEMP%\qwen-bridge-host.log`

## Troubleshooting

### Extension not connecting to Native Host

1. Verify Node.js is installed: `node --version`
2. Check that the Native Host is properly installed
3. Ensure the Extension ID in the manifest matches your actual extension
4. Check logs for errors

### Qwen CLI not starting

1. Verify Qwen CLI is installed: `qwen --version`
2. Check that Qwen CLI can run normally from terminal
3. Review Native Host logs for error messages

### No response from Qwen CLI

1. Ensure Qwen CLI server is running
2. Check the configured HTTP port is not in use
3. Verify MCP servers are properly configured

## Security Considerations

- The extension requires broad permissions to function properly
- Native Messaging Host runs with user privileges
- All communication between components uses structured JSON messages
- No sensitive data is stored; all processing is ephemeral

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - See LICENSE file for details

## Support

For issues, questions, or feature requests:
- Open an issue on GitHub
- Check the logs for debugging information
- Ensure all prerequisites are properly installed
