/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native Message Handler
 * Handles incoming messages from Native Host and routes them appropriately
 */

import { toCallToolResult, toErrorCallToolResult } from './mcp-tool-result';
import { normalizeToolName } from './tool-catalog';
import type { NativeHostMessage } from './native-messaging-types';
import type { ToolRouter } from './tool-router';

/* global chrome, console */

const LOG_PREFIX = '[NativeMessaging]';

/**
 * External tool router - set by main module
 */
let toolRouter: ToolRouter | null = null;

/**
 * External send message function - set by main module
 */
let sendNativeMessageExternal:
  | ((message: NativeHostMessage) => boolean)
  | null = null;

/**
 * Set tool router
 */
export function setToolRouter(router: ToolRouter): void {
  toolRouter = router;
}

/**
 * Set send message function
 */
export function setSendMessageFunction(
  send: (message: NativeHostMessage) => boolean,
): void {
  sendNativeMessageExternal = send;
}

/**
 * Send message to Native Host
 */
function sendNativeMessage(message: NativeHostMessage): boolean {
  if (sendNativeMessageExternal) {
    return sendNativeMessageExternal(message);
  }
  return false;
}

/**
 * Handle incoming message from Native Host
 */
export function handleNativeMessage(message: NativeHostMessage): void {
  console.log(LOG_PREFIX, 'Received message:', message.type, message);

  // Handle response to pending request
  if (message.responseToRequestId) {
    const requestId = message.responseToRequestId;
    // Response handling is done in connection module
    return;
  }

  // Handle call_tool messages from MCP Server (via Native Host)
  if (message.type === 'call_tool') {
    console.log(LOG_PREFIX, 'Received call_tool:', message.payload?.name);
    handleMcpToolCall(message);
    return;
  }

  // Handle server status updates
  if (message.type === 'SERVER_STARTED' || message.type === 'server_started') {
    console.log(LOG_PREFIX, 'Server started:', message.payload);
    broadcastToUI({
      type: 'serverStatus',
      status: 'running',
      port: message.payload?.port,
    });
    return;
  }

  if (message.type === 'SERVER_STOPPED' || message.type === 'server_stopped') {
    console.log(LOG_PREFIX, 'Server stopped');
    broadcastToUI({
      type: 'serverStatus',
      status: 'stopped',
    });
    return;
  }

  // Handle errors
  if (
    message.type === 'ERROR_FROM_NATIVE_HOST' ||
    message.type === 'error_from_native_host'
  ) {
    const errorMsg =
      message.payload?.message || JSON.stringify(message.payload);
    console.error(LOG_PREFIX, 'Error from native host:', errorMsg);
    console.error(LOG_PREFIX, 'Full error payload:', message.payload);
    broadcastToUI({
      type: 'nativeHostError',
      error: errorMsg,
    });
    return;
  }

  // Forward other messages to UI
  broadcastToUI(message);
}

/**
 * Handle MCP tool call from Native Host
 * Maps MCP tool names to browser tool implementations
 */
async function handleMcpToolCall(message: NativeHostMessage): Promise<void> {
  const { requestId, payload } = message;
  const toolName = payload?.name;
  const args = payload?.args || payload?.arguments || {};

  console.log(LOG_PREFIX, `Executing tool: ${toolName}`, args);

  try {
    const normalizedName = normalizeToolName(toolName);
    const handler = toolRouter?.get(normalizedName);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const result = await handler(args);

    const callToolResult = toCallToolResult(result);

    // Send success response back to Native Host
    // Format must match what register-tools.ts expects:
    // { status: 'success', data: CallToolResult }
    sendNativeMessage({
      responseToRequestId: requestId,
      payload: {
        status: 'success',
        data: callToolResult,
      },
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(LOG_PREFIX, `Tool ${toolName} failed:`, err);

    const errorResult = toErrorCallToolResult(err);

    // Send error response back to Native Host
    sendNativeMessage({
      responseToRequestId: requestId,
      payload: {
        status: 'error',
        error: err.message,
        data: errorResult,
      },
    });
  }
}

/**
 * Broadcast message to all UI components
 */
function broadcastToUI(message: any): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore errors if no listeners
    });
  } catch (error) {
    // Ignore errors
  }
}
