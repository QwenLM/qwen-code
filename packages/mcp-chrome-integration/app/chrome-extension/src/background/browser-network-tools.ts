/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser Network Tools
 * Implements network capture and debugging tools for the MCP protocol
 */

import {
  DEFAULT_BODY_CHAR_LIMIT,
  createWebRequestRecorder,
  mergeCapturedResponses,
  mergeDebuggerRequests,
  standardizeNetworkCapture,
} from './network-capture-utils';
import type {
  BrowserToolArgs,
  RawNetworkRequest,
  WebSocketSession,
  NetworkCaptureState,
} from './native-messaging-types';

/* global chrome, console, setTimeout */

const LOG_PREFIX = '[NativeMessaging]';

// Network capture state
let networkCaptureState: NetworkCaptureState = {
  capturing: false,
  tabId: null,
  debuggerRequests: new Map(),
  webSocketSessions: new Map(),
  startTime: null,
};
let networkRecorder: ReturnType<typeof createWebRequestRecorder> | null = null;
let webRequestListener: ((details: any) => void) | null = null;
let webRequestHeaderListener: ((details: any) => void) | null = null;
let webRequestCompleteListener: ((details: any) => void) | null = null;
let webRequestErrorListener: ((details: any) => void) | null = null;

const DEBUGGER_STATIC_TYPES = new Set([
  'Image',
  'Stylesheet',
  'Script',
  'Font',
  'Media',
  'Other',
]);

/**
 * Setup webRequest listeners for network capture
 */
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

  chrome.webRequest.onErrorOccurred.addListener(webRequestErrorListener, {
    urls: ['<all_urls>'],
  });

  console.log(LOG_PREFIX, 'webRequest listeners attached for tab:', tabId);
}

/**
 * Teardown webRequest listeners
 */
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

/**
 * Get captured responses from content script
 */
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

/**
 * Normalize debugger headers
 */
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

/**
 * Ensure debugger request exists and return it
 */
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

/**
 * Ensure WebSocket session exists and return it
 */
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

/**
 * Record WebSocket frame
 */
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

/**
 * Handle debugger events
 */
export function handleDebuggerEvent(
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
    const request = networkCaptureState.debuggerRequests.get(params.requestId);
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
    session.requestHeaders = normalizeDebuggerHeaders(params.request?.headers);
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

/**
 * Execute network capture
 */
export async function executeNetworkCapture(
  args: BrowserToolArgs,
): Promise<any> {
  const {
    action,
    needResponseBody,
    url,
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
    typeof maxBodyChars === 'number' ? maxBodyChars : DEFAULT_BODY_CHAR_LIMIT;
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

/**
 * Execute network debugger start
 */
export async function executeNetworkDebuggerStart(
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
    args.needDocumentBody ??
      args.documentResponseBody ??
      args.includeDocumentBody,
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

/**
 * Execute network debugger stop
 */
export async function executeNetworkDebuggerStop(
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

  const requests = Array.from(networkCaptureState.debuggerRequests.values());
  const startTime = networkCaptureState.startTime ?? Date.now();
  const endTime = Date.now();
  const duration = endTime - startTime;
  const entryLimit =
    typeof args.maxEntries === 'number' ? args.maxEntries : 100;
  const limitedRequests = requests.slice(0, entryLimit);
  const webSockets = Array.from(networkCaptureState.webSocketSessions.values());

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

/**
 * Execute network request
 */
export async function executeNetworkRequest(args: {
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

/**
 * Check if network capture is in progress
 */
export function isNetworkCapturing(): boolean {
  return networkCaptureState.capturing;
}
