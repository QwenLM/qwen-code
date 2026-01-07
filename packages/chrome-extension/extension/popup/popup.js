/**
 * Popup Script for Qwen CLI Bridge
 * Handles UI interactions and communication with background script
 */

// UI Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = statusIndicator.querySelector('.status-text');
const connectBtn = document.getElementById('connectBtn');
const startQwenBtn = document.getElementById('startQwenBtn');
const connectionError = document.getElementById('connectionError');
const responseSection = document.getElementById('responseSection');
const responseType = document.getElementById('responseType');
const responseContent = document.getElementById('responseContent');
const copyResponseBtn = document.getElementById('copyResponseBtn');

// Action buttons
const extractDataBtn = document.getElementById('extractDataBtn');
const captureScreenBtn = document.getElementById('captureScreenBtn');
const analyzePageBtn = document.getElementById('analyzePageBtn');
const getSelectedBtn = document.getElementById('getSelectedBtn');
const networkLogsBtn = document.getElementById('networkLogsBtn');
const consoleLogsBtn = document.getElementById('consoleLogsBtn');

// Settings
const mcpServersInput = document.getElementById('mcpServers');
const httpPortInput = document.getElementById('httpPort');
const autoConnectCheckbox = document.getElementById('autoConnect');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

// Footer links
const openOptionsBtn = document.getElementById('openOptionsBtn');
const helpBtn = document.getElementById('helpBtn');

// State
let isConnected = false;
let qwenStatus = 'disconnected';

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await checkConnectionStatus();

  // Auto-connect if enabled
  const settings = await chrome.storage.local.get(['autoConnect']);
  if (settings.autoConnect && !isConnected) {
    connectToQwen();
  }
});

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'mcpServers',
    'httpPort',
    'autoConnect'
  ]);

  if (settings.mcpServers) {
    mcpServersInput.value = settings.mcpServers;
  }
  if (settings.httpPort) {
    httpPortInput.value = settings.httpPort;
  }
  if (settings.autoConnect !== undefined) {
    autoConnectCheckbox.checked = settings.autoConnect;
  }
}

// Save settings
saveSettingsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    mcpServers: mcpServersInput.value,
    httpPort: parseInt(httpPortInput.value) || 8080,
    autoConnect: autoConnectCheckbox.checked
  });

  saveSettingsBtn.textContent = 'Saved!';
  setTimeout(() => {
    saveSettingsBtn.textContent = 'Save Settings';
  }, 2000);
});

// Check connection status
async function checkConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    updateConnectionStatus(response.connected, response.status);
  } catch (error) {
    updateConnectionStatus(false, 'disconnected');
  }
}

// Update UI based on connection status
function updateConnectionStatus(connected, status) {
  isConnected = connected;
  qwenStatus = status;

  // Update status indicator
  statusIndicator.classList.toggle('connected', connected);
  statusIndicator.classList.toggle('connecting', status === 'connecting');
  statusText.textContent = getStatusText(status);

  // Update button states
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect to Qwen CLI';
  connectBtn.classList.toggle('btn-danger', connected);

  startQwenBtn.disabled = !connected || status === 'running';

  // Enable/disable action buttons
  const actionButtons = [
    extractDataBtn,
    captureScreenBtn,
    analyzePageBtn,
    getSelectedBtn,
    networkLogsBtn,
    consoleLogsBtn
  ];

  actionButtons.forEach(btn => {
    btn.disabled = !connected || status !== 'running';
  });
}

// Get human-readable status text
function getStatusText(status) {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'running':
      return 'Qwen CLI Running';
    case 'connecting':
      return 'Connecting...';
    case 'disconnected':
      return 'Disconnected';
    case 'stopped':
      return 'Qwen CLI Stopped';
    default:
      return 'Unknown';
  }
}

// Connect button handler
connectBtn.addEventListener('click', () => {
  if (isConnected) {
    disconnectFromQwen();
  } else {
    connectToQwen();
  }
});

