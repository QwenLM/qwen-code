/**
 * Background Service Worker for Qwen CLI Chrome Extension
 * Handles communication between extension components and native host
 */

/* global chrome, console, setTimeout, clearTimeout, fetch, AbortController */

// Backend HTTP endpoint (replaces Native Messaging)
const BACKEND_URL = 'http://127.0.0.1:18765';

// Connection state
let isConnected = false;
let qwenCliStatus = 'disconnected';
let pendingRequests = new Map();
let eventPollerStarted = false;
// Cache the latest available commands so late listeners (e.g. sidepanel opened later)
// can fetch them via GET_STATUS.
let lastAvailableCommands = [];
// Cache latest MCP tools list (from notifications/tools/list_changed)
let lastMcpTools = [];
// Static list of internal Chrome browser MCP tools exposed by this extension
const INTERNAL_MCP_TOOLS = [
  {
    name: 'browser_read_page',
    description:
      'Read content of the current active tab (url, title, text, links, images).',
  },
  {
    name: 'browser_capture_screenshot',
    description:
      'Capture a screenshot (PNG) of the current visible tab (base64).',
  },
  {
    name: 'browser_get_network_logs',
    description:
      'Get recent Network.* events from Chrome debugger for the active tab.',
  },
  {
    name: 'browser_get_console_logs',
    description: 'Get recent console logs from the active tab.',
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill inputs/textareas/contenteditable elements on the current page using selectors or labels.',
  },
  {
    name: 'browser_input_text',
    description:
      'Fill a single input/textarea/contentEditable element using a CSS selector.',
  },
];

// Heuristic: detect if user intent asks to read current page
function shouldTriggerReadPage(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const keywords = [
    'read this page',
    'read the page',
    'read current page',
    'read page',
    '读取当前页面',
    '读取页面',
    '读取网页',
    '读这个页面',
  ];
  return keywords.some((k) => t.includes(k));
}

// Heuristic: detect if user intent asks for console logs
function shouldTriggerConsoleLogs(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const keywords = [
    'console log',
    'console logs',
    'get console',
    'show console',
    'browser console',
    'console 日志',
    'console日志',
    '控制台日志',
    '获取控制台',
    '查看控制台',
    '读取日志',
    '日志信息',
    '获取日志',
    '查看日志',
    'log信息',
    '错误日志',
    'error log',
  ];
  return keywords.some((k) => t.includes(k));
}

// Heuristic: detect if user intent asks for screenshot
function shouldTriggerScreenshot(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const keywords = [
    'screenshot',
    'capture screen',
    'take screenshot',
    'screen capture',
    '截图',
    '截屏',
    '屏幕截图',
    '页面截图',
  ];
  return keywords.some((k) => t.includes(k));
}

