/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import { toCallToolResult, toErrorCallToolResult } from './mcp-tool-result';
import { createToolRouter } from './tool-router';
import { normalizeToolName } from './tool-catalog';
import {
  DEFAULT_BODY_CHAR_LIMIT,
  createWebRequestRecorder,
  mergeCapturedResponses,
  mergeDebuggerRequests,
  standardizeNetworkCapture,
} from './network-capture-utils';
import type {
  RawNetworkRequest,
  WebSocketSession,
} from './network-capture-utils';

/**
 * Native Messaging Communication Layer
 * Handles communication between Chrome Extension and Native Host via Native Messaging protocol
 */

/* global chrome, console, setTimeout, clearTimeout */

// Wrap everything in IIFE to avoid global variable conflicts
(function () {
  'use strict';

  type NativeHostMessage = {
    type?: string;
    payload?: any;
    requestId?: string;
    responseToRequestId?: string;
    [key: string]: any;
  };

  type PendingRequest = {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeoutId?: number;
  };

  type NetworkCaptureState = {
    capturing: boolean;
    tabId: number | null;
    debuggerRequests: Map<string, RawNetworkRequest>;
    webSocketSessions: Map<string, WebSocketSession>;
    startTime: number | null;
    needResponseBody?: boolean;
    needDocumentBody?: boolean;
    captureWebSocket?: boolean;
    includeStatic?: boolean;
    maxBodyChars?: number;
    maxWebSocketFrames?: number;
    maxWebSocketFrameChars?: number;
  };

  type NativeMessagingAPI = {
    init: () => void;
    connect: () => boolean;
    disconnect: () => void;
    sendMessage: (message: NativeHostMessage) => boolean;
    sendMessageWithResponse: (
      message: NativeHostMessage,
      timeout?: number,
    ) => Promise<any>;
    getStatus: () => {
      connected: boolean;
      reconnecting: boolean;
      attempts: number;
    };
    isConnected: () => boolean;
  };

  type BrowserToolArgs = Record<string, any>;

  const LOG_PREFIX = '[NativeMessaging]';

  // Native Host configuration
  const HOST_NAME = 'com.chromemcp.nativehost';

  // Connection state (now scoped to this IIFE)
  let nativePort: chrome.runtime.Port | null = null;
  let isConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  let manualDisconnect = false;
  const pendingRequests: Map<string, PendingRequest> = new Map();

  // Reconnect configuration
  const RECONNECT_BASE_DELAY_MS = 500;
  const RECONNECT_MAX_DELAY_MS = 60000;
  const RECONNECT_MAX_ATTEMPTS = 10;

  /**
   * Generate unique request ID
   */
  function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Connect to Native Host
   */
  function connectNativeHost() {
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
        handleNativeMessage(message);
      });

      // Set up disconnect handler
      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.warn(LOG_PREFIX, 'Disconnected from native host:', error);

        nativePort = null;
        isConnected = false;

        // Broadcast disconnection to UI
        broadcastToUI({
          type: 'nativeHostDisconnected',
          error: error?.message,
        });

        // Reject all pending requests
        pendingRequests.forEach((pending, requestId) => {
          pending.reject(new Error('Native host disconnected'));
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
        });
        pendingRequests.clear();

        // Auto-reconnect
        if (!manualDisconnect) {
          scheduleReconnect();
        }
      });

      isConnected = true;
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
      isConnected = false;

      // Schedule reconnect
      scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from Native Host
   */
  function disconnectNativeHost() {
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

    isConnected = false;
    reconnectAttempts = 0;

    // Broadcast disconnection to UI
    broadcastToUI({ type: 'nativeHostDisconnected', manual: true });
  }

  /**
   * Schedule reconnect with exponential backoff
   */
  function scheduleReconnect() {
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
  function sendNativeMessage(message: NativeHostMessage): boolean {
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
  function sendNativeMessageWithResponse(
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
   * Handle incoming message from Native Host
   */
  function handleNativeMessage(message: NativeHostMessage): void {
    console.log(LOG_PREFIX, 'Received message:', message.type, message);

    // Handle response to pending request
    if (message.responseToRequestId) {
      const requestId = message.responseToRequestId;
      const pending = pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingRequests.delete(requestId);

        if (message.payload?.status === 'error') {
          pending.reject(new Error(message.payload.error || 'Unknown error'));
        } else {
          pending.resolve(message.payload?.data || message.payload);
        }
      }
      return;
    }

    // Handle call_tool messages from MCP Server (via Native Host)
    if (message.type === 'call_tool') {
      console.log(LOG_PREFIX, 'Received call_tool:', message.payload?.name);
      handleMcpToolCall(message);
      return;
    }

    // Handle server status updates
    if (
      message.type === 'SERVER_STARTED' ||
      message.type === 'server_started'
    ) {
      console.log(LOG_PREFIX, 'Server started:', message.payload);
      broadcastToUI({
        type: 'serverStatus',
        status: 'running',
        port: message.payload?.port,
      });
      return;
    }

    if (
      message.type === 'SERVER_STOPPED' ||
      message.type === 'server_stopped'
    ) {
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
      const errorMsg = message.payload?.message || JSON.stringify(message.payload);
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
      let result;

      const normalizedName = normalizeToolName(toolName);
      const handler = toolRouter.get(normalizedName);
      if (!handler) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      result = await handler(args);

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

  // Browser tool implementations

  async function executeBrowserScreenshot(args: BrowserToolArgs): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        chrome.windows.WINDOW_ID_CURRENT,
        { format: 'png' },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({
              type: 'image',
              data: dataUrl,
              mimeType: 'image/png',
            });
          }
        },
      );
    });
  }

  async function executeBrowserReadPage(args: BrowserToolArgs): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    if (
      tab.url &&
      (tab.url.startsWith('chrome://') ||
        tab.url.startsWith('chrome-extension://'))
    ) {
      throw new Error('Cannot access browser internal pages');
    }

    // Inject content script and get page data
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'EXTRACT_DATA' },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve({
              url: tab.url,
              title: tab.title,
              content: response.data?.content || '',
              links: response.data?.links || [],
              images: response.data?.images || [],
            });
          } else {
            reject(new Error(response?.error || 'Failed to extract page data'));
          }
        },
      );
    });
  }

  async function executeGetWindowsAndTabs(args: BrowserToolArgs): Promise<any> {
    const windows = await chrome.windows.getAll({ populate: true });
    const result = windows.map((win) => ({
      windowId: win.id,
      focused: win.focused,
      tabs: (win.tabs || []).map((tab) => ({
        tabId: tab.id ?? null,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        index: tab.index,
      })),
    }));
    return { windows: result };
  }

  async function executeNavigate(args: BrowserToolArgs): Promise<any> {
    const { url, tabId } = args;
    if (!url) {
      throw new Error('URL is required for navigation');
    }

    let targetTabId = typeof tabId === 'number' ? tabId : undefined;
    if (targetTabId === undefined) {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      targetTabId = tabs[0]?.id;
    }

    if (targetTabId === undefined) {
      throw new Error('No active tab found');
    }

    await chrome.tabs.update(targetTabId, { url });
    return { success: true, tabId: targetTabId, url };
  }

  async function executeClickElement(args: BrowserToolArgs): Promise<any> {
    const { selector, ref } = args;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'CLICK_ELEMENT', selector, ref },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response);
          } else {
            reject(new Error(response?.error || 'Failed to click element'));
          }
        },
      );
    });
  }

  async function executeFillOrSelect(args: BrowserToolArgs): Promise<any> {
    const { selector, value, text } = args;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'FILL_INPUT', selector, text: value || text },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response);
          } else {
            reject(new Error(response?.error || 'Failed to fill input'));
          }
        },
      );
    });
  }

  async function executeGetConsoleLogs(args: BrowserToolArgs): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'GET_CONSOLE_LOGS' },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve({ logs: response.data || [] });
          } else {
            reject(new Error(response?.error || 'Failed to get console logs'));
          }
        },
      );
    });
  }

  async function executeInjectScript(args: BrowserToolArgs): Promise<any> {
    const { code, script } = args;
    const jsCode = code || script;

    if (!jsCode) {
      throw new Error('JavaScript code is required');
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'EXECUTE_CODE', code: jsCode },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve({ result: response.data });
          } else {
            reject(new Error(response?.error || 'Failed to execute code'));
          }
        },
      );
    });
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

  // Network capture state
  let networkCaptureState: NetworkCaptureState = {
    capturing: false,
    tabId: null,
    debuggerRequests: new Map(),
    webSocketSessions: new Map(),
    startTime: null,
  };
  let networkRecorder = null;
  let webRequestListener = null;
  let webRequestHeaderListener = null;
  let webRequestCompleteListener = null;
  let webRequestErrorListener = null;

  // Network capture implementation
  async function executeNetworkCapture(args: BrowserToolArgs): Promise<any> {
    const {
      action,
      needResponseBody,
      url,
      maxCaptureTime,
      inactivityTimeout,
      includeStatic,
      captureWebSocket,
      needDocumentBody,
      documentResponseBody,
      includeDocumentBody,
      maxBodyChars,
      maxWebSocketFrames,
      maxWebSocketFrameChars,
      maxEntries,
    } = args;
    const captureWebSocketEnabled = Boolean(
      captureWebSocket ?? args.includeWebSocket ?? args.needWebSocket,
    );
    const documentBodyEnabled = Boolean(
      needDocumentBody ?? documentResponseBody ?? includeDocumentBody,
    );
    const bodyCharLimit =
      typeof maxBodyChars === 'number'
        ? maxBodyChars
        : DEFAULT_BODY_CHAR_LIMIT;
    const webSocketFrameLimit =
      typeof maxWebSocketFrames === 'number' ? maxWebSocketFrames : 200;
    const webSocketFrameCharLimit =
      typeof maxWebSocketFrameChars === 'number'
        ? maxWebSocketFrameChars
        : bodyCharLimit;
    const entryLimit = typeof maxEntries === 'number' ? maxEntries : 100;
    const shouldAttachDebugger = Boolean(
      needResponseBody || captureWebSocketEnabled || documentBodyEnabled,
    );

    if (action === 'start') {
      // Get active tab
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tab = tabs[0];

      if (!tab) {
        throw new Error('No active tab found');
      }

      const tabId = tab.id;
      if (tabId === undefined) {
        throw new Error('Active tab has no id');
      }

      // Reset state
      networkCaptureState = {
        capturing: true,
        tabId,
        debuggerRequests: new Map(),
        webSocketSessions: new Map(),
        startTime: Date.now(),
        needResponseBody: needResponseBody || false,
        needDocumentBody: documentBodyEnabled,
        captureWebSocket: captureWebSocketEnabled,
        includeStatic: includeStatic || false,
        maxBodyChars: bodyCharLimit,
        maxWebSocketFrames: webSocketFrameLimit,
        maxWebSocketFrameChars: webSocketFrameCharLimit,
      };

      // Use webRequest API for request/response metadata
      setupWebRequestListeners(tabId);

      // Attach debugger for response bodies or websocket capture
      if (shouldAttachDebugger) {
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});

          // Listen for network events
          chrome.debugger.onEvent.addListener(handleDebuggerEvent);
        } catch (e) {
          console.error('Failed to attach debugger:', e);
        }
      }

      // If URL provided, navigate after listeners are ready
      if (url) {
        await chrome.tabs.update(tabId, { url });
        // Wait for navigation
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      return {
        success: true,
        message: 'Network capture started',
        tabId,
        mode: shouldAttachDebugger ? 'debugger' : 'webRequest',
        captureWebSocket: captureWebSocketEnabled,
        documentResponseBody: documentBodyEnabled,
        bodyCharLimit,
      };
    } else if (action === 'stop') {
      if (!networkCaptureState.capturing) {
        return {
          success: false,
          message: 'No capture in progress',
          requests: [],
        };
      }

      const tabId = networkCaptureState.tabId;

      // Detach debugger if attached
      if (
        (networkCaptureState.needResponseBody ||
          networkCaptureState.captureWebSocket ||
          networkCaptureState.needDocumentBody) &&
        tabId !== null
      ) {
        try {
          chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
          await chrome.debugger.detach({ tabId: tabId });
        } catch (e) {
          // Might already be detached
        }
      }

      // Stop webRequest listeners
      if (tabId !== null) {
        teardownWebRequestListeners();
      }

      // Get captured requests
      let requests = networkRecorder ? networkRecorder.getRequests() : [];
      const debuggerEntries = Array.from(
        networkCaptureState.debuggerRequests.values(),
      );
      if (requests.length === 0 && debuggerEntries.length > 0) {
        requests = debuggerEntries;
      } else {
        requests = mergeDebuggerRequests(requests, debuggerEntries);
      }
      const startTime = networkCaptureState.startTime ?? Date.now();
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Merge captured response bodies from content script (fetch/xhr patch)
      try {
        if (tabId !== null) {
          const captured = await getCapturedResponses(tabId);
          requests = mergeCapturedResponses(requests, captured);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to merge captured responses:', e);
      }

      const totalRequestCount = requests.length;
      const limitedRequests = requests.slice(0, entryLimit);
      const webSockets = Array.from(
        networkCaptureState.webSocketSessions.values(),
      );

      const capture = standardizeNetworkCapture({
        tabId,
        startedAt: startTime,
        endedAt: endTime,
        includeStatic: networkCaptureState.includeStatic,
        needResponseBody: networkCaptureState.needResponseBody,
        requests: limitedRequests,
        websockets: webSockets,
        bodyCharLimit: networkCaptureState.maxBodyChars,
      });

      // Reset state
      networkCaptureState = {
        capturing: false,
        tabId: null,
        debuggerRequests: new Map(),
        webSocketSessions: new Map(),
        startTime: null,
      };

      return {
        success: true,
        message: 'Network capture stopped',
        duration: duration,
        requestCount: totalRequestCount,
        websocketCount: capture.websockets.length,
        requests: limitedRequests,
        websockets: capture.websockets,
        capture,
      };
    }

    throw new Error('Invalid action. Use "start" or "stop"');
  }

  function setupWebRequestListeners(tabId: number): void {
    if (!chrome.webRequest) {
      console.warn(LOG_PREFIX, 'webRequest API not available');
      return;
    }

    networkRecorder = createWebRequestRecorder({
      includeStatic: !!networkCaptureState.includeStatic,
    });

    webRequestListener = (details: chrome.webRequest.WebRequestBodyDetails) => {
      if (!networkRecorder) return;
      if (details.tabId !== tabId) return;
      networkRecorder.recordBeforeRequest(details);
    };

    webRequestHeaderListener = (
      details: chrome.webRequest.WebRequestHeadersDetails,
    ) => {
      if (!networkRecorder) return;
      if (details.tabId !== tabId) return;
      networkRecorder.recordBeforeSendHeaders(details);
    };

    webRequestCompleteListener = (
      details: chrome.webRequest.WebResponseCacheDetails,
    ) => {
      if (!networkRecorder) return;
      if (details.tabId !== tabId) return;
      networkRecorder.recordCompleted(details);
    };

    webRequestErrorListener = (
      details: chrome.webRequest.WebResponseErrorDetails,
    ) => {
      if (!networkRecorder) return;
      if (details.tabId !== tabId) return;
      networkRecorder.recordError(details);
    };

    chrome.webRequest.onBeforeRequest.addListener(
      webRequestListener,
      { urls: ['<all_urls>'] },
      ['requestBody'],
    );

    chrome.webRequest.onBeforeSendHeaders.addListener(
      webRequestHeaderListener,
      { urls: ['<all_urls>'] },
      ['requestHeaders', 'extraHeaders'],
    );

    chrome.webRequest.onCompleted.addListener(
      webRequestCompleteListener,
      { urls: ['<all_urls>'] },
      ['responseHeaders', 'extraHeaders'],
    );

    chrome.webRequest.onErrorOccurred.addListener(
      webRequestErrorListener,
      { urls: ['<all_urls>'] },
    );

    console.log(LOG_PREFIX, 'webRequest listeners attached for tab:', tabId);
  }

  function teardownWebRequestListeners(): void {
    if (!chrome.webRequest) return;
    if (webRequestListener) {
      chrome.webRequest.onBeforeRequest.removeListener(webRequestListener);
    }
    if (webRequestHeaderListener) {
      chrome.webRequest.onBeforeSendHeaders.removeListener(
        webRequestHeaderListener,
      );
    }
    if (webRequestCompleteListener) {
      chrome.webRequest.onCompleted.removeListener(webRequestCompleteListener);
    }
    if (webRequestErrorListener) {
      chrome.webRequest.onErrorOccurred.removeListener(webRequestErrorListener);
    }
    webRequestListener = null;
    webRequestHeaderListener = null;
    webRequestCompleteListener = null;
    webRequestErrorListener = null;
    networkRecorder = null;
  }

  async function getCapturedResponses(tabId: number) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
    } catch (e) {
      // Script might already be injected
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'GET_CAPTURED_RESPONSES' },
        (response: any) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.data || []);
          } else {
            reject(
              new Error(response?.error || 'Failed to get captured responses'),
            );
          }
        },
      );
    });
  }

  const DEBUGGER_STATIC_TYPES = new Set([
    'Image',
    'Stylesheet',
    'Script',
    'Font',
    'Media',
    'Other',
  ]);

  function normalizeDebuggerHeaders(
    headers: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!headers) return undefined;
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[String(key).toLowerCase()] = String(value ?? '');
    }
    return normalized;
  }

  function ensureDebuggerRequest(requestId: string): RawNetworkRequest {
    let entry = networkCaptureState.debuggerRequests.get(requestId);
    if (!entry) {
      entry = {
        requestId,
        url: '',
        method: 'GET',
        source: { request: 'debugger' },
      };
      networkCaptureState.debuggerRequests.set(requestId, entry);
    }
    return entry;
  }

  function ensureWebSocketSession(
    requestId: string,
    url?: string,
  ): WebSocketSession {
    let session = networkCaptureState.webSocketSessions.get(requestId);
    if (!session) {
      session = {
        requestId,
        url: url || '',
        frames: [],
      };
      networkCaptureState.webSocketSessions.set(requestId, session);
    } else if (url && !session.url) {
      session.url = url;
    }
    return session;
  }

  function recordWebSocketFrame(
    session: WebSocketSession,
    direction: 'sent' | 'received',
    payloadData: string | undefined,
    opcode: number | undefined,
    timestamp?: number,
  ): void {
    const frameLimit = networkCaptureState.maxWebSocketFrames ?? 200;
    if (session.frames.length >= frameLimit) return;
    const maxChars =
      networkCaptureState.maxWebSocketFrameChars ??
      networkCaptureState.maxBodyChars ??
      DEFAULT_BODY_CHAR_LIMIT;
    let payload = payloadData ? String(payloadData) : '';
    let truncated = false;
    if (payload.length > maxChars) {
      payload = payload.slice(0, maxChars);
      truncated = true;
    }
    session.frames.push({
      direction,
      opcode,
      payload,
      payloadEncoding: opcode === 2 ? 'base64' : 'text',
      truncated,
      timestamp,
    });
  }

  function handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params: any,
  ): void {
    if (
      !networkCaptureState.capturing ||
      source.tabId !== networkCaptureState.tabId
    ) {
      return;
    }

    const captureTabId = networkCaptureState.tabId;
    if (captureTabId === null) {
      return;
    }

    if (
      method.startsWith('Network.webSocket') &&
      !networkCaptureState.captureWebSocket
    ) {
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      // Filter static resources if needed
      if (
        !networkCaptureState.includeStatic &&
        params?.type &&
        DEBUGGER_STATIC_TYPES.has(params.type)
      ) {
        return;
      }

      const request = ensureDebuggerRequest(params.requestId);
      request.url = params.request?.url || request.url;
      request.method = params.request?.method || request.method;
      request.headers = normalizeDebuggerHeaders(params.request?.headers);
      request.timestamp = params.timestamp;
      request.type = params.type;
      if (params.request?.postData) {
        request.requestBody = {
          raw: String(params.request.postData),
          rawEncoding: 'utf-8',
        };
      }
      request.source = {
        ...(request.source || {}),
        request: 'debugger',
      };
    }

    if (method === 'Network.responseReceived') {
      const request = ensureDebuggerRequest(params.requestId);
      request.status = params.response?.status;
      request.statusText = params.response?.statusText;
      request.type = params.type || request.type;
      request.responseHeaders = normalizeDebuggerHeaders(
        params.response?.headers,
      );
      request.mimeType = params.response?.mimeType;
      request.source = {
        ...(request.source || {}),
        response: 'debugger',
      };
    }

    if (method === 'Network.loadingFinished') {
      const request = networkCaptureState.debuggerRequests.get(
        params.requestId,
      );
      if (!request) return;
      const shouldCaptureBody =
        networkCaptureState.needResponseBody ||
        (networkCaptureState.needDocumentBody && request.type === 'Document');
      if (!shouldCaptureBody) return;

      const bodyLimit =
        networkCaptureState.maxBodyChars ?? DEFAULT_BODY_CHAR_LIMIT;

      // Get response body
      chrome.debugger.sendCommand(
        { tabId: captureTabId },
        'Network.getResponseBody',
        { requestId: params.requestId },
        (result: any) => {
          if (chrome.runtime.lastError) {
            request.error = chrome.runtime.lastError.message;
            return;
          }
          if (result && typeof result.body === 'string') {
            const truncated = result.body.length > bodyLimit;
            request.responseBody = truncated
              ? result.body.slice(0, bodyLimit)
              : result.body;
            request.bodyTruncated = truncated;
            request.responseBodyEncoding = result.base64Encoded
              ? 'base64'
              : 'utf-8';
            request.responseBodySource = 'debugger';
          }
        },
      );
    }

    if (method === 'Network.webSocketCreated') {
      const session = ensureWebSocketSession(params.requestId, params.url);
      session.createdAt = params.timestamp;
    }

    if (method === 'Network.webSocketWillSendHandshakeRequest') {
      const session = ensureWebSocketSession(params.requestId, params.url);
      session.requestHeaders = normalizeDebuggerHeaders(
        params.request?.headers,
      );
    }

    if (method === 'Network.webSocketHandshakeResponseReceived') {
      const session = ensureWebSocketSession(params.requestId);
      session.status = params.response?.status;
      session.statusText = params.response?.statusText;
      session.responseHeaders = normalizeDebuggerHeaders(
        params.response?.headers,
      );
    }

    if (method === 'Network.webSocketFrameSent') {
      const session = ensureWebSocketSession(params.requestId);
      recordWebSocketFrame(
        session,
        'sent',
        params.response?.payloadData,
        params.response?.opcode,
        params.timestamp,
      );
    }

    if (method === 'Network.webSocketFrameReceived') {
      const session = ensureWebSocketSession(params.requestId);
      recordWebSocketFrame(
        session,
        'received',
        params.response?.payloadData,
        params.response?.opcode,
        params.timestamp,
      );
    }

    if (method === 'Network.webSocketClosed') {
      const session = ensureWebSocketSession(params.requestId);
      session.closedAt = params.timestamp;
    }

    if (method === 'Network.webSocketFrameError') {
      const session = ensureWebSocketSession(params.requestId);
      session.error = params.errorMessage || 'websocket frame error';
    }
  }

  async function executeNetworkDebuggerStart(
    args: BrowserToolArgs,
  ): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    const tabId = tab.id;
    if (tabId === undefined) {
      throw new Error('Active tab has no id');
    }

    const captureWebSocketEnabled = Boolean(
      args.captureWebSocket ?? args.includeWebSocket ?? args.needWebSocket,
    );
    const documentBodyEnabled = Boolean(
      args.needDocumentBody ?? args.documentResponseBody ?? args.includeDocumentBody,
    );
    const bodyCharLimit =
      typeof args.maxBodyChars === 'number'
        ? args.maxBodyChars
        : DEFAULT_BODY_CHAR_LIMIT;
    const webSocketFrameLimit =
      typeof args.maxWebSocketFrames === 'number' ? args.maxWebSocketFrames : 200;
    const webSocketFrameCharLimit =
      typeof args.maxWebSocketFrameChars === 'number'
        ? args.maxWebSocketFrameChars
        : bodyCharLimit;

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});

      networkCaptureState = {
        capturing: true,
        tabId,
        debuggerRequests: new Map(),
        webSocketSessions: new Map(),
        startTime: Date.now(),
        needResponseBody: true,
        needDocumentBody: documentBodyEnabled,
        captureWebSocket: captureWebSocketEnabled,
        includeStatic: false,
        maxBodyChars: bodyCharLimit,
        maxWebSocketFrames: webSocketFrameLimit,
        maxWebSocketFrameChars: webSocketFrameCharLimit,
      };

      chrome.debugger.onEvent.addListener(handleDebuggerEvent);

      return {
        success: true,
        message: 'Network debugger started',
        tabId: tab.id,
      };
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`Failed to start debugger: ${err.message}`);
    }
  }

  async function executeNetworkDebuggerStop(
    args: BrowserToolArgs,
  ): Promise<any> {
    if (!networkCaptureState.capturing) {
      return {
        success: false,
        message: 'No debugger session active',
        requests: [],
      };
    }

    const tabId = networkCaptureState.tabId;

    try {
      chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
      if (tabId !== null) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // Might already be detached
    }

    const requests = Array.from(
      networkCaptureState.debuggerRequests.values(),
    );
    const startTime = networkCaptureState.startTime ?? Date.now();
    const endTime = Date.now();
    const duration = endTime - startTime;
    const entryLimit = typeof args.maxEntries === 'number' ? args.maxEntries : 100;
    const limitedRequests = requests.slice(0, entryLimit);
    const webSockets = Array.from(
      networkCaptureState.webSocketSessions.values(),
    );

    const capture = standardizeNetworkCapture({
      tabId,
      startedAt: startTime,
      endedAt: endTime,
      includeStatic: networkCaptureState.includeStatic,
      needResponseBody: networkCaptureState.needResponseBody,
      requests: limitedRequests,
      websockets: webSockets,
      bodyCharLimit: networkCaptureState.maxBodyChars,
    });

    networkCaptureState = {
      capturing: false,
      tabId: null,
      debuggerRequests: new Map(),
      webSocketSessions: new Map(),
      startTime: null,
    };

    return {
      success: true,
      message: 'Network debugger stopped',
      duration: duration,
      requestCount: requests.length,
      websocketCount: capture.websockets.length,
      requests: limitedRequests,
      websockets: capture.websockets,
      capture,
    };
  }

  async function executeNetworkRequest(args: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  }): Promise<any> {
    const { url, method = 'GET', headers = {}, body } = args;

    if (!url) {
      throw new Error('URL is required');
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        credentials: 'include',
      };

      if (body && method !== 'GET') {
        fetchOptions.body =
          typeof body === 'string' ? body : JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      const responseText = await response.text();

      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText.substring(0, 50000), // Limit size
        bodyTruncated: responseText.length > 50000,
      };
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`Network request failed: ${err.message}`);
    }
  }

  const toolRouter = createToolRouter(
    {
      chrome_screenshot: executeBrowserScreenshot,
      chrome_read_page: executeBrowserReadPage,
      get_windows_and_tabs: executeGetWindowsAndTabs,
      chrome_navigate: executeNavigate,
      chrome_click_element: executeClickElement,
      chrome_fill_or_select: executeFillOrSelect,
      chrome_console: executeGetConsoleLogs,
      chrome_inject_script: executeInjectScript,
      chrome_network_capture: executeNetworkCapture,
      chrome_network_debugger_start: executeNetworkDebuggerStart,
      chrome_network_debugger_stop: executeNetworkDebuggerStop,
      chrome_network_request: executeNetworkRequest,
    },
    (name) => async () => ({
      content: [{ type: 'text', text: `Unsupported tool in extension: ${name}` }],
      isError: true,
    }),
  );

  /**
   * Get connection status
   */
  function getConnectionStatus() {
    return {
      connected: isConnected,
      reconnecting: !!reconnectTimer,
      attempts: reconnectAttempts,
    };
  }

  /**
   * Initialize Native Messaging
   */
  function initNativeMessaging() {
    console.log(LOG_PREFIX, 'Initializing...');

    // Auto-connect on startup
    connectNativeHost();

    // Auto-connect on browser startup
    chrome.runtime.onStartup?.addListener(() => {
      console.log(LOG_PREFIX, 'Browser startup - connecting...');
      manualDisconnect = false;
      connectNativeHost();
    });

    // Auto-connect on extension install/update
    chrome.runtime.onInstalled?.addListener(() => {
      console.log(LOG_PREFIX, 'Extension installed/updated - connecting...');
      manualDisconnect = false;
      connectNativeHost();
    });

    console.log(LOG_PREFIX, 'Initialized');
  }

  // Export functions to global scope
  const globalScope = self as typeof self & {
    NativeMessaging?: NativeMessagingAPI;
  };
  globalScope.NativeMessaging = {
    init: initNativeMessaging,
    connect: connectNativeHost,
    disconnect: disconnectNativeHost,
    sendMessage: sendNativeMessage,
    sendMessageWithResponse: sendNativeMessageWithResponse,
    getStatus: getConnectionStatus,
    isConnected: () => isConnected,
  };
})(); // End of IIFE