// Connect to Qwen CLI
async function connectToQwen() {
  updateConnectionStatus(false, 'connecting');
  connectionError.style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CONNECT' });

    if (response.success) {
      updateConnectionStatus(true, response.status);
    } else {
      throw new Error(response.error || 'Connection failed');
    }
  } catch (error) {
    console.error('Connection error:', error);
    connectionError.textContent = `Error: ${error.message}`;
    connectionError.style.display = 'block';
    updateConnectionStatus(false, 'disconnected');
  }
}

// Disconnect from Qwen CLI
function disconnectFromQwen() {
  // Simply close the popup to disconnect
  // The native port will be closed when the extension unloads
  updateConnectionStatus(false, 'disconnected');
  window.close();
}

// Start Qwen CLI button handler
startQwenBtn.addEventListener('click', async () => {
  startQwenBtn.disabled = true;
  startQwenBtn.textContent = 'Starting...';

  try {
    const settings = await chrome.storage.local.get(['mcpServers', 'httpPort']);
    const response = await chrome.runtime.sendMessage({
      type: 'START_QWEN_CLI',
      config: {
        mcpServers: settings.mcpServers ? settings.mcpServers.split(',').map(s => s.trim()) : [],
        httpPort: settings.httpPort || 8080
      }
    });

    if (response.success) {
      updateConnectionStatus(true, 'running');
      showResponse('Qwen CLI Started', response.data || 'Successfully started');
    } else {
      throw new Error(response.error || 'Failed to start Qwen CLI');
    }
  } catch (error) {
    console.error('Start error:', error);
    connectionError.textContent = `Error: ${error.message}`;
    connectionError.style.display = 'block';
  } finally {
    startQwenBtn.textContent = 'Start Qwen CLI';
  }
});

// Extract page data button handler
extractDataBtn.addEventListener('click', async () => {
  try {
    showLoading('Extracting page data...');

    const response = await chrome.runtime.sendMessage({
      type: 'EXTRACT_PAGE_DATA'
    });

    if (response.success) {
      // Send to Qwen CLI
      const qwenResponse = await chrome.runtime.sendMessage({
        type: 'SEND_TO_QWEN',
        action: 'analyze_page',
        data: response.data
      });

      if (qwenResponse.success) {
        showResponse('Page Analysis', qwenResponse.data);
      } else {
        throw new Error(qwenResponse.error);
      }
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    showError(`Failed to extract data: ${error.message}`);
  }
});

// Capture screenshot button handler
captureScreenBtn.addEventListener('click', async () => {
  try {
    showLoading('Capturing screenshot...');

    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_SCREENSHOT'
    });

    if (response.success) {
      // Send to Qwen CLI
      const qwenResponse = await chrome.runtime.sendMessage({
        type: 'SEND_TO_QWEN',
        action: 'analyze_screenshot',
        data: {
          screenshot: response.data,
          url: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url
        }
      });

      if (qwenResponse.success) {
        showResponse('Screenshot Analysis', qwenResponse.data);
      } else {
        throw new Error(qwenResponse.error);
      }
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    showError(`Failed to capture screenshot: ${error.message}`);
  }
});

// Analyze page with AI button handler
analyzePageBtn.addEventListener('click', async () => {
  try {
    showLoading('Analyzing page with AI...');

    // First extract page data
    const extractResponse = await chrome.runtime.sendMessage({
      type: 'EXTRACT_PAGE_DATA'
    });

    if (!extractResponse.success) {
      throw new Error(extractResponse.error);
    }

    // Send to Qwen for AI analysis
    const qwenResponse = await chrome.runtime.sendMessage({
      type: 'SEND_TO_QWEN',
      action: 'ai_analyze',
      data: {
        pageData: extractResponse.data,
        prompt: 'Please analyze this webpage and provide insights about its content, purpose, and any notable features.'
      }
    });

    if (qwenResponse.success) {
      showResponse('AI Analysis', qwenResponse.data);
    } else {
      throw new Error(qwenResponse.error);
    }
  } catch (error) {
    showError(`Analysis failed: ${error.message}`);
  }
});

