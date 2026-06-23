/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import './native-messaging';
import { isUiRequest, routeUiRequest } from './ui-request-router';
import { startBrowserToolsServer } from './browser-tools-server';
import { getDaemonConfig } from '../daemon/config.js';
import { checkDaemonHealth } from '../daemon/discovery.js';

/**
 * Start the daemon WS browser-tools MCP server once a local `qwen serve` daemon
 * is reachable (Phase 2 reverse tool channel, issue #5626). This runs ALONGSIDE
 * the kept native-messaging transport; it does not replace it.
 *
 * We probe `/health` first to avoid spamming reconnects when no daemon is up;
 * the WS client owns its own reconnect loop once started.
 */
async function maybeStartBrowserToolsServer(): Promise<void> {
  try {
    const config = await getDaemonConfig();
    const health = await checkDaemonHealth(config);
    if (health.reachable) {
      console.log('[ServiceWorker] Daemon reachable; starting browser-tools server');
      startBrowserToolsServer();
    } else {
      console.log(
        '[ServiceWorker] Daemon not reachable; browser-tools server idle:',
        health.error,
      );
    }
  } catch (error) {
    console.warn('[ServiceWorker] Browser-tools server probe failed:', error);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isUiRequest(request)) {
    return false;
  }

  (async () => {
    const { handled, response, action } = await routeUiRequest(request, {
      connect: () => self.NativeMessaging?.connect?.() ?? false,
      getStatus: () =>
        self.NativeMessaging?.getStatus?.() ?? { connected: false },
      sendMessageWithResponse: (message) =>
        self.NativeMessaging?.sendMessageWithResponse?.(message),
    });

    if (!handled) {
      return;
    }

    sendResponse(response);
  })().catch((error) => {
    sendResponse({ success: false, error: error?.message || String(error) });
  });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

console.log('[ServiceWorker] Initializing Native Messaging...');
self.NativeMessaging?.init?.();
console.log('[ServiceWorker] Initialized with Native Messaging support');

// Also start the daemon WS browser-tools MCP server when a daemon is reachable.
void maybeStartBrowserToolsServer();
