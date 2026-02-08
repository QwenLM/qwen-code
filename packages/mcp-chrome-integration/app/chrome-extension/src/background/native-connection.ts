/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native Messaging Connection Management
 * Handles connection lifecycle, reconnection, and message transport
 */

import type {
  NativeHostMessage,
  PendingRequest,
  NativeMessagingAPI,
} from './native-messaging-types';

/* global chrome, console, setTimeout, clearTimeout */

const LOG_PREFIX = '[NativeMessaging]';

// Native Host configuration
const HOST_NAME = 'com.chromemcp.nativehost';

// Connection state
let nativePort: chrome.runtime.Port | null = null;
let connectionStatus = false;
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;
let manualDisconnect = false;
const pendingRequests: Map<string, PendingRequest> = new Map();

// Reconnect configuration
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * External message handler - set by native-message-handler.ts
 */
let handleNativeMessageExternal: ((message: NativeHostMessage) => void) | null =
  null;

/**
 * External broadcast function - set by native-message-handler.ts
 */
let broadcastToUIExternal: ((message: any) => void) | null = null;

/**
 * Set external message handler
 */
export function setMessageHandler(
  handler: (message: NativeHostMessage) => void,
): void {
  handleNativeMessageExternal = handler;
}

/**
 * Set external broadcast function
 */
export function setBroadcastFunction(broadcast: (message: any) => void): void {
  broadcastToUIExternal = broadcast;
}

/**
 * Broadcast message to all UI components
 */
export function broadcastToUI(message: any): void {
  if (broadcastToUIExternal) {
    broadcastToUIExternal(message);
  }
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore errors if no listeners
    });
  } catch (error) {
    // Ignore errors
  }
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Connect to Native Host
 */
export function connectNativeHost(): boolean {
  if (nativePort) {
    console.log(LOG_PREFIX, 'Already connected');
    return true;
  }

  if (manualDisconnect) {
    console.log(LOG_PREFIX, 'Manual disconnect - skipping auto-connect');
    return false;
  }

  try {
    console.log(LOG_PREFIX, 'Connecting to native host:', HOST_NAME);
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    // Set up message handler
    nativePort.onMessage.addListener((message) => {
      console.log(LOG_PREFIX, 'Received message:', message);
      if (handleNativeMessageExternal) {
        handleNativeMessageExternal(message);
      }
    });

    // Set up disconnect handler
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.warn(LOG_PREFIX, 'Disconnected from native host:', error);

      nativePort = null;
      connectionStatus = false;

      // Broadcast disconnection to UI
      broadcastToUI({
        type: 'nativeHostDisconnected',
        error: error?.message,
      });

      // Reject all pending requests
      pendingRequests.forEach((pending) => {
        pending.reject(new Error('Native host disconnected'));
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
      });
      pendingRequests.clear();

      // Auto-reconnect
      if (!manualDisconnect) {
        scheduleReconnect();
      }
    });

    connectionStatus = true;
    reconnectAttempts = 0;

    // Broadcast connection to UI
    broadcastToUI({ type: 'nativeHostConnected' });

    // Ensure native host starts the HTTP server for MCP bridging
    try {
      sendNativeMessage({ type: 'CONNECT', payload: {} });
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to send CONNECT to native host:', error);
    }

    console.log(LOG_PREFIX, 'Connected successfully');
    return true;
  } catch (error) {
    console.error(LOG_PREFIX, 'Failed to connect:', error);
    nativePort = null;
    connectionStatus = false;

    // Schedule reconnect
    scheduleReconnect();
    return false;
  }
}

/**
 * Disconnect from Native Host
 */
export function disconnectNativeHost(): void {
  console.log(LOG_PREFIX, 'Disconnecting...');
  manualDisconnect = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch (error) {
      console.error(LOG_PREFIX, 'Error disconnecting:', error);
    }
    nativePort = null;
  }

  connectionStatus = false;
  reconnectAttempts = 0;

  // Broadcast disconnection to UI
  broadcastToUI({ type: 'nativeHostDisconnected', manual: true });
}

/**
 * Schedule reconnect with exponential backoff
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (manualDisconnect) return;

  reconnectAttempts++;

  if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
    console.error(LOG_PREFIX, 'Max reconnect attempts reached');
    broadcastToUI({
      type: 'nativeHostError',
      error: 'Failed to connect after multiple attempts',
    });
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_MAX_DELAY_MS,
  );

  console.log(
    LOG_PREFIX,
    `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, delay);
}

/**
 * Send message to Native Host
 */
export function sendNativeMessage(message: NativeHostMessage): boolean {
  if (!nativePort) {
    console.error(LOG_PREFIX, 'Not connected to native host');
    return false;
  }

  try {
    nativePort.postMessage(message);
    return true;
  } catch (error) {
    console.error(LOG_PREFIX, 'Failed to send message:', error);
    return false;
  }
}

/**
 * Send message with response expectation (Promise-based)
 */
export function sendNativeMessageWithResponse(
  message: NativeHostMessage,
  timeout = 30000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!nativePort) {
      reject(new Error('Not connected to native host'));
      return;
    }

    const requestId = message.requestId || generateRequestId();
    message.requestId = requestId;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, timeout);

    // Store pending request
    pendingRequests.set(requestId, { resolve, reject, timeoutId });

    // Send message
    if (!sendNativeMessage(message)) {
      clearTimeout(timeoutId);
      pendingRequests.delete(requestId);
      reject(new Error('Failed to send message'));
    }
  });
}

/**
 * Get connection status
 */
export function getConnectionStatus(): {
  connected: boolean;
  reconnecting: boolean;
  attempts: number;
} {
  return {
    connected: connectionStatus,
    reconnecting: !!reconnectTimer,
    attempts: reconnectAttempts,
  };
}

/**
 * Check if connected
 */
export function isConnected(): boolean {
  return connectionStatus;
}

/**
 * Initialize connection exports for global scope
 */
export function initConnectionExports(): void {
  const globalScope = self as typeof self & {
    NativeMessaging?: NativeMessagingAPI;
  };

  if (!globalScope.NativeMessaging) {
    globalScope.NativeMessaging = {
      init: () => {},
      connect: connectNativeHost,
      disconnect: disconnectNativeHost,
      sendMessage: sendNativeMessage,
      sendMessageWithResponse,
      getStatus: getConnectionStatus,
      isConnected: () => connectionStatus,
    };
  }
}
