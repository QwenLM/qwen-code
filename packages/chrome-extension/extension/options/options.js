/**
 * Options page script for Qwen CLI Chrome Extension
 */

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'httpPort',
    'mcpServers',
    'autoConnect',
    'showNotifications',
    'debugMode'
  ]);

  // Set values in form
  document.getElementById('httpPort').value = settings.httpPort || 8080;
  document.getElementById('mcpServers').value = settings.mcpServers || '';
  document.getElementById('autoConnect').checked = settings.autoConnect || false;
  document.getElementById('showNotifications').checked = settings.showNotifications || false;
  document.getElementById('debugMode').checked = settings.debugMode || false;
}

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const settings = {
    httpPort: parseInt(document.getElementById('httpPort').value) || 8080,
    mcpServers: document.getElementById('mcpServers').value,
    autoConnect: document.getElementById('autoConnect').checked,
    showNotifications: document.getElementById('showNotifications').checked,
    debugMode: document.getElementById('debugMode').checked
  };

  await chrome.storage.local.set(settings);

  // Show saved status
  const saveStatus = document.getElementById('saveStatus');
  saveStatus.classList.add('show');
  setTimeout(() => {
    saveStatus.classList.remove('show');
  }, 2000);
});

// Check Native Host status
async function checkNativeHostStatus() {
  try {
    // Try to send a message to check if Native Host is installed
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        document.getElementById('nativeHostStatus').textContent =
          '❌ Not installed - Please run install script';
      } else if (response && response.connected) {
        document.getElementById('nativeHostStatus').textContent =
          '✅ Connected and running';
      } else {
        document.getElementById('nativeHostStatus').textContent =
          '⚠️ Installed but not connected';
      }
    });
  } catch (error) {
    document.getElementById('nativeHostStatus').textContent =
      '❌ Error checking status';
  }
}

// Show extension ID
document.getElementById('extensionId').textContent = chrome.runtime.id;

// Help link
document.getElementById('helpLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({
    url: 'https://github.com/QwenLM/qwen-code/tree/main/packages/chrome-extension',
  });
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkNativeHostStatus();
});
