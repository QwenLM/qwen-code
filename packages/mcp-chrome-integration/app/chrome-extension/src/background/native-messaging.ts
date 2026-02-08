/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native Messaging Main Module
 * Integrates connection management, message handling, and browser tools
 */

// Import from sub-modules
import {
  connectNativeHost,
  disconnectNativeHost,
  sendNativeMessage,
  getConnectionStatus,
  broadcastToUI,
  setMessageHandler,
  initConnectionExports,
} from './native-connection';

import {
  handleNativeMessage,
  setToolRouter,
  setSendMessageFunction,
} from './native-message-handler';

import {
  executeBrowserScreenshot,
  executeBrowserReadPage,
  executeGetWindowsAndTabs,
  executeNavigate,
  executeClickElement,
  executeFillOrSelect,
  executeGetConsoleLogs,
  executeInjectScript,
} from './browser-tool-executors';

import {
  executeNetworkCapture,
  executeNetworkDebuggerStart,
  executeNetworkDebuggerStop,
  executeNetworkRequest,
} from './browser-network-tools';

import { createToolRouter } from './tool-router';

/* global chrome, console */

// Set up cross-module dependencies first
setMessageHandler(handleNativeMessage);
setSendMessageFunction(sendNativeMessage);

// Create tool router with all browser tools
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

// Set tool router for message handler
setToolRouter(toolRouter);

// Initialize connection exports for global scope
initConnectionExports();

// Wrap initialization in IIFE
(function () {
  'use strict';

  const LOG_PREFIX = '[NativeMessaging]';

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
      connectNativeHost();
    });

    // Auto-connect on extension install/update
    chrome.runtime.onInstalled?.addListener(() => {
      console.log(LOG_PREFIX, 'Extension installed/updated - connecting...');
      connectNativeHost();
    });

    console.log(LOG_PREFIX, 'Initialized');
  }

  // Initialize the NativeMessaging API on global scope
  if (typeof self !== 'undefined' && (self as any).NativeMessaging) {
    (self as any).NativeMessaging.init = initNativeMessaging;
  }
})(); // End of IIFE
