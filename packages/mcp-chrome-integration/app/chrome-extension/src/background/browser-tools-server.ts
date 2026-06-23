/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser-tools MCP server over the `qwen serve` daemon WebSocket — the
 * extension side of Phase 2's "reverse tool channel" (issue #5626).
 *
 * A browser extension cannot listen as an MCP server, so the daemon-resident
 * agent reaches the browser tools through a reverse channel: the extension
 * connects to the daemon's `/acp` WebSocket, advertises a server name with
 * `mcp_register`, and then services inbound `mcp_message` frames whose payload
 * is plain MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`). Each reply
 * is sent back as another `mcp_message` frame correlated by `id`.
 *
 * This module deliberately hand-rolls the tiny JSON-RPC dispatch instead of
 * pulling `@modelcontextprotocol/sdk` into the MV3 service-worker bundle — the
 * surface is just three methods. Tool execution reuses the kept browser-tool
 * layer (`tool-router.ts` + the executors), so behaviour stays identical to the
 * native-messaging transport.
 */

import {
  executeBrowserScreenshot,
  executeBrowserReadPage,
  executeNavigate,
  executeClickElement,
  executeFillOrSelect,
  executeGetConsoleLogs,
} from './browser-tool-executors';
import { createToolRouter } from './tool-router';
import { normalizeToolName } from './tool-catalog';
import { toCallToolResult, toErrorCallToolResult } from './mcp-tool-result';
import { getDaemonConfig } from '../daemon/config.js';

/* global WebSocket, console, setTimeout, clearTimeout */

const LOG_PREFIX = '[BrowserToolsServer]';

/** Name this client advertises to the daemon via `mcp_register`. */
const SERVER_NAME = 'chrome-tools';

/** MCP protocol revision we negotiate during `initialize`. */
const PROTOCOL_VERSION = '2025-06-18';

/** Reconnect backoff bounds (ms). */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// --- Tool router (same construction as native-messaging.ts) ----------------

/**
 * Build the tool router from the existing executors. We only register the MVP
 * read-first catalog here; unknown-but-known tool names fall through to an
 * "unsupported" stub so the agent gets a clean error instead of a hang.
 */
const toolRouter = createToolRouter(
  {
    chrome_screenshot: executeBrowserScreenshot,
    chrome_read_page: executeBrowserReadPage,
    chrome_navigate: executeNavigate,
    chrome_click_element: executeClickElement,
    chrome_fill_or_select: executeFillOrSelect,
    chrome_console: executeGetConsoleLogs,
  },
  (name: string) => async () => ({
    content: [{ type: 'text', text: `Unsupported tool in extension: ${name}` }],
    isError: true,
  }),
);

// --- MVP tool catalog (tools/list) -----------------------------------------

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Minimal JSON Schemas for the ~6 read-first MVP tools. The extension's shared
 * schema source isn't importable from the background bundle, so these are kept
 * inline and intentionally permissive — the executors validate the arguments
 * they actually use.
 */
const TOOL_CATALOG: McpToolDefinition[] = [
  {
    name: 'chrome_read_page',
    description:
      'Extract the active tab\'s text content, links, and images as structured data.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'chrome_screenshot',
    description: 'Capture a PNG screenshot of the active tab.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'chrome_console',
    description: 'Read the captured console log entries from the active tab.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'chrome_navigate',
    description: 'Navigate a tab to a URL (defaults to the active tab).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL.' },
        tabId: {
          type: 'number',
          description: 'Target tab id; defaults to the active tab.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'chrome_click_element',
    description: 'Click an element in the active tab by CSS selector or ref.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        ref: { type: 'string', description: 'Element reference id.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'chrome_fill_or_select',
    description:
      'Fill an input or select an option in the active tab by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        value: { type: 'string', description: 'Value to fill or select.' },
        text: {
          type: 'string',
          description: 'Alias for value (legacy callers).',
        },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
];

// --- Minimal MCP JSON-RPC dispatch -----------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

type JsonRpcResponse =
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      result: unknown;
    }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

/** JSON-RPC error: method not found. */
const METHOD_NOT_FOUND = -32601;
/** JSON-RPC error: internal error (tool execution failure, bad request). */
const INTERNAL_ERROR = -32603;

/**
 * Dispatch a single inbound MCP JSON-RPC payload and resolve to the response
 * payload (or `null` for notifications, which carry no `id`). Never throws —
 * tool failures are surfaced either as a JSON-RPC error or an `isError` result.
 */
async function dispatchMcpRequest(
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = request;

  // Notifications (no id) get no response per the JSON-RPC spec.
  if (id === undefined || id === null) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: '1.0.0' },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOL_CATALOG },
        };

      case 'tools/call': {
        const callParams = (params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const rawName = callParams.name;
        if (!rawName) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: INTERNAL_ERROR, message: 'Missing tool name' },
          };
        }
        const toolName = normalizeToolName(rawName);
        const handler = toolRouter.get(toolName);
        if (!handler) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Unknown tool: ${toolName}`,
            },
          };
        }
        try {
          const raw = await handler(callParams.arguments ?? {});
          return { jsonrpc: '2.0', id, result: toCallToolResult(raw) };
        } catch (error) {
          // Tool failures are reported as an MCP result with isError set so the
          // agent sees the message rather than a transport-level fault.
          return { jsonrpc: '2.0', id, result: toErrorCallToolResult(error) };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: METHOD_NOT_FOUND,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// --- WebSocket frame contract (per docs/05-daemon-direct-architecture.md) ---

interface McpFrame {
  type: 'mcp_register' | 'mcp_message' | 'mcp_unregister';
  server: string;
  /** Correlation id for `mcp_message` request/response pairs. */
  id?: string | number;
  /** JSON-RPC payload for `mcp_message`. */
  payload?: unknown;
  /** Tool catalog advertised on `mcp_register`. */
  tools?: McpToolDefinition[];
}

// --- WebSocket client with reconnect ---------------------------------------

let socket: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

/** Translate the daemon's HTTP base URL into the `/acp` WebSocket URL. */
function toWebSocketUrl(baseUrl: string, token?: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http/i, 'ws');
  const url = `${wsBase}/acp`;
  // Loopback daemons are auth-free; for token-gated daemons pass it as a query
  // param since the WebSocket handshake can't carry an Authorization header.
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/** Send a frame if the socket is open; swallow send failures (close handles it). */
function sendFrame(frame: McpFrame): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to send frame:', error);
  }
}