// Get selected text button handler
getSelectedBtn.addEventListener('click', async () => {
  try {
    showLoading('Getting selected text...');

    // Get active tab
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
      throw new Error('Cannot access this page (browser internal page)');
    }

    // Try to inject content script first
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content-script.js']
      });
    } catch (injectError) {
      console.log('Script injection skipped:', injectError.message);
    }

    // Get selected text from content script
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_SELECTED_TEXT'
      });
    } catch (msgError) {
      throw new Error('Cannot connect to page. Please refresh the page and try again.');
    }

    if (response.success && response.data) {
      // Send to Qwen CLI
      const qwenResponse = await chrome.runtime.sendMessage({
        type: 'SEND_TO_QWEN',
        action: 'process_text',
        data: {
          text: response.data,
          context: 'selected_text'
        }
      });

      if (qwenResponse.success) {
        showResponse('Selected Text Processed', qwenResponse.data);
      } else {
        throw new Error(qwenResponse.error);
      }
    } else {
      showError('No text selected. Please select some text on the page first.');
    }
  } catch (error) {
    showError(`Failed to process selected text: ${error.message}`);
  }
});

// Network logs button handler
networkLogsBtn.addEventListener('click', async () => {
  try {
    showLoading('Getting network logs...');

    const response = await chrome.runtime.sendMessage({
      type: 'GET_NETWORK_LOGS'
    });

    if (response.success) {
      showResponse('Network Logs', JSON.stringify(response.data, null, 2));
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    showError(`Failed to get network logs: ${error.message}`);
  }
});

// Console logs button handler
consoleLogsBtn.addEventListener('click', async () => {
  try {
    showLoading('Getting console logs...');

    // Get active tab
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
      throw new Error('Cannot access this page (browser internal page)');
    }

    // Try to inject content script first
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content-script.js']
      });
    } catch (injectError) {
      console.log('Script injection skipped:', injectError.message);
    }

    // Get console logs from content script
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXTRACT_DATA'
      });
    } catch (msgError) {
      throw new Error('Cannot connect to page. Please refresh the page and try again.');
    }

    if (response.success) {
      const consoleLogs = response.data.consoleLogs || [];
      if (consoleLogs.length > 0) {
        showResponse('Console Logs', JSON.stringify(consoleLogs, null, 2));
      } else {
        showResponse('Console Logs', 'No console logs captured');
      }
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    showError(`Failed to get console logs: ${error.message}`);
  }
});

// Copy response button handler
copyResponseBtn.addEventListener('click', () => {
  const text = responseContent.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const originalTitle = copyResponseBtn.title;
    copyResponseBtn.title = 'Copied!';
    setTimeout(() => {
      copyResponseBtn.title = originalTitle;
    }, 2000);
  });
});

// Footer link handlers
openOptionsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  // Use try-catch to handle potential errors
  try {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        // If opening options page fails, open it in a new tab as fallback
        console.error('Error opening options page:', chrome.runtime.lastError);
        chrome.tabs.create({
          url: chrome.runtime.getURL('options/options.html')
        });
      }
    });
  } catch (error) {
    console.error('Failed to open options page:', error);
    // Fallback: open in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL('options/options.html')
    });
  }
});

helpBtn.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({
    url: 'https://github.com/QwenLM/qwen-code/tree/main/packages/chrome-extension',
  });
});

// Helper functions
function showLoading(message) {
  responseSection.style.display = 'block';
  responseType.textContent = 'Loading';
  responseContent.textContent = message;
  responseSection.classList.add('loading');
}

function showResponse(type, content) {
  responseSection.style.display = 'block';
  responseType.textContent = type;
  responseContent.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  responseSection.classList.remove('loading');
  responseSection.classList.add('fade-in');
}

function showError(message) {
  responseSection.style.display = 'block';
  responseType.textContent = 'Error';
  responseType.style.color = '#c00';
  responseContent.textContent = message;
  responseSection.classList.remove('loading');
}

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATUS_UPDATE') {
    updateConnectionStatus(message.status !== 'disconnected', message.status);
  } else if (message.type === 'QWEN_EVENT') {
    // Handle events from Qwen CLI
    console.log('Qwen event received:', message.event);
    // Could update UI based on event
  }
});
