/* eslint-disable @typescript-eslint/no-unused-vars */

import './native-messaging';
import { isUiRequest, routeUiRequest } from './ui-request-router';

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