// Heuristic: detect if user intent asks for network logs
function shouldTriggerNetworkLogs(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const keywords = [
    'network log',
    'network logs',
    'network request',
    'api call',
    'http request',
    '网络日志',
    '网络请求',
    'api请求',
    '请求日志',
    '接口请求',
    '接口日志',
    'xhr',
    'fetch',
    '请求记录',
    '网络记录',
  ];
  return keywords.some((k) => t.includes(k));
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

// Long-poll event stream from backend
async function startEventPolling() {
  while (true) {
    try {
      const res = await fetch(`${BACKEND_URL}/events`, { method: 'GET' });
      if (!res.ok) throw new Error(`Events HTTP ${res.status}`);
      const data = await res.json();
      if (data && Array.isArray(data.messages)) {
        data.messages.forEach((msg) => {
          try {
            handleNativeMessage(msg);
          } catch (err) {
            console.error('Failed to handle event message:', err, msg);
          }
        });
      }
    } catch (err) {
      console.warn('Event polling error:', err?.message || err);
      // backoff on error
      await new Promise((r) => setTimeout(r, 3000));
    }
    // small delay between polls to avoid hot loop
    await new Promise((r) => setTimeout(r, 500));
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
        broadcastToUI({ type: 'streamEnd' });
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
        broadcastToUI({ type: 'streamEnd' });
      }
    } catch {
      // ignore
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

// Handle browser requests from Qwen CLI (via Native Host)
async function handleBrowserRequest(message) {
  const { browserRequestId, requestType, params } = message;
  console.log('Browser request:', requestType, params);

  try {
    // Notify UI tool start
    try {
      broadcastToUI({
        type: 'toolProgress',
        data: { name: requestType, stage: 'start' },
      });
    } catch {
      // Ignore errors
    }

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

      case 'fill_form':
        data = await fillBrowserForm(params);
        break;

      case 'input_text':
        data = await inputTextOnPage(
          params?.selector,
          params?.text,
          params?.clear,
        );
        break;

      default:
        throw new Error(`Unknown browser request type: ${requestType}`);
    }

    // In HTTP mode there is no nativePort to respond to; log for debugging
    console.log('Browser response ready', { browserRequestId, requestType });
    try {
      await sendToNativeHost({
        type: 'browser_response',
        browserRequestId,
        data,
      });
    } catch (err) {
      console.error('Failed to send browser_response:', err);
    }

    // Notify UI tool end (success)
    try {
      broadcastToUI({
        type: 'toolProgress',
        data: { name: requestType, stage: 'end', ok: true },
      });
    } catch {
      // Ignore errors
    }
  } catch (error) {
    console.error('Browser request error:', error);
    try {
      await sendToNativeHost({
        type: 'browser_response',
        browserRequestId,
        error: error.message,
      });
    } catch (err) {
      console.error('Failed to send browser_response error:', err);
    }

    // Notify UI tool end (failure)
    try {
      broadcastToUI({
        type: 'toolProgress',
        data: {
          name: requestType,
          stage: 'end',
          ok: false,
          error: String(error?.message || error),
        },
      });
    } catch {
      // Ignore errors
    }
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
  if (
    tab.url &&
    (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))
  ) {
    throw new Error('Cannot access browser internal page');
  }

  // Try to inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  // Request page data from content script
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            chrome.runtime.lastError.message + '. Try refreshing the page.',
          ),
        );
      } else if (response && response.success) {
        resolve({
          url: tab.url,
          title: tab.title,
          content: response.data?.content || { text: '', markdown: '' },
          links: response.data?.links || [],
          images: response.data?.images || [],
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
  if (
    tab.url &&
    (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))
  ) {
    throw new Error('Cannot access browser internal page');
  }

  // Try to inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  // Request console logs from content script
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'GET_CONSOLE_LOGS' },
      (response) => {
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

// Fill inputs/textareas/contenteditable elements on the current page
async function fillBrowserForm(params) {
  const entries = params?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries array is required to fill form fields');
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  if (
    tab.url &&
    (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))
  ) {
    throw new Error('Cannot access browser internal page');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: 'FILL_INPUTS',
        entries,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.data || {});
        } else {
          reject(
            new Error(response?.error || 'Failed to fill inputs on the page'),
          );
        }
      },
    );
  });
}

