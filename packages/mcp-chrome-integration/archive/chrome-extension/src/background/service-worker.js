/**
 * Background Service Worker for Qwen CLI Chrome Extension
 * Handles communication between extension components and native host
 */

/* global chrome, console, setTimeout, clearTimeout, fetch, AbortController, EventSource, URL */

// Backend HTTP endpoint (replaces Native Messaging)
const BACKEND_URL = 'http://127.0.0.1:18765';

// Connection state
let isConnected = false;
let qwenCliStatus = 'disconnected';
let pendingRequests = new Map();
let eventPollerStarted = false;
// Track permission requests we've already answered (avoid duplicate prompts)
const handledPermissionRequests = new Set();
const permissionKey = (reqId, sessionId) =>
  `${sessionId || 'no-session'}:${reqId}`;
// Cache the latest available commands so late listeners (e.g. sidepanel opened later)
// can fetch them via GET_STATUS.
let lastAvailableCommands = [];
// Cache latest MCP tools list (from notifications/tools/list_changed)
let lastMcpTools = [];
// Debounce stream end to avoid cutting off late chunks
let streamEndTimeout = null;
const STREAM_END_DEBOUNCE_MS = 300;

function scheduleStreamEnd() {
  if (streamEndTimeout) clearTimeout(streamEndTimeout);
  streamEndTimeout = setTimeout(() => {
    streamEndTimeout = null;
    broadcastToUI({ type: 'streamEnd' });
  }, STREAM_END_DEBOUNCE_MS);
}

