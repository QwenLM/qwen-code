/**
 * Chrome Extension API adapter
 * Replaces useVSCode for Chrome extension side panel
 */

export interface ChromeExtensionAPI {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

let chromeApiInstance: ChromeExtensionAPI | null = null;

function getChromeExtensionAPI(): ChromeExtensionAPI {
  if (chromeApiInstance) {
    return chromeApiInstance;
  }

  // Check if we're in a Chrome extension context
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chromeApiInstance = {
      postMessage: (message: unknown) => {
        console.log('[ChromeExtension] Sending message:', message);
        chrome.runtime.sendMessage(message as object).catch((err: Error) => {
          console.error('[ChromeExtension] Failed to send message:', err);
        });
      },
      getState: () => {
        // Use chrome.storage.local for state persistence
        return {};
      },
      setState: (state: unknown) => {
        chrome.storage.local.set({ sidePanelState: state });
      },
    };
    return chromeApiInstance;
  }

  // Fallback for development/testing
  console.warn('[ChromeExtension] Running in development mode');
  chromeApiInstance = {
    postMessage: (message: unknown) => {
      console.log('[Mock] postMessage:', message);
    },
    getState: () => ({}),
    setState: (state: unknown) => {
      console.log('[Mock] setState:', state);
    },
  };
  return chromeApiInstance;
}

/**
 * Hook to get Chrome Extension API
 * Compatible with useVSCode interface
 */
export function useChromeExtension(): ChromeExtensionAPI {
  return getChromeExtensionAPI();
}

// Alias for compatibility
export const useVSCode = useChromeExtension;
export type VSCodeAPI = ChromeExtensionAPI;