// Fill a single input/textarea/contentEditable element using a selector
async function inputTextOnPage(selector, text, clear = true) {
  if (!selector) {
    throw new Error('selector is required to fill input');
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error('No active tab found');
  }

  if (
    tab.url &&
    (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:'))
  ) {
    throw new Error('Cannot access browser internal page');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js'],
    });
  } catch (injectError) {
    console.log('Script injection skipped:', injectError.message);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: 'FILL_INPUT',
        selector,
        text,
        clear,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response);
        } else {
          reject(
            new Error(response?.error || 'Failed to fill input on the page'),
          );
        }
      },
    );
  });
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
          internalTools: INTERNAL_MCP_TOOLS,
        });
        // Broadcast internal tools so UI can render tools panel
        try {
          broadcastToUI({
            type: 'internalMcpTools',
            data: { tools: INTERNAL_MCP_TOOLS },
          });
        } catch {
          // Ignore errors
        }
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
      internalTools: INTERNAL_MCP_TOOLS,
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
          try {
            await sendToNativeHost({
              type: 'start_qwen',
              cwd: request.data?.cwd || '/',
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

        // Fallback: if user intent asks to read page (and MCP might not be available),
        // directly read the page via content script and send to Qwen for analysis.
        try {
          if (shouldTriggerReadPage(text)) {
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'read_page', stage: 'start' },
            });
            const data = await getBrowserPageContent();
            // start stream for qwen_request path
            broadcastToUI({ type: 'streamStart' });
            await sendToNativeHost({
              type: 'qwen_request',
              action: 'analyze_page',
              data: data,
              userPrompt: text, // Include user's full request for context
            });
            // do not send original prompt to avoid duplication
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'read_page', stage: 'end', ok: true },
            });
            sendResponse({ success: true });
            return;
          }
        } catch (e) {
          console.warn('Fallback read_page failed:', e);
          broadcastToUI({
            type: 'toolProgress',
            data: {
              name: 'read_page',
              stage: 'end',
              ok: false,
              error: String((e && e.message) || e),
            },
          });
          // continue to send prompt normally
        }

        // Fallback: get console logs
        try {
          const shouldGetConsole = shouldTriggerConsoleLogs(text);
          console.log(
            '[Fallback] shouldTriggerConsoleLogs:',
            shouldGetConsole,
            'text:',
            text,
          );
          if (shouldGetConsole) {
            console.log('[Fallback] Triggering console logs...');
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'console_logs', stage: 'start' },
            });
            const data = await getBrowserConsoleLogs();
            console.log('[Fallback] Console logs data:', data);
            const logs = data.logs || [];
            const formatted = logs
              .slice(-50)
              .map((log) => `[${log.type}] ${log.message}`)
              .join('\n');
            broadcastToUI({ type: 'streamStart' });
            await sendToNativeHost({
              type: 'qwen_request',
              action: 'process_text',
              data: {
                text: `Console logs (last ${Math.min(logs.length, 50)} entries):\n${formatted || '(no logs captured)'}`,
                context: 'console logs from browser',
              },
              userPrompt: text, // Include user's full request
            });
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'console_logs', stage: 'end', ok: true },
            });
            sendResponse({ success: true });
            return;
          }
        } catch (e) {
          console.error('[Fallback] Console logs failed:', e);
          broadcastToUI({
            type: 'toolProgress',
            data: {
              name: 'console_logs',
              stage: 'end',
              ok: false,
              error: String((e && e.message) || e),
            },
          });
        }

        // Fallback: capture screenshot
        try {
          if (shouldTriggerScreenshot(text)) {
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'screenshot', stage: 'start' },
            });
            const screenshot = await getBrowserScreenshot();
            const tabs = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            broadcastToUI({ type: 'streamStart' });
            await sendToNativeHost({
              type: 'qwen_request',
              action: 'analyze_screenshot',
              data: {
                dataUrl: screenshot.dataUrl,
                url: tabs[0]?.url || 'unknown',
              },
              userPrompt: text, // Include user's full request
            });
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'screenshot', stage: 'end', ok: true },
            });
            sendResponse({ success: true });
            return;
          }
        } catch (e) {
          console.warn('Fallback screenshot failed:', e);
          broadcastToUI({
            type: 'toolProgress',
            data: {
              name: 'screenshot',
              stage: 'end',
              ok: false,
              error: String((e && e.message) || e),
            },
          });
        }

        // Fallback: get network logs
        try {
          const shouldGetNetwork = shouldTriggerNetworkLogs(text);
          console.log(
            '[Fallback] shouldTriggerNetworkLogs:',
            shouldGetNetwork,
            'text:',
            text,
          );
          if (shouldGetNetwork) {
            console.log('[Fallback] Triggering network logs...');
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'network_logs', stage: 'start' },
            });
            const logs = await getNetworkLogs(null);
            console.log('[Fallback] Network logs count:', logs?.length);
            const summary = logs.slice(-50).map((log) => ({
              method: log.method,
              url: log.params?.request?.url || log.params?.documentURL,
              status: log.params?.response?.status,
              timestamp: log.timestamp,
            }));
            broadcastToUI({ type: 'streamStart' });
            await sendToNativeHost({
              type: 'qwen_request',
              action: 'process_text',
              data: {
                text: `Network logs (last ${summary.length} entries):\n${JSON.stringify(summary, null, 2)}`,
                context: 'network request logs from browser',
              },
              userPrompt: text, // Include user's full request
            });
            broadcastToUI({
              type: 'toolProgress',
              data: { name: 'network_logs', stage: 'end', ok: true },
            });
            sendResponse({ success: true });
            return;
          }
        } catch (e) {
          console.error('[Fallback] Network logs failed:', e);
          broadcastToUI({
            type: 'toolProgress',
            data: {
              name: 'network_logs',
              stage: 'end',
              ok: false,
              error: String((e && e.message) || e),
            },
          });
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
                text: text,
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
    sendToNativeHost({
      type: 'permission_response',
      requestId: request.data?.requestId,
      optionId: request.data?.optionId,
    })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'EXTRACT_PAGE_DATA') {
    // Request page data from content script
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        const tab = tabs[0];

        // Check if we can inject content script (skip chrome:// and other protected pages)
        if (
          tab.url &&
          (tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('edge://') ||
            tab.url.startsWith('about:'))
        ) {
          sendResponse({
            success: false,
            error: 'Cannot access this page (browser internal page)',
          });
          return;
        }

        // Try to inject content script first in case it's not loaded
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content-script.js'],
          });
        } catch (injectError) {
          // Script might already be injected or page doesn't allow injection
          console.log('Script injection skipped:', injectError.message);
        }

        chrome.tabs.sendMessage(
          tab.id,
          {
            type: 'EXTRACT_DATA',
          },
          (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({
                success: false,
                error:
                  chrome.runtime.lastError.message +
                  '. Try refreshing the page.',
              });
            } else {
              sendResponse(response);
            }
          },
        );
      } else {
        sendResponse({
          success: false,
          error: 'No active tab found',
        });
      }
    });
    return true; // Will respond asynchronously
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
            type: 'toolProgress',
            data: {
              name: request.action || 'request',
              stage: 'end',
              ok: false,
              error: String(error?.message || error),
            },
          });
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

  if (request.type === 'CAPTURE_SCREENSHOT') {
    // Capture screenshot of active tab
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
      } else {
        sendResponse({
          success: true,
          data: dataUrl,
        });
      }
    });
    return true; // Will respond asynchronously
  }

  if (request.type === 'GET_NETWORK_LOGS') {
    // Get network logs (requires debugger API)
    getNetworkLogs(sender.tab?.id)
      .then((logs) => {
        sendResponse({ success: true, data: logs });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }

  if (request.type === 'GET_CONSOLE_LOGS') {
    // Get console logs via content script
    getBrowserConsoleLogs()
      .then((res) => {
        sendResponse({ success: true, data: res.logs || [] });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }
});

// Network logging using both webRequest and debugger APIs
const networkLogs = new Map(); // Store logs for each tab
const MAX_LOGS_PER_TAB = 1000; // Limit logs to prevent memory issues
const MAX_BODIES_PER_FETCH = 20; // Limit body fetches to avoid heavy overhead

// Initialize network logging for a tab
async function initNetworkLogging(tabId) {
  if (!networkLogs.has(tabId)) {
    networkLogs.set(tabId, []);

    // Attach debugger for detailed network information
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    } catch (error) {
      console.warn(`Failed to attach debugger to tab ${tabId}:`, error.message);
    }
  }
}

// Enhanced network logging using webRequest API for broader coverage (metadata only)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId === -1) return; // Skip requests not associated with a tab

    if (!networkLogs.has(tabId)) {
      networkLogs.set(tabId, []);
    }

    const tabLogs = networkLogs.get(tabId);
    tabLogs.push({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: details.requestId,
        request: {
          url: details.url,
          method: details.method,
        },
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });

    if (tabLogs.length > MAX_LOGS_PER_TAB) {
      networkLogs.set(tabId, tabLogs.slice(-MAX_LOGS_PER_TAB));
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId === -1) return; // Skip requests not associated with a tab

    if (!networkLogs.has(tabId)) {
      networkLogs.set(tabId, []);
    }

    const tabLogs = networkLogs.get(tabId);
    tabLogs.push({
      method: 'Network.responseReceived',
      params: {
        requestId: details.requestId,
        response: {
          url: details.url,
          status: details.statusCode,
          statusText: details.statusLine,
        },
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });

    if (tabLogs.length > MAX_LOGS_PER_TAB) {
      networkLogs.set(tabId, tabLogs.slice(-MAX_LOGS_PER_TAB));
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId === -1) return; // Skip requests not associated with a tab

    if (!networkLogs.has(tabId)) {
      networkLogs.set(tabId, []);
    }

    const tabLogs = networkLogs.get(tabId);
    tabLogs.push({
      method: 'Network.loadingFailed',
      params: {
        requestId: details.requestId,
        errorText: details.error,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });

    if (tabLogs.length > MAX_LOGS_PER_TAB) {
      networkLogs.set(tabId, tabLogs.slice(-MAX_LOGS_PER_TAB));
    }
  },
  { urls: ['<all_urls>'] },
);

// Listen for network events via debugger API for additional details
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && method.startsWith('Network.')) {
    // Initialize log storage for this tab if needed
    if (!networkLogs.has(source.tabId)) {
      networkLogs.set(source.tabId, []);
    }

    const tabLogs = networkLogs.get(source.tabId);
    tabLogs.push({
      method,
      params,
      timestamp: Date.now(),
    });

    // Limit the number of logs to prevent memory issues
    if (tabLogs.length > MAX_LOGS_PER_TAB) {
      networkLogs.set(source.tabId, tabLogs.slice(-MAX_LOGS_PER_TAB));
    }
  }
});

