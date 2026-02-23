/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser Tool Executors
 * Implements browser automation tools for the MCP protocol
 */

import type { BrowserToolArgs } from './native-messaging-types';

/* global chrome */

/**
 * Execute browser screenshot
 */
export async function executeBrowserScreenshot(
  args: BrowserToolArgs,
): Promise<any> {
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

/**
 * Execute browser read page
 */
export async function executeBrowserReadPage(
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

/**
 * Execute get windows and tabs
 */
export async function executeGetWindowsAndTabs(
  args: BrowserToolArgs,
): Promise<any> {
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

/**
 * Execute navigate
 */
export async function executeNavigate(args: BrowserToolArgs): Promise<any> {
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

/**
 * Execute click element
 */
export async function executeClickElement(args: BrowserToolArgs): Promise<any> {
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

/**
 * Execute fill or select
 */
export async function executeFillOrSelect(args: BrowserToolArgs): Promise<any> {
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

/**
 * Execute get console logs
 */
export async function executeGetConsoleLogs(
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

/**
 * Execute inject script
 */
export async function executeInjectScript(args: BrowserToolArgs): Promise<any> {
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
