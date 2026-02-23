/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from './tool-names.js';

export const NETWORK_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description:
      'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: 'object',
          description:
            'Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    description:
      'Unified network capture tool. Use action="start" to begin capturing, action="stop" to end and retrieve results. Set needResponseBody=true to capture response bodies (uses Debugger API, may conflict with DevTools). Enable captureWebSocket and/or needDocumentBody to extend coverage. Default mode uses webRequest API (lightweight, no debugger conflict, but no response body).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description:
            'Action to perform: "start" begins capture, "stop" ends and returns results',
        },
        needResponseBody: {
          type: 'boolean',
          description:
            'When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content.',
        },
        needDocumentBody: {
          type: 'boolean',
          description:
            'When true, captures Document response body via Debugger API even if needResponseBody is false (default: false).',
        },
        captureWebSocket: {
          type: 'boolean',
          description:
            'When true, captures WebSocket handshake metadata and frames via Debugger API (default: false).',
        },
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. For action="start". If not provided, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in milliseconds (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description:
            'Stop after inactivity in milliseconds (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description:
            'Include static resources like images/scripts/styles (default: false)',
        },
        maxBodyChars: {
          type: 'number',
          description:
            'Maximum characters to keep per response body or WebSocket frame payload (default: 10000).',
        },
        maxWebSocketFrames: {
          type: 'number',
          description:
            'Maximum WebSocket frames to retain per connection (default: 200).',
        },
        maxWebSocketFrameChars: {
          type: 'number',
          description:
            'Maximum characters to keep per WebSocket frame payload (default: same as maxBodyChars).',
        },
        maxEntries: {
          type: 'number',
          description:
            'Maximum number of requests to include in the response (default: 100).',
        },
      },
      required: ['action'],
    },
  },
];
