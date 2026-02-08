# API Reference for Qwen CLI Chrome Extension

> ⚠️ 备注：本文档基于旧版消息模型（如 `start_qwen` / `qwen_prompt`）。当前统一设计以 Native Messaging + MCP 为主，请结合 `docs/status/integration-status.md` 与 `docs/design/03-architecture.md` 进行校准与更新。

This document provides reference for the APIs and message formats used in the Qwen CLI Chrome Extension.

## Canonical protocol (2026-02-01)

### Native Messaging (Extension ⇄ Native Host)

- Host name: `com.chromemcp.nativehost`
- Message envelope:
  - `type`: string enum (`NativeMessageType`)
  - `payload`: message body
  - `responseToRequestId`: response correlation id (when applicable)
  - `error`: optional error payload
- Canonical type source: `app/native-server/src/shared/types.ts`
- Primary message types (non-exhaustive):
  - `start` / `stop` / `ping` / `pong`
  - `call_tool` / `call_tool_response`
  - `server_started` / `server_stopped`
  - `error` / `error_from_native_host`

### MCP (Native Host ⇄ Qwen CLI)

- Entry point: `app/native-server/dist/mcp/mcp-server-stdio.js`
- Transport: stdio (MCP)

## Legacy protocol (deprecated)

**Deprecated**: The message types in this section are legacy-only. Do not use them for new work.

### Extension to Native Host Messages (legacy, deprecated)

The extension communicates with the native host using the following message formats:

### Handshake (Deprecated)

```
Request:
{
  "type": "handshake",
  "version": "1.0.0"
}

Response:
{
  "type": "handshake_response",
  "version": "1.0.0",
  "qwenInstalled": boolean,
  "qwenVersion": string,
  "qwenStatus": "disconnected"|"connected"|"running"
}
```

### Start Qwen CLI (Deprecated)

```
Request:
{
  "type": "start_qwen",
  "cwd": string,
  "config": object (optional)
}

Response:
{
  "success": boolean,
  "data": object,
  "error": string (if success is false)
}
```

### Send Prompt to Qwen CLI (Deprecated)

```
Request:
{
  "type": "qwen_prompt",
  "text": string
}

Response:
{
  "success": boolean,
  "data": object,
  "error": string (if success is false)
}
```

### Extract Page Data (Deprecated)

```
Request:
{
  "type": "EXTRACT_DATA"
}

Response:
{
  "success": boolean,
  "data": {
    "url": string,
    "title": string,
    "content": {
      "text": string,
      "html": string,
      "markdown": string
    },
    "links": array,
    "images": array,
    "forms": array
  },
  "error": string (if success is false)
}
```

## Browser MCP Tools

The extension provides the following MCP tools to Qwen CLI:

### browser_read_page

```
Description: Read the content of the current browser page
Input: {}
Output: {
  "url": string,
  "title": string,
  "content": string,
  "linksCount": number,
  "imagesCount": number
}
```

### browser_capture_screenshot

```
Description: Capture a screenshot of the current browser tab
Input: {}
Output: {
  "data": string (base64 encoded PNG),
  "mimeType": "image/png"
}
```

### browser_get_network_logs

```
Description: Get network request logs from the current browser tab
Input: {}
Output: {
  "text": string (JSON formatted network logs)
}
```

### browser_get_console_logs

```
Description: Get console logs from the current browser tab
Input: {}
Output: {
  "text": string (formatted console logs)
}
```

## Internal Extension Messages

The extension components communicate internally using these message formats:

### Get Status

```
Request:
{
  "type": "GET_STATUS"
}

Response:
{
  "connected": boolean,
  "status": string,
  "availableCommands": array,
  "mcpTools": array,
  "internalTools": array
}
```

### Send Message

```
Request:
{
  "type": "sendMessage",
  "data": {
    "text": string,
    "cwd": string (optional)
  }
}

Response:
{
  "success": boolean,
  "error": string (if success is false)
}
```

### Get Network Logs

```
Request:
{
  "type": "GET_NETWORK_LOGS"
}

Response:
{
  "success": boolean,
  "data": array,
  "error": string (if success is false)
}
```

## Event Types

The extension broadcasts various events:

### Status Update

```
{
  "type": "STATUS_UPDATE",
  "status": string
}
```

### Stream Start/End

```
{
  "type": "streamStart"
}
```

or

```
{
  "type": "streamEnd"
}
```

### Tool Progress

```
{
  "type": "toolProgress",
  "data": {
    "name": string,
    "stage": "start"|"end",
    "ok": boolean,
    "error": string (if applicable)
  }
}
```

## Network Log Format

Network logs returned by the browser_get_network_logs tool have the following structure:

```
{
  "method": string (e.g., "Network.requestWillBeSent"),
  "params": {
    "requestId": string,
    "request": {
      "url": string,
      "method": string,
      "headers": object
    },
    "response": {
      "status": number,
      "statusText": string,
      "headers": object
    },
    "timestamp": number
  }
}
```

## Error Handling

All API responses include error handling:

- Success responses include a `success: true` field and result data
- Error responses include a `success: false` field and an `error` string
- The native host logs detailed error information for debugging
