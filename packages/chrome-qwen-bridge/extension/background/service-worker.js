/**
 * Background Service Worker for Qwen CLI Bridge
 * Handles communication between extension components and native host
 */

// Native messaging host name
const NATIVE_HOST_NAME = 'com.qwen.cli.bridge';

// Connection state
let nativePort = null;
let isConnected = false;
let qwenCliStatus = 'disconnected';
let pendingRequests = new Map();
let requestId = 0;

// Connection management
function connectToNativeHost() {
  if (nativePort) {
    return Promise.resolve(nativePort);
  }

  return new Promise((resolve, reject) => {
    try {
      console.log('Attempting to connect to Native Host:', NATIVE_HOST_NAME);
      nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

      // Check for immediate errors
      if (chrome.runtime.lastError) {
        console.error('Chrome runtime error:', chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      nativePort.onMessage.addListener((message) => {
        // 简化日志输出，直接显示 data 内容
        if (message.type === 'event' && message.data) {
          console.log('[Native Event]', message.data.type, message.data.update || message.data);
        } else if (message.type === 'response') {
          console.log('[Native Response]', 'id:', message.id, message.success ? '✓' : '✗', message.data || message.error);
        } else {
          console.log('[Native Message]', message.type, message.data || message);
        }
        handleNativeMessage(message);
      });

      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Native host disconnected');
        if (error) {
          console.error('Disconnect error:', error);
          console.error('Disconnect error message:', error.message);
        }
        nativePort = null;
        isConnected = false;
        qwenCliStatus = 'disconnected';

        // Reject all pending requests
        for (const [id, handler] of pendingRequests) {
          handler.reject(new Error('Native host disconnected'));
        }
        pendingRequests.clear();

        // Notify popup of disconnection
        chrome.runtime.sendMessage({
          type: 'STATUS_UPDATE',
          status: 'disconnected'
        }).catch(() => {}); // Ignore errors if popup is closed
      });

      // Send initial handshake
      console.log('Sending handshake...');
      nativePort.postMessage({ type: 'handshake', version: '1.0.0' });

      // Set timeout for handshake response
      const handshakeTimeout = setTimeout(() => {
        console.error('Handshake timeout - no response from Native Host');
        if (nativePort) {
          nativePort.disconnect();
        }
        reject(new Error('Handshake timeout'));
      }, 5000);

      // Store timeout so we can clear it when we get response
      nativePort._handshakeTimeout = handshakeTimeout;

      isConnected = true;
      qwenCliStatus = 'connected';

      resolve(nativePort);
    } catch (error) {
      console.error('Failed to connect to native host:', error);
      reject(error);
    }
  });
}

// Handle messages from native host
function handleNativeMessage(message) {
  if (message.type === 'handshake_response') {
    console.log('Handshake successful:', message);

    // Clear handshake timeout
    if (nativePort && nativePort._handshakeTimeout) {
      clearTimeout(nativePort._handshakeTimeout);
      delete nativePort._handshakeTimeout;
    }

    // Native host is connected, but Qwen CLI might not be running yet
    // 'disconnected' from host means Qwen CLI is not running, but we ARE connected to native host
    const hostQwenStatus = message.qwenStatus || 'disconnected';
    // Set our status to 'connected' (to native host), or 'running' if Qwen CLI is already running
    qwenCliStatus = hostQwenStatus === 'running' ? 'running' : 'connected';

    // Notify popup of connection
    chrome.runtime.sendMessage({
      type: 'STATUS_UPDATE',
      status: qwenCliStatus,
      capabilities: message.capabilities,
      qwenInstalled: message.qwenInstalled,
      qwenVersion: message.qwenVersion
    }).catch(() => {});
  } else if (message.type === 'browser_request') {
    // Handle browser requests from Qwen CLI via Native Host
    handleBrowserRequest(message);
  } else if (message.type === 'permission_request') {
    // Forward permission request from Native Host to UI
    console.log('[Permission Request]', message);
    broadcastToUI({
      type: 'permissionRequest',
      data: {
        requestId: message.requestId,
        sessionId: message.sessionId,
        toolCall: message.toolCall,
        options: message.options
      }
    });
  } else if (message.type === 'response' && message.id !== undefined) {
    // Handle response to a specific request
    const handler = pendingRequests.get(message.id);
    if (handler) {
      if (message.error) {
        handler.reject(new Error(message.error));
      } else {
        handler.resolve(message.data);
      }
      pendingRequests.delete(message.id);
    }
  } else if (message.type === 'event') {
    // Handle events from Qwen CLI
    handleQwenEvent(message);
  }
}

