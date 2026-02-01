# Architecture Overview for Qwen CLI Chrome Extension

This document describes the architecture of the Qwen CLI Chrome Extension.

## Overview

The Qwen CLI Chrome Extension connects your browser with the Qwen CLI, enabling AI-powered analysis and interaction with web content. It uses the Chrome Native Messaging API to securely communicate with the native host process.

## System Architecture

```
┌─────────────────────┐
│  Chrome Browser     │
│  ┌─────────────────┐│
│  │ Extension UI    ││  ← Popup/Side panel interface
│  └─────────────────┘│
│  ┌─────────────────┐│
│  │ Content Script  ││  ← Page content extraction
│  └─────────────────┘│
│  ┌─────────────────┐│
│  │ Background      ││  ← Service worker handling
│  │ (Service Worker)││     messaging and logic
│  └─────────────────┘│
└──────────┬──────────┘
           │
    Native Messaging
           │
    ┌──────▼──────────┐
    │ Native Host     │
    │ (Node.js)       │  ← Bridge between extension
    └──────┬──────────┘    and Qwen CLI
           │
    ┌──────▼──────────┐
    │   Qwen CLI      │
    │ + MCP Servers   │  ← AI processing and tools
    └─────────────────┘
```

## Components

### 1. Extension UI (Popup/Side Panel)

The user interface of the extension provides:
- Connection management to Qwen CLI
- Action buttons for various features
- Status information
- Settings and configuration

### 2. Content Script

The content script runs on web pages and provides:
- Page content extraction
- Console log capture
- Element selection and highlighting
- Text selection utilities
- Direct DOM interaction

### 3. Background Script (Service Worker)

The background service worker handles:
- Communication with the native host
- Message routing between components
- Browser API interactions
- Network monitoring (via debugger API)
- State management

### 4. Native Host (Node.js)

The native host acts as a bridge between the extension and Qwen CLI:
- Implements the Native Messaging protocol
- Communicates with Qwen CLI using ACP (Agent Communication Protocol)
- Handles file system operations
- Manages MCP (Model Context Protocol) servers
- Provides browser-specific tools via HTTP bridge

### 5. Qwen CLI

The main AI processing component:
- Runs AI models and processes requests
- Manages MCP servers
- Provides tool access (shell commands, file operations, etc.)

## Security Architecture

The extension follows Chrome's security model:

1. **Native Messaging Security**: Communication between extension and native host is restricted by manifest permissions
2. **Content Security Policy**: Prevents XSS attacks and injection
3. **Sandboxed Execution**: Native host runs with user privileges, not elevated permissions
4. **Origin Restrictions**: Communication is limited to allowed origins

## Data Flow

### Page Analysis Request

1. User initiates "Analyze Page" from extension UI
2. Background script sends message to content script
3. Content script extracts page data (text, links, images, etc.)
4. Data is sent back to background script
5. Background script sends data to native host
6. Native host forwards to Qwen CLI
7. Qwen CLI processes and responds with AI analysis
8. Response flows back to extension UI

### Network Monitoring

1. Background script uses Chrome Debugger API to monitor network requests
2. Network events are captured and stored per tab
3. When requested, network logs are provided to Qwen CLI via native host
4. This allows AI to analyze API calls and network activity

## Communication Protocols

### Native Messaging Protocol

JSON-based messages exchanged between extension and native host:
```json
{
  "type": "message_type",
  "id": "request_id",
  "data": { ... }
}
```

### ACP (Agent Communication Protocol)

Used between native host and Qwen CLI:
- JSON-RPC over stdio
- Content-Length framed messages
- Request/response with error handling

## Extension Permissions

The extension requires specific permissions for full functionality:

- `activeTab`: Access to current tab for content extraction
- `tabs`: Tab management and information
- `storage`: Local storage for settings and state
- `nativeMessaging`: Communication with native host
- `debugger`: Network request monitoring
- `webNavigation`: Navigation event monitoring
- `scripting`: Content script injection
- `cookies`: Cookie access for web automation
- `webRequest`: Network request monitoring
- `sidePanel`: Side panel UI support
- `host_permissions`: Access to all URLs