// Basic HTTP call helper
async function callBackend(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${BACKEND_URL}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

// Connection management (HTTP handshake)
async function connectToNativeHost() {
  if (isConnected) return true;
  console.log('Attempting to connect to HTTP backend:', BACKEND_URL);
  try {
    const handshake = await callBackend({
      type: 'handshake',
      version: '1.0.0',
    });
    isConnected = true;
    qwenCliStatus = handshake?.qwenStatus || 'connected';
    // Notify popup
    chrome.runtime
      .sendMessage({
        type: 'STATUS_UPDATE',
        status: qwenCliStatus,
        capabilities: handshake?.capabilities,
        qwenInstalled: handshake?.qwenInstalled,
        qwenVersion: handshake?.qwenVersion,
      })
      .catch(() => {});
    // Start event polling once connected
    if (!eventPollerStarted) {
      eventPollerStarted = true;
      startEventPolling();
    }
    return true;
  } catch (error) {
    console.error('Failed to connect to backend:', error);
    isConnected = false;
    qwenCliStatus = 'disconnected';
    throw error;
  }
}

// SSE event stream from backend (fallback to polling if needed)
async function startEventPolling() {
  while (true) {
    try {
      const es = new EventSource(`${BACKEND_URL}/events`);
      es.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          handleNativeMessage(msg);
        } catch (err) {
          console.error('Failed to handle SSE message:', err, evt.data);
        }
      };
      es.onerror = (err) => {
        console.warn('SSE error, will retry:', err);
        try {
          es.close();
        } catch {
          // ignore errors
        }
        setTimeout(() => startEventPolling(), 1000);
      };
      // Exit loop; reconnection handled in onerror
      return;
    } catch (err) {
      console.warn('EventSource not available, retrying with backoff:', err);
      // fallback: try short-poll if EventSource ctor fails
      try {
        await pollEventsOnce();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Fallback single poll for events (used if EventSource ctor fails)
async function pollEventsOnce() {
  const res = await fetch(`${BACKEND_URL}/events`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream, application/json' },
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // naive SSE parse for one line
    const text = await res.text();
    text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .forEach((l) => {
        const data = l.replace(/^data:\s*/, '');
        try {
          handleNativeMessage(JSON.parse(data));
        } catch (err) {
          console.error('Failed to parse fallback SSE data:', err, data);
        }
      });
    return;
  }
  const data = await res.json();
  if (data && Array.isArray(data.messages)) {
    data.messages.forEach((msg) => {
      try {
        handleNativeMessage(msg);
      } catch (err) {
        console.error('Failed to handle polled message:', err, msg);
      }
    });
  }
}

// Handle messages from native host
function handleNativeMessage(message) {
  if (message.type === 'handshake_response') {
    console.log('Handshake successful:', message);

    // Native host is connected, but Qwen CLI might not be running yet
    // 'disconnected' from host means Qwen CLI is not running, but we ARE connected to native host
    const hostQwenStatus = message.qwenStatus || 'disconnected';
    // Set our status to 'connected' (to native host), or 'running' if Qwen CLI is already running
    qwenCliStatus = hostQwenStatus === 'running' ? 'running' : 'connected';

    // Notify popup of connection
    chrome.runtime
      .sendMessage({
        type: 'STATUS_UPDATE',
        status: qwenCliStatus,
        capabilities: message.capabilities,
        qwenInstalled: message.qwenInstalled,
        qwenVersion: message.qwenVersion,
      })
      .catch(() => {
        // Ignore errors if receiver is not available
      });
  } else if (message.type === 'permission_request') {
    // Forward permission request from Native Host to UI
    console.log('[Permission Request]', message);
    const pKey = permissionKey(message.requestId, message.sessionId);
    if (handledPermissionRequests.has(pKey)) {
      console.log(
        '[Permission] request already handled, skip forwarding:',
        pKey,
      );
      return;
    }
    broadcastToUI({
      type: 'permissionRequest',
      data: {
        requestId: message.requestId,
        sessionId: message.sessionId,
        toolCall: message.toolCall,
        options: message.options,
      },
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

    // Heuristic: when a prompt completes, native returns a response with a stop reason.
    // We use that as the end-of-stream signal so the UI can finalize the assistant message.
    try {
      if (
        message?.data &&
        (message.data.stopReason ||
          message.data.stop_reason ||
          message.data.status === 'done')
      ) {
        scheduleStreamEnd();
      }
    } catch {
      // ignore
    }
  } else if (message.type === 'event') {
    // Handle events from Qwen CLI
    handleQwenEvent(message);
  }
}

// Send request to native host
async function sendToNativeHost(message) {
  await connectToNativeHost();
  // Respect longer timeouts for heavy calls
  let timeoutMs = 30000;
  if (
    message &&
    (message.type === 'start_qwen' ||
      message.type === 'qwen_prompt' ||
      message.type === 'qwen_request')
  ) {
    timeoutMs = 180000;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    // When streaming completes, signal UI to end loader
    try {
      const payload = data?.data ?? data;
      const inner = payload?.data ?? payload;
      const stopReason =
        inner?.stopReason || inner?.stop_reason || inner?.status === 'done';
      if (stopReason) {
        scheduleStreamEnd();
      }
    } catch {
      // ignore
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

// Handle events from Qwen CLI (ACP events)
function handleQwenEvent(event) {
  const eventData = event.data;

  // 简化日志：显示事件类型和关键信息
  if (eventData?.type === 'session_update') {
    const update = eventData.update;
    console.log(
      '[Qwen]',
      update?.sessionUpdate,
      update?.content?.text?.slice(0, 50) || update,
    );
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
        data: { chunk: update.content?.text || '' },
      });
      // If an end signal was already scheduled, push it out to allow late chunks.
      if (streamEndTimeout) scheduleStreamEnd();
    } else if (update?.sessionUpdate === 'available_commands_update') {
      // Cache and forward available commands list to UI for visibility/debugging
      lastAvailableCommands = Array.isArray(update.availableCommands)
        ? update.availableCommands
        : [];
      broadcastToUI({
        type: 'availableCommands',
        data: { availableCommands: lastAvailableCommands },
      });
    } else if (update?.sessionUpdate === 'user_message_chunk') {
      // Ignore echo of the user's own message to avoid duplicates in UI.
      // The sidepanel already appends the user message on submit.
      // If needed in the future, we can gate this by a feature flag.
      return;
    } else if (
      update?.sessionUpdate === 'tool_call' ||
      update?.sessionUpdate === 'tool_call_update'
    ) {
      // Tool call
      broadcastToUI({
        type: 'toolCall',
        data: update,
      });
    } else if (update?.sessionUpdate === 'plan') {
      // Plan update
      broadcastToUI({
        type: 'plan',
        data: { entries: update.entries },
      });
    }
  } else if (eventData?.type === 'qwen_stopped') {
    qwenCliStatus = 'stopped';
    broadcastToUI({
      type: 'STATUS_UPDATE',
      status: 'stopped',
    });
  } else if (eventData?.type === 'auth_update') {
    const authUri = eventData.authUri;
    // Forward auth update to UI and try to open auth URL
    broadcastToUI({ type: 'authUpdate', data: { authUri } });
    if (authUri) {
      try {
        chrome.tabs.create({ url: authUri });
      } catch {
        // Ignore errors
      }
    }
  } else if (eventData?.type === 'tools_list_changed') {
    // Forward MCP tools list to UI and cache it
    lastMcpTools = Array.isArray(eventData.tools) ? eventData.tools : [];
    broadcastToUI({ type: 'mcpTools', data: { tools: lastMcpTools } });
  } else if (eventData?.type === 'host_info') {
    console.log('[Host] Info', eventData);
    broadcastToUI({ type: 'hostInfo', data: eventData });
  } else if (eventData?.type === 'cli_stderr') {
    console.log('[Qwen STDERR]', eventData.line);
    broadcastToUI({ type: 'hostLog', data: { line: eventData.line } });
  }

  // Also forward raw event for compatibility
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs
        .sendMessage(tab.id, {
          type: 'QWEN_EVENT',
          event: eventData,
        })
        .catch(() => {});
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
        sendResponse({
          success: true,
          status: qwenCliStatus,
        });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }

  if (request.type === 'GET_STATUS') {
    // Get current connection status
    sendResponse({
      connected: isConnected,
      status: qwenCliStatus,
      availableCommands: lastAvailableCommands,
      mcpTools: lastMcpTools,
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
        const promptText = text;
        // Check if connected
        if (!isConnected) {
          await connectToNativeHost();
        }

        // Start Qwen CLI if not running
        if (qwenCliStatus !== 'running') {
          try {
            await sendToNativeHost({
              type: 'start_qwen',
              // Do not use '/' as default cwd - it's not a trusted folder
              // and MCP tools won't be discovered. Use undefined to let host.js
              // use its own default (which is ~/.qwen/chrome-bridge or process.cwd())
              cwd: request.data?.cwd,
            });
            qwenCliStatus = 'running';
          } catch (startError) {
            // If CLI is already running (but session might still be initializing),
            // treat it as running and continue
            if (
              startError.message &&
              startError.message.includes('already running')
            ) {
              console.log('Qwen CLI already running, continuing...');
              qwenCliStatus = 'running';
            } else {
              throw startError;
            }
          }
        }

        // Send the prompt with retry logic for session initialization
        // Notify UI that a new stream is starting right before sending prompt
        broadcastToUI({ type: 'streamStart' });

        // Helper to send prompt with retries (session might still be initializing)
        const sendPromptWithRetry = async (maxRetries = 3, delayMs = 2000) => {
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              await sendToNativeHost({
                type: 'qwen_prompt',
                text: promptText,
              });
              return; // Success
            } catch (err) {
              const isSessionError =
                err.message &&
                (err.message.includes('No active session') ||
                  err.message.includes('session'));
              if (isSessionError && attempt < maxRetries) {
                // Try to re-start Qwen CLI/session then retry prompt
                try {
                  await sendToNativeHost({
                    type: 'start_qwen',
                    cwd: request.data?.cwd || '/',
                  });
                  qwenCliStatus = 'running';
                } catch {
                  // ignore and continue retry loop
                }
                console.log(
                  `Session not ready, retry ${attempt}/${maxRetries} in ${delayMs}ms...`,
                );
                await new Promise((r) => setTimeout(r, delayMs));
              } else {
                throw err;
              }
            }
          }
        };

        await sendPromptWithRetry();
        sendResponse({ success: true });
      } catch (error) {
        console.error('sendMessage error:', error);
        broadcastToUI({
          type: 'error',
          data: { message: error.message },
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
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle permission response
  if (request.type === 'permissionResponse') {
    const reqId = request.data?.requestId;
    const optionId = request.data?.optionId;
    const sessionId = request.data?.sessionId;
    if (!reqId) {
      console.warn('[Permission] Missing requestId, cannot respond');
      sendResponse({ success: false, error: 'Missing requestId' });
      return false;
    }
    console.log(
      '[Permission] Sending response to native host',
      reqId,
      optionId,
      sessionId || 'no-session',
    );
    const pKey = permissionKey(reqId, sessionId);
    sendToNativeHost({
      type: 'permission_response',
      requestId: reqId,
      optionId,
      sessionId,
    })
      .then(() => {
        handledPermissionRequests.add(pKey);
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Permission] Failed to respond:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.type === 'SEND_TO_QWEN') {
    // Send data to Qwen CLI via native host
    const send = async () => {
      try {
        // Ensure native host connection
        if (!isConnected) {
          await connectToNativeHost();
        }

        // Ensure CLI is running
        if (qwenCliStatus !== 'running') {
          await sendToNativeHost({
            type: 'start_qwen',
            cwd: request.data?.cwd || '/',
          });
          qwenCliStatus = 'running';
        }

        // Inform UI that a stream is starting
        try {
          broadcastToUI({ type: 'streamStart' });
        } catch {
          // Ignore errors
        }

        const response = await sendToNativeHost({
          type: 'qwen_request',
          action: request.action,
          data: request.data,
        });
        sendResponse({ success: true, data: response });
      } catch (error) {
        try {
          broadcastToUI({
            type: 'error',
            data: { message: String(error?.message || error) },
          });
        } catch {
          // Ignore errors
        }
        const errMsg =
          error && error && error.message
            ? error && error.message
            : String(error);
        sendResponse({ success: false, error: errMsg });
      }
    };
    send();
    return true; // Will respond asynchronously
  }

  if (request.type === 'START_QWEN_CLI') {
    // Request native host to start Qwen CLI
    sendToNativeHost({
      type: 'start_qwen',
      config: request.config || {},
    })
      .then((response) => {
        qwenCliStatus = 'running';
        sendResponse({ success: true, data: response });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }

  if (request.type === 'STOP_QWEN_CLI') {
    // Request native host to stop Qwen CLI
    sendToNativeHost({
      type: 'stop_qwen',
    })
      .then((response) => {
        qwenCliStatus = 'stopped';
        sendResponse({ success: true, data: response });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
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

  // Ensure clicking the action icon opens the side panel (Chrome API)
  try {
    if (
      chrome.sidePanel &&
      typeof chrome.sidePanel.setPanelBehavior === 'function'
    ) {
      // Open side panel when the action icon is clicked
      // This is the recommended way in recent Chrome versions
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) {
    console.warn('Failed to set side panel behavior:', e);
  }
});

// Inject extension URI when side panel loads
chrome.sidePanel?.setOptions?.(
  {
    path: 'sidepanel/sidepanel.html',
    enabled: true,
  },
  () => {
    if (chrome.runtime.lastError) {
      console.warn(
        'Failed to set side panel options:',
        chrome.runtime.lastError,
      );
    }
  },
);

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  try {
    const openForWindow = (winId) => {
      try {
        chrome.sidePanel.open({ windowId: winId });
      } catch (e) {
        console.error('Failed to open side panel:', e);
      }
    };
    if (tab && typeof tab.windowId === 'number') {
      openForWindow(tab.windowId);
    } else {
      // Fallback: get current window and open
      chrome.windows.getCurrent({}, (win) => {
        if (win && typeof win.id === 'number') {
          openForWindow(win.id);
        } else {
          console.error('No active window to open side panel');
        }
      });
    }
  } catch (e) {
    console.error('onClicked handler error:', e);
  }
});

// Also configure side panel behavior on startup (in addition to onInstalled)
try {
  if (
    chrome.sidePanel &&
    typeof chrome.sidePanel.setPanelBehavior === 'function'
  ) {
    chrome.runtime.onStartup.addListener(() => {
      try {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      } catch (e) {
        console.warn('setPanelBehavior onStartup failed:', e);
      }
    });
  }
} catch {
  // Ignore errors
}

// Listen for navigation to side panel to inject extension URI
chrome.webNavigation?.onDOMContentLoaded?.addListener((details) => {
  // Check if this is the side panel URL
  if (details.url && details.url.includes('/sidepanel/sidepanel.html')) {
    try {
      // Inject script to set extension URI
      const extensionUri = chrome.runtime.getURL('');
      chrome.scripting
        .executeScript({
          target: { tabId: details.tabId },
          func: (uri) => {
            // eslint-disable-next-line no-undef
            document.body.setAttribute('data-extension-uri', uri);
            // eslint-disable-next-line no-undef
            window.__EXTENSION_URI__ = uri;
          },
          args: [extensionUri],
        })
        .catch((e) => {
          console.warn('Failed to inject extension URI script:', e);
        });
    } catch (e) {
      console.warn('Error injecting extension URI:', e);
    }
  }
});
