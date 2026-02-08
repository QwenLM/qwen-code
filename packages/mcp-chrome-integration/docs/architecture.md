# Chrome MCP Integration 架构设计

> **最后更新**: 2026-02-08
> **版本**: 2.0.0 (基于 Native Messaging 架构)
> **状态**: 已实现并运行

本文档描述 Chrome MCP Integration 的完整系统架构，包括 Chrome 扩展、Native Server、MCP 协议和与 Qwen CLI 的集成方式。

---

## 架构概览

Chrome MCP Integration 通过 **Native Messaging** 协议连接 Chrome 扩展和 Qwen CLI，实现 AI 驱动的浏览器自动化和分析能力。

### 核心架构（3 层）

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Browser                        │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Chrome Extension (Manifest V3)                     │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │ │
│  │  │ Side Panel   │  │ Service      │  │ Content  │ │ │
│  │  │ (React UI)   │  │ Worker       │  │ Scripts  │ │ │
│  │  └──────────────┘  └──────┬───────┘  └────┬─────┘ │ │
│  └────────────────────────────┼────────────────┼───────┘ │
└────────────────────────────────┼────────────────┼─────────┘
                                 │                │
                          Native Messaging (stdio)
                                 │                │
                    ┌────────────▼────────────────▼─────────┐
                    │   Native Server (Node.js)             │
                    │  ┌──────────────────────────────────┐ │
                    │  │ MCP Server (stdio/StreamableHttp)│ │
                    │  │  - 27 chrome_* 工具              │ │
                    │  │  - Native Messaging Handler      │ │
                    │  │  - Fastify HTTP Server           │ │
                    │  └──────────────┬───────────────────┘ │
                    └─────────────────┼──────────────────────┘
                                      │
                          MCP Protocol (stdio)
                                      │
                    ┌─────────────────▼──────────────────────┐
                    │          Qwen CLI                      │
                    │  - AI Agent                            │
                    │  - MCP Server 管理                      │
                    │  - 工具调用编排                          │
                    └────────────────────────────────────────┘
```

### 架构优势

| 特性       | 旧架构 (HTTP) | 新架构 (Native Messaging) |
| ---------- | ------------- | ------------------------- |
| 通信层数   | 5 层          | **3 层** (-40%)           |
| 工具数量   | 10 个         | **27 个** (+170%)         |
| 通信方式   | HTTP + SSE    | Native Messaging (stdio)  |
| 性能       | 一般          | **更快、更稳定**          |
| 响应体捕获 | ❌            | ✅ 支持                   |
| 维护性     | 内部维护      | 基于社区 + 源码可控       |

---

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
