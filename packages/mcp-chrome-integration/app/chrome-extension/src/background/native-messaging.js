/**
 * Native Messaging Communication Layer
 * Handles communication between Chrome Extension and Native Host via Native Messaging protocol
 */

/* global chrome, console, setTimeout, clearTimeout */

// Wrap everything in IIFE to avoid global variable conflicts
(function() {
  'use strict';

  const LOG_PREFIX = '[NativeMessaging]';

  // Native Host configuration
  const HOST_NAME = 'com.chromemcp.nativehost';

  // Connection state (now scoped to this IIFE)
  let nativePort = null;
  let isConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let manualDisconnect = false;
  let pendingRequests = new Map();

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
      broadcastToUI({ type: 'nativeHostDisconnected', error: error?.message });

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

    // Send initial connection message
    sendNativeMessage({
      type: 'CONNECT',
      payload: { timestamp: Date.now() }
    });

    isConnected = true;
    reconnectAttempts = 0;

    // Broadcast connection to UI
    broadcastToUI({ type: 'nativeHostConnected' });

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
      error: 'Failed to connect after multiple attempts'
    });
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_MAX_DELAY_MS
  );

  console.log(LOG_PREFIX, `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, delay);
}

/**
 * Send message to Native Host
 */
function sendNativeMessage(message) {
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
function sendNativeMessageWithResponse(message, timeout = 30000) {
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
function handleNativeMessage(message) {
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
  if (message.type === 'SERVER_STARTED' || message.type === 'server_started') {
    console.log(LOG_PREFIX, 'Server started:', message.payload);
    broadcastToUI({
      type: 'serverStatus',
      status: 'running',
      port: message.payload?.port
    });
    return;
  }

  if (message.type === 'SERVER_STOPPED' || message.type === 'server_stopped') {
    console.log(LOG_PREFIX, 'Server stopped');
    broadcastToUI({
      type: 'serverStatus',
      status: 'stopped'
    });
    return;
  }

  // Handle errors
  if (message.type === 'ERROR_FROM_NATIVE_HOST' || message.type === 'error_from_native_host') {
    console.error(LOG_PREFIX, 'Error from native host:', message.payload);
    broadcastToUI({
      type: 'nativeHostError',
      error: message.payload?.message
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
async function handleMcpToolCall(message) {
  const { requestId, payload } = message;
  const toolName = payload?.name;
  const args = payload?.args || payload?.arguments || {};

  console.log(LOG_PREFIX, `Executing tool: ${toolName}`, args);

  try {
    let result;

    // Map MCP tool names to browser operations
    switch (toolName) {
      case 'chrome_screenshot':
      case 'browser_capture_screenshot':
        result = await executeBrowserScreenshot(args);
        break;

      case 'chrome_read_page':
      case 'browser_read_page':
        result = await executeBrowserReadPage(args);
        break;

      case 'get_windows_and_tabs':
      case 'chrome_get_tabs':
        result = await executeGetWindowsAndTabs(args);
        break;

      case 'chrome_navigate':
        result = await executeNavigate(args);
        break;

      case 'chrome_click_element':
      case 'browser_click':
        result = await executeClickElement(args);
        break;

      case 'chrome_fill_or_select':
      case 'browser_fill_form':
      case 'browser_input_text':
        result = await executeFillOrSelect(args);
        break;

      case 'chrome_console':
      case 'browser_get_console_logs':
        result = await executeGetConsoleLogs(args);
        break;

      case 'chrome_inject_script':
      case 'browser_run_js':
        result = await executeInjectScript(args);
        break;

      // Network capture tools
      case 'chrome_network_capture':
        result = await executeNetworkCapture(args);
        break;

      case 'chrome_network_debugger_start':
        result = await executeNetworkDebuggerStart(args);
        break;

      case 'chrome_network_debugger_stop':
        result = await executeNetworkDebuggerStop(args);
        break;

      case 'chrome_network_request':
        result = await executeNetworkRequest(args);
        break;

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    // Send success response back to Native Host
    // Format must match what register-tools.ts expects:
    // { status: 'success', data: CallToolResult }
    sendNativeMessage({
      responseToRequestId: requestId,
      payload: {
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      }
    });
  } catch (error) {
    console.error(LOG_PREFIX, `Tool ${toolName} failed:`, error);

    // Send error response back to Native Host
    sendNativeMessage({
      responseToRequestId: requestId,
      payload: {
        status: 'error',
        error: error.message,
        data: {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        }
      }
    });
  }
}

// Browser tool implementations

async function executeBrowserScreenshot(args) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve({
          type: 'image',
          data: dataUrl,
          mimeType: 'image/png'
        });
      }
    });
  });
}

async function executeBrowserReadPage(args) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('Cannot access browser internal pages');
  }

  // Inject content script and get page data
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (e) {
    // Script might already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve({
          url: tab.url,
          title: tab.title,
          content: response.data?.content || '',
          links: response.data?.links || [],
          images: response.data?.images || []
        });
      } else {
        reject(new Error(response?.error || 'Failed to extract page data'));
      }
    });
  });
}

async function executeGetWindowsAndTabs(args) {
  const windows = await chrome.windows.getAll({ populate: true });
  const result = windows.map(win => ({
    windowId: win.id,
    focused: win.focused,
    tabs: win.tabs.map(tab => ({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      index: tab.index
    }))
  }));
  return { windows: result };
}

async function executeNavigate(args) {
  const { url, tabId } = args;
  if (!url) {
    throw new Error('URL is required for navigation');
  }

  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tabs[0]?.id;
  }

  if (!targetTabId) {
    throw new Error('No active tab found');
  }

  await chrome.tabs.update(targetTabId, { url });
  return { success: true, tabId: targetTabId, url };
}

async function executeClickElement(args) {
  const { selector, ref } = args;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (e) {
    // Script might already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'CLICK_ELEMENT', selector, ref }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Failed to click element'));
      }
    });
  });
}

async function executeFillOrSelect(args) {
  const { selector, value, text } = args;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (e) {
    // Script might already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'FILL_INPUT', selector, text: value || text }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Failed to fill input'));
      }
    });
  });
}

async function executeGetConsoleLogs(args) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (e) {
    // Script might already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CONSOLE_LOGS' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve({ logs: response.data || [] });
      } else {
        reject(new Error(response?.error || 'Failed to get console logs'));
      }
    });
  });
}

async function executeInjectScript(args) {
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

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (e) {
    // Script might already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_CODE', code: jsCode }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve({ result: response.data });
      } else {
        reject(new Error(response?.error || 'Failed to execute code'));
      }
    });
  });
}

/**
 * Broadcast message to all UI components
 */
function broadcastToUI(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore errors if no listeners
    });
  } catch (error) {
    // Ignore errors
  }
}

// Network capture state
let networkCaptureState = {
  capturing: false,
  tabId: null,
  requests: [],
  startTime: null
};

// Network capture implementation
async function executeNetworkCapture(args) {
  const { action, needResponseBody, url, maxCaptureTime, inactivityTimeout, includeStatic } = args;

  if (action === 'start') {
    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found');
    }

    // If URL provided, navigate first
    if (url) {
      await chrome.tabs.update(tab.id, { url });
      // Wait for navigation
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Reset state
    networkCaptureState = {
      capturing: true,
      tabId: tab.id,
      requests: [],
      startTime: Date.now(),
      needResponseBody: needResponseBody || false,
      includeStatic: includeStatic || false
    };

    // If needResponseBody, use debugger API
    if (needResponseBody) {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});

        // Listen for network events
        chrome.debugger.onEvent.addListener(handleDebuggerEvent);
      } catch (e) {
        console.error('Failed to attach debugger:', e);
        // Fall back to webRequest API
        setupWebRequestListeners(tab.id);
      }
    } else {
      // Use webRequest API (lighter weight)
      setupWebRequestListeners(tab.id);
    }

    return {
      success: true,
      message: 'Network capture started',
      tabId: tab.id,
      mode: needResponseBody ? 'debugger' : 'webRequest'
    };

  } else if (action === 'stop') {
    if (!networkCaptureState.capturing) {
      return {
        success: false,
        message: 'No capture in progress',
        requests: []
      };
    }

    const tabId = networkCaptureState.tabId;

    // Detach debugger if attached
    if (networkCaptureState.needResponseBody) {
      try {
        chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
        await chrome.debugger.detach({ tabId: tabId });
      } catch (e) {
        // Might already be detached
      }
    }

    // Get captured requests
    const requests = [...networkCaptureState.requests];
    const duration = Date.now() - networkCaptureState.startTime;

    // Reset state
    networkCaptureState = {
      capturing: false,
      tabId: null,
      requests: [],
      startTime: null
    };

    return {
      success: true,
      message: 'Network capture stopped',
      duration: duration,
      requestCount: requests.length,
      requests: requests.slice(0, 100) // Limit to 100 requests
    };
  }

  throw new Error('Invalid action. Use "start" or "stop"');
}

function setupWebRequestListeners(tabId) {
  // This is a simplified implementation
  // Full implementation would use chrome.webRequest API
  console.log(LOG_PREFIX, 'Setting up webRequest listeners for tab:', tabId);
}

function handleDebuggerEvent(source, method, params) {
  if (!networkCaptureState.capturing || source.tabId !== networkCaptureState.tabId) {
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const request = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      timestamp: params.timestamp,
      type: params.type
    };

    // Filter static resources if needed
    if (!networkCaptureState.includeStatic) {
      const staticTypes = ['Image', 'Stylesheet', 'Script', 'Font'];
      if (staticTypes.includes(params.type)) {
        return;
      }
    }

    networkCaptureState.requests.push(request);
  }

  if (method === 'Network.responseReceived') {
    const request = networkCaptureState.requests.find(r => r.requestId === params.requestId);
    if (request) {
      request.status = params.response.status;
      request.statusText = params.response.statusText;
      request.responseHeaders = params.response.headers;
      request.mimeType = params.response.mimeType;
    }
  }

  if (method === 'Network.loadingFinished' && networkCaptureState.needResponseBody) {
    const request = networkCaptureState.requests.find(r => r.requestId === params.requestId);
    if (request) {
      // Get response body
      chrome.debugger.sendCommand(
        { tabId: networkCaptureState.tabId },
        'Network.getResponseBody',
        { requestId: params.requestId },
        (result) => {
          if (result && result.body) {
            request.responseBody = result.body.substring(0, 10000); // Limit size
            request.bodyTruncated = result.body.length > 10000;
          }
        }
      );
    }
  }
}

async function executeNetworkDebuggerStart(args) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});

    networkCaptureState = {
      capturing: true,
      tabId: tab.id,
      requests: [],
      startTime: Date.now(),
      needResponseBody: true,
      includeStatic: false
    };

    chrome.debugger.onEvent.addListener(handleDebuggerEvent);

    return {
      success: true,
      message: 'Network debugger started',
      tabId: tab.id
    };
  } catch (e) {
    throw new Error(`Failed to start debugger: ${e.message}`);
  }
}

async function executeNetworkDebuggerStop(args) {
  if (!networkCaptureState.capturing) {
    return {
      success: false,
      message: 'No debugger session active',
      requests: []
    };
  }

  const tabId = networkCaptureState.tabId;

  try {
    chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
    await chrome.debugger.detach({ tabId: tabId });
  } catch (e) {
    // Might already be detached
  }

  const requests = [...networkCaptureState.requests];
  const duration = Date.now() - networkCaptureState.startTime;

  networkCaptureState = {
    capturing: false,
    tabId: null,
    requests: [],
    startTime: null
  };

  return {
    success: true,
    message: 'Network debugger stopped',
    duration: duration,
    requestCount: requests.length,
    requests: requests.slice(0, 100)
  };
}

async function executeNetworkRequest(args) {
  const { url, method = 'GET', headers = {}, body } = args;

  if (!url) {
    throw new Error('URL is required');
  }

  try {
    const fetchOptions = {
      method: method,
      headers: headers,
      credentials: 'include' // Include cookies
    };

    if (body && method !== 'GET') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseText.substring(0, 50000), // Limit size
      bodyTruncated: responseText.length > 50000
    };
  } catch (e) {
    throw new Error(`Network request failed: ${e.message}`);
  }
}

/**
 * Get connection status
 */
function getConnectionStatus() {
  return {
    connected: isConnected,
    reconnecting: !!reconnectTimer,
    attempts: reconnectAttempts
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
self.NativeMessaging = {
  init: initNativeMessaging,
  connect: connectNativeHost,
  disconnect: disconnectNativeHost,
  sendMessage: sendNativeMessage,
  sendMessageWithResponse: sendNativeMessageWithResponse,
  getStatus: getConnectionStatus,
  isConnected: () => isConnected
};

})(); // End of IIFE
