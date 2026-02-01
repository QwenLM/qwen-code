/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
// @ts-nocheck

import './native-messaging';
import {
  isUiRequest,
  routeUiRequest,
  MIGRATION_NOTICE,
} from './ui-request-router';

const STREAM_END_DEBOUNCE_MS = 300;
let streamEndTimeout: number | null = null;

function broadcastToUI(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore if sidepanel is closed
  });
}

function scheduleStreamEnd(reason?: string): void {
  if (streamEndTimeout) clearTimeout(streamEndTimeout);
  streamEndTimeout = setTimeout(() => {
    streamEndTimeout = null;
    broadcastToUI({ type: 'streamEnd', data: { reason } });
  }, STREAM_END_DEBOUNCE_MS);
}

function sendMigrationNotice(): void {
  broadcastToUI({ type: 'streamStart', data: { timestamp: Date.now() } });
  broadcastToUI({
    type: 'message',
    data: {
      role: 'assistant',
      content: MIGRATION_NOTICE,
      timestamp: Date.now(),
    },
  });
  scheduleStreamEnd('migration_notice');
}

function handleCancelStreaming(): void {
  broadcastToUI({ type: 'streamEnd', data: { reason: 'user_cancelled' } });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isUiRequest(request)) {
    return false;
  }

  (async () => {
    const { handled, response, action } = await routeUiRequest(request, {
      connect: () => self.NativeMessaging?.connect?.() ?? false,
      getStatus: () => self.NativeMessaging?.getStatus?.() ?? { connected: false },
    });

    if (!handled) {
      return;
    }

    if (action === 'sendMigrationNotice') {
      sendMigrationNotice();
    }

    if (action === 'cancelStreaming') {
      handleCancelStreaming();
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