// Send request to native host
async function sendToNativeHost(message) {
  if (!nativePort || !isConnected) {
    await connectToNativeHost();
  }

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });

    nativePort.postMessage({
      ...message,
      id
    });

    // Set timeout for request
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000); // 30 second timeout
  });
}

// Handle browser requests from Qwen CLI (via Native Host)
async function handleBrowserRequest(message) {
  const { browserRequestId, requestType, params } = message;
  console.log('Browser request:', requestType, params);

  try {
    let data;

    switch (requestType) {
      case 'read_page':
        data = await getBrowserPageContent();
        break;

      case 'capture_screenshot':
        data = await getBrowserScreenshot();
        break;

      case 'get_network_logs':
        data = await getBrowserNetworkLogs();
        break;

      case 'get_console_logs':
        data = await getBrowserConsoleLogs();
        break;

      default:
        throw new Error(`Unknown browser request type: ${requestType}`);
    }

    // Send response back to native host
    nativePort.postMessage({
      type: 'browser_response',
      browserRequestId,
      data
    });
  } catch (error) {
    console.error('Browser request error:', error);
    nativePort.postMessage({
      type: 'browser_response',
      browserRequestId,
      error: error.message
    });
  }
}

// Get current page content
async function getBrowserPageContent() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  // Check if we can access this page
  if (tab.url && (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))) {
    throw new Error('Cannot access browser internal page');
  }

  // Try to inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js']
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  // Request page data from content script
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message + '. Try refreshing the page.'));
      } else if (response && response.success) {
        resolve({
          url: tab.url,
          title: tab.title,
          content: response.data?.content || { text: '', markdown: '' },
          links: response.data?.links || [],
          images: response.data?.images || []
        });
      } else {
        reject(new Error(response?.error || 'Failed to extract page data'));
      }
    });
  });
}

// Capture screenshot of current tab
async function getBrowserScreenshot() {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve({ dataUrl });
      }
    });
  });
}

// Get network logs
async function getBrowserNetworkLogs() {
  // Use the existing getNetworkLogs function
  const logs = await getNetworkLogs(null);
  return { logs };
}

// Get console logs (requires content script)
async function getBrowserConsoleLogs() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  // Check if we can access this page
  if (tab.url && (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))) {
    throw new Error('Cannot access browser internal page');
  }

  // Try to inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js']
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  // Request console logs from content script
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

// Handle events from Qwen CLI (ACP events)
function handleQwenEvent(event) {
  const eventData = event.data;

  // 简化日志：显示事件类型和关键信息
  if (eventData?.type === 'session_update') {
    const update = eventData.update;
    console.log('[Qwen]', update?.sessionUpdate, update?.content?.text?.slice(0, 50) || update);
  } else {
    console.log('[Qwen]', eventData?.type, eventData);
  }

  // Map ACP events to UI-compatible messages
  if (eventData?.type === 'session_update') {
    const update = eventData.update;

    if (update?.sessionUpdate === 'agent_message_chunk') {
      // Stream chunk
      broadcastToUI({
        type: 'streamChunk',
        data: { chunk: update.content?.text || '' }
      });
    } else if (update?.sessionUpdate === 'user_message_chunk') {
      // User message (usually echo)
      broadcastToUI({
        type: 'message',
        data: {
          role: 'user',
          content: update.content?.text || '',
          timestamp: Date.now()
        }
      });
    } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      // Tool call
      broadcastToUI({
        type: 'toolCall',
        data: update
      });
    } else if (update?.sessionUpdate === 'plan') {
      // Plan update
      broadcastToUI({
        type: 'plan',
        data: { entries: update.entries }
      });
    }
  } else if (eventData?.type === 'qwen_stopped') {
    qwenCliStatus = 'stopped';
    broadcastToUI({
      type: 'STATUS_UPDATE',
      status: 'stopped'
    });
  }

  // Also forward raw event for compatibility
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'QWEN_EVENT',
        event: eventData
      }).catch(() => {});
    });
  });
}

