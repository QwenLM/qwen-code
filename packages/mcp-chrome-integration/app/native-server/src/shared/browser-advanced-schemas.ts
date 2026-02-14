/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from './tool-names.js';

export const ADVANCED_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult a read_page to determine the ref of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try screenshot and then adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target tab ID (default: active tab)',
        },
        background: {
          type: 'boolean',
          description:
            'Avoid focusing/activating tab/window for certain operations (best-effort). Default: false',
        },
        action: {
          type: 'string',
          description:
            'Action to perform: left_click | right_click | double_click | triple_click | left_click_drag | scroll | scroll_to | type | key | fill | fill_form | hover | wait | resize_page | zoom | screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          description:
            'Coordinates for actions (in screenshot space if a recent screenshot was taken, otherwise viewport). Required for click/scroll and as end point for drag.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag action',
        },
        startRef: {
          type: 'string',
          description:
            'Drag start ref from chrome_read_page (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        repeat: {
          type: 'number',
          description:
            'For action=key: number of times to repeat the key sequence (integer 1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description:
            'Modifier keys for click actions (left_click/right_click/double_click/triple_click).',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          type: 'object',
          description:
            'For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels (or screenshot-space if a recent screenshot context exists).',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description:
            'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description:
            'For action=fill_form: list of elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: {
                type: 'string',
                description: 'Element ref from chrome_read_page',
              },
              value: {
                type: 'string',
                description: 'Value to set (stringified if non-string)',
              },
            },
            required: ['ref', 'value'],
          },
        },
        width: {
          type: 'number',
          description: 'For action=resize_page: viewport width',
        },
        height: {
          type: 'number',
          description: 'For action=resize_page: viewport height',
        },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        timeout: {
          type: 'number',
          description:
            'For action=wait with text: timeout in milliseconds (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description:
      'Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), and text input. Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description:
            'Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World".',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector or XPath for target element to receive keyboard events.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        delay: {
          type: 'number',
          description:
            'Delay between keystrokes in milliseconds (default: 50).',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description:
            'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    description:
      'Execute JavaScript code in a browser tab and return the result. Uses CDP Runtime.evaluate with awaitPromise and returnByValue; automatically falls back to chrome.scripting.executeScript if the debugger is busy. Output is sanitized (sensitive data redacted) and truncated by default.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported.',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab ID. If omitted, uses the current active tab.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 15000).',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit will be truncated.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description:
            'Target window ID to pick active tab when tabId is omitted.',
        },
        background: {
          type: 'boolean',
          description:
            'Do not activate tab/focus window when capturing via CDP. Default: false',
        },
        includeExceptions: {
          type: 'boolean',
          description:
            'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description:
            'Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence.',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly).',
        },
        buffer: {
          type: 'boolean',
          description: 'Alias for mode="buffer" (default: false).',
        },
        clear: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading (mcp-tools.js style).',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false). This matches mcp-tools.js behavior.',
        },
        pattern: {
          type: 'string',
          description:
            'Optional regex filter applied to message/exception text. Supports /pattern/flags syntax.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only return error-level console messages (and exceptions when includeExceptions=true). Default: false.',
        },
        limit: {
          type: 'number',
          description:
            'Limit returned console messages. In snapshot mode this is an alias for maxMessages; in buffer mode it limits returned messages from the buffer.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to web forms with file input elements using Chrome DevTools Protocol',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target tab ID (default: active tab)',
        },
        windowId: {
          type: 'number',
          description:
            'Target window ID to pick active tab when tabId is omitted',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the file input element (input[type="file"])',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description:
            'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description:
            'Whether the input accepts multiple files (default: false)',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    description:
      'Wait for a browser download and return details (id, filename, url, state, size)',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: {
          type: 'string',
          description: 'Filter by substring in filename or URL',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms (default 60000, max 300000)',
        },
        waitForComplete: {
          type: 'boolean',
          description: 'Wait until completed (default true)',
        },
      },
      required: [],
    },
  },
];
