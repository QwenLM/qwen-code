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
        console.log('Native message received:', message);
        handleNativeMessage(message);
      });

      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Native host disconnected');
        if (error) {
          console.error('Disconnect error:', error);
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

    qwenCliStatus = message.qwenStatus || 'connected';

    // Notify popup of connection
    chrome.runtime.sendMessage({
      type: 'STATUS_UPDATE',
      status: qwenCliStatus,
      capabilities: message.capabilities
    }).catch(() => {});
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

// Handle events from Qwen CLI
function handleQwenEvent(event) {
  console.log('Qwen event:', event);

  // Forward event to content scripts and popup
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'QWEN_EVENT',
        event: event.data
      }).catch(() => {}); // Ignore errors for tabs without content script
    });
  });

  chrome.runtime.sendMessage({
    type: 'QWEN_EVENT',
    event: event.data
  }).catch(() => {});
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

  if (request.type === 'EXTRACT_PAGE_DATA') {
    // Request page data from content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'EXTRACT_DATA'
        }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message
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