// Broadcast message to all UI components (side panel, popup, etc.)
function broadcastToUI(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Message handlers from extension components
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request, 'from:', sender);

  if (request.type === 'CONNECT') {
    // Connect to native host
    connectToNativeHost()
      .then(() => {
        sendResponse({ success: true, status: qwenCliStatus });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }

  if (request.type === 'GET_STATUS') {
    // Get current connection status
    sendResponse({
      connected: isConnected,
      status: qwenCliStatus
    });
    return false;
  }

  // Handle sendMessage from side panel (for chat)
  if (request.type === 'sendMessage') {
    const text = request.data?.text;
    if (!text) {
      sendResponse({ success: false, error: 'No text provided' });
      return false;
    }

    // First ensure Qwen CLI is started
    const startAndSend = async () => {
      try {
        // Check if connected
        if (!isConnected) {
          await connectToNativeHost();
        }

        // Start Qwen CLI if not running
        if (qwenCliStatus !== 'running') {
          broadcastToUI({ type: 'streamStart' });
          await sendToNativeHost({
            type: 'start_qwen',
            cwd: request.data?.cwd || '/'
          });
          qwenCliStatus = 'running';
        }

        // Send the prompt
        await sendToNativeHost({
          type: 'qwen_prompt',
          text: text
        });

        sendResponse({ success: true });
      } catch (error) {
        console.error('sendMessage error:', error);
        broadcastToUI({
          type: 'error',
          data: { message: error.message }
        });
        sendResponse({ success: false, error: error.message });
      }
    };

    startAndSend();
    return true; // Will respond asynchronously
  }

  // Handle cancel streaming
  if (request.type === 'cancelStreaming') {
    sendToNativeHost({ type: 'qwen_cancel' })
      .then(() => {
        broadcastToUI({ type: 'streamEnd' });
        sendResponse({ success: true });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle permission response
  if (request.type === 'permissionResponse') {
    sendToNativeHost({
      type: 'permission_response',
      requestId: request.data?.requestId,
      optionId: request.data?.optionId
    })
    .then(() => sendResponse({ success: true }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'EXTRACT_PAGE_DATA') {
    // Request page data from content script
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        const tab = tabs[0];

        // Check if we can inject content script (skip chrome:// and other protected pages)
        if (tab.url && (tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('edge://') ||
            tab.url.startsWith('about:'))) {
          sendResponse({
            success: false,
            error: 'Cannot access this page (browser internal page)'
          });
          return;
        }

        // Try to inject content script first in case it's not loaded
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content-script.js']
          });
        } catch (injectError) {
          // Script might already be injected or page doesn't allow injection
          console.log('Script injection skipped:', injectError.message);
        }

        chrome.tabs.sendMessage(tab.id, {
          type: 'EXTRACT_DATA'
        }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message + '. Try refreshing the page.'
            });
          } else {
            sendResponse(response);
          }
        });
      } else {
        sendResponse({
          success: false,
          error: 'No active tab found'
        });
      }
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'SEND_TO_QWEN') {
    // Send data to Qwen CLI via native host
    sendToNativeHost({
      type: 'qwen_request',
      action: request.action,
      data: request.data
    })
    .then(response => {
      sendResponse({ success: true, data: response });
    })
    .catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'START_QWEN_CLI') {
    // Request native host to start Qwen CLI
    sendToNativeHost({
      type: 'start_qwen',
      config: request.config || {}
    })
    .then(response => {
      qwenCliStatus = 'running';
      sendResponse({ success: true, data: response });
    })
    .catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'STOP_QWEN_CLI') {
    // Request native host to stop Qwen CLI
    sendToNativeHost({
      type: 'stop_qwen'
    })
    .then(response => {
      qwenCliStatus = 'stopped';
      sendResponse({ success: true, data: response });
    })
    .catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'CAPTURE_SCREENSHOT') {
    // Capture screenshot of active tab
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message
        });
      } else {
        sendResponse({
          success: true,
          data: dataUrl
        });
      }
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'GET_NETWORK_LOGS') {
    // Get network logs (requires debugger API)
    getNetworkLogs(sender.tab?.id)
      .then(logs => {
        sendResponse({ success: true, data: logs });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }
});

// Network logging using debugger API
const debuggerTargets = new Map();

async function getNetworkLogs(tabId) {
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
    if (!tabId) throw new Error('No active tab found');
  }

  // Check if debugger is already attached
  if (!debuggerTargets.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');

    // Store network logs
    debuggerTargets.set(tabId, { logs: [] });

    // Listen for network events
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === tabId) {
        const target = debuggerTargets.get(tabId);
        if (target && method.startsWith('Network.')) {
          target.logs.push({
            method,
            params,
            timestamp: Date.now()
          });
        }
      }
    });
  }

  const target = debuggerTargets.get(tabId);
  return target?.logs || [];
}

// Clean up debugger on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerTargets.has(tabId)) {
    chrome.debugger.detach({ tabId });
    debuggerTargets.delete(tabId);
  }
});

// Listen for extension installation or update
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed/updated:', details);

  if (details.reason === 'install') {
    // Just log the installation, don't auto-open options
    console.log('Extension installed for the first time');
    // Users can access options from popup menu
  }
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    connectToNativeHost,
    sendToNativeHost
  };
}