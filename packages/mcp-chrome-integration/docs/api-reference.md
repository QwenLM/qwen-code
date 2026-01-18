# API Reference for Qwen CLI Chrome Extension

This document provides reference for the APIs and message formats used in the Qwen CLI Chrome Extension.

## Extension to Native Host Messages

The extension communicates with the native host using the following message formats:

### Handshake
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

### Start Qwen CLI
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

### Send Prompt to Qwen CLI
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

### Extract Page Data
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
