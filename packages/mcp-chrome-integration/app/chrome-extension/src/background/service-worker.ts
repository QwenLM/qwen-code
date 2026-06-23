/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { startBrowserToolsServer } from './browser-tools-server';
import { getDaemonConfig } from '../daemon/config.js';
import { checkDaemonHealth } from '../daemon/discovery.js';

/**
 * Start the daemon WS browser-tools MCP server once a local `qwen serve` daemon
 * is reachable (daemon-direct architecture, issue #5626). We probe `/health`
 * first to avoid spamming reconnects when no daemon is up; the WS client owns
 * its own reconnect loop once started.
 */
async function maybeStartBrowserToolsServer(): Promise<void> {
  try {
    const config = await getDaemonConfig();
    const health = await checkDaemonHealth(config);
    if (health.reachable) {
      console.log(
        '[ServiceWorker] Daemon reachable; starting browser-tools server',
      );
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

void maybeStartBrowserToolsServer();
