/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chrome Extension API adapter
 * Replaces VSCode API for Chrome extension side panel
 */

export interface VSCodeAPI {
  postMessage: (message: unknown) => Promise<unknown>;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

let apiInstance: VSCodeAPI | null = null;

function getAPI(): VSCodeAPI {
  if (apiInstance) {
    return apiInstance;
  }

  // Check if we're in a Chrome extension context
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    apiInstance = {
      postMessage: (message: unknown): Promise<unknown> => {
        console.log('[SidePanel] Sending message:', message);
        return chrome.runtime
          .sendMessage(message as object)
          .catch((err: Error) => {
            console.error('[SidePanel] Failed to send message:', err);
            return null;
          });
      },
      getState: () => {
        return {};
      },
      setState: (state: unknown) => {
        chrome.storage.local.set({ sidePanelState: state });
      },
    };
    return apiInstance;
  }

  // Fallback for development/testing
  console.warn('[SidePanel] Running in development mode');
  apiInstance = {
    postMessage: (message: unknown): Promise<unknown> => {
      console.log('[Mock] postMessage:', message);
      return Promise.resolve(null);
    },
    getState: () => ({}),
    setState: (state: unknown) => {
      console.log('[Mock] setState:', state);
    },
  };
  return apiInstance;
}

/**
 * Hook to get API for messaging
 * Compatible with useVSCode interface from vscode-ide-companion
 */
export function useVSCode(): VSCodeAPI {
  return getAPI();
}