/** Handle one inbound `mcp_message` frame: dispatch and reply by `id`. */
async function handleMcpMessage(frame: McpFrame): Promise<void> {
  const request = frame.payload as JsonRpcRequest;
  const response = await dispatchMcpRequest(request);
  if (response === null) return; // notification — no reply
  sendFrame({
    type: 'mcp_message',
    server: SERVER_NAME,
    id: frame.id,
    payload: response,
  });
}

/** Parse and route an inbound WS frame. */
function onWsMessage(data: unknown): void {
  let frame: McpFrame;
  try {
    frame = JSON.parse(String(data)) as McpFrame;
  } catch {
    return; // ignore non-JSON / unrelated frames
  }
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'mcp_message' && frame.server === SERVER_NAME) {
    void handleMcpMessage(frame);
  }
  // Other frame types (chat/session traffic on the shared /acp socket) are not
  // ours; ignore them.
}

/** Schedule a reconnect with capped exponential backoff. */
function scheduleReconnect(): void {
  if (!started || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  console.log(LOG_PREFIX, `Reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** Open the WebSocket and wire up handlers. */
async function connect(): Promise<void> {
  if (!started) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;

  let url: string;
  try {
    const config = await getDaemonConfig();
    url = toWebSocketUrl(config.baseUrl, config.token);
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to read daemon config:', error);
    scheduleReconnect();
    return;
  }

  console.log(LOG_PREFIX, 'Connecting to', url);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (error) {
    console.warn(LOG_PREFIX, 'WebSocket construction failed:', error);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    console.log(LOG_PREFIX, 'Connected; registering', SERVER_NAME);
    // Advertise the server name + catalog so the daemon can register a runtime
    // SDK-type MCP server backed by this socket.
    sendFrame({
      type: 'mcp_register',
      server: SERVER_NAME,
      tools: TOOL_CATALOG,
    });
  };

  ws.onmessage = (event: MessageEvent) => onWsMessage(event.data);

  ws.onerror = (event: Event) => {
    console.warn(LOG_PREFIX, 'WebSocket error', event);
  };

  ws.onclose = () => {
    console.log(LOG_PREFIX, 'Disconnected');
    if (socket === ws) socket = null;
    scheduleReconnect();
  };
}

/**
 * Start the browser-tools MCP server: connect to the daemon `/acp` WebSocket
 * and register the `chrome-tools` server. Idempotent.
 */
export function startBrowserToolsServer(): void {
  if (started) return;
  started = true;
  reconnectDelay = RECONNECT_MIN_MS;
  void connect();
}

/**
 * Stop the server: unregister, close the socket, and cancel any reconnect.
 * Idempotent.
 */
export function stopBrowserToolsServer(): void {
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      sendFrame({ type: 'mcp_unregister', server: SERVER_NAME });
    }
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
  }
}