async function attachResponseBodies(tabId, tabLogs) {
  // Collect unique requestIds that have a responseReceived entry
  const requestIds = [];
  for (const log of tabLogs) {
    if (
      log.method === 'Network.responseReceived' &&
      log.params?.requestId &&
      !requestIds.includes(log.params.requestId)
    ) {
      requestIds.push(log.params.requestId);
    }
  }

  const limitedIds = requestIds.slice(-MAX_BODIES_PER_FETCH);

  for (const requestId of limitedIds) {
    try {
      const body = await chrome.debugger.sendCommand(
        { tabId },
        'Network.getResponseBody',
        { requestId },
      );
      tabLogs.push({
        method: 'Network.responseBody',
        params: {
          requestId,
          body: body.body,
          base64Encoded: body.base64Encoded,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      tabLogs.push({
        method: 'Network.responseBody',
        params: {
          requestId,
          error: err?.message || String(err),
        },
        timestamp: Date.now(),
      });
    }

    if (tabLogs.length > MAX_LOGS_PER_TAB) {
      networkLogs.set(tabId, tabLogs.slice(-MAX_LOGS_PER_TAB));
    }
  }
}

// Get network logs for a specific tab
async function getNetworkLogs(tabId) {
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
    if (!tabId) throw new Error('No active tab found');
  }

  const wasInitialized = networkLogs.has(tabId);
  // Initialize network logging for the tab if not already done
  await initNetworkLogging(tabId);

  const tabLogs = networkLogs.get(tabId) || [];

  // If we just initialized and have no entries yet, add a marker so the tool returns something helpful
  if (!wasInitialized && tabLogs.length === 0) {
    tabLogs.push({
      method: 'Network.loggingInitialized',
      params: {
        message:
          'Network logging started for this tab. Please reproduce the request and run again to see entries.',
      },
      timestamp: Date.now(),
    });
    networkLogs.set(tabId, tabLogs);
  } else if (tabLogs.length === 0) {
    tabLogs.push({
      method: 'Network.noEntries',
      params: {
        message:
          'No network entries captured yet. Try reloading the page or triggering a request, then run again.',
      },
      timestamp: Date.now(),
    });
    networkLogs.set(tabId, tabLogs);
  }

  // Enrich with response bodies for recent requests (best-effort)
  try {
    await attachResponseBodies(tabId, tabLogs);
  } catch (e) {
    tabLogs.push({
      method: 'Network.responseBody',
      params: {
        error: `Failed to fetch response bodies: ${e?.message || e}`,
      },
      timestamp: Date.now(),
    });
  }

  return tabLogs;
}

// Clean up network logs on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  // Remove logs for this tab
  networkLogs.delete(tabId);

  // Detach debugger if attached
  chrome.debugger.detach({ tabId }).catch(() => {
    // Ignore errors if debugger wasn't attached
  });
});

// Also clean up when extension is shut down
chrome.runtime.onSuspend.addListener(() => {
  // Detach all debuggers
  for (const tabId of networkLogs.keys()) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  networkLogs.clear();
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
