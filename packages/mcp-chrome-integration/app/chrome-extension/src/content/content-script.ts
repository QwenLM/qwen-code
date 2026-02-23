/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Content Script for Qwen CLI Chrome Extension
 * Main entry point that orchestrates all content script modules
 */

// Import shared state
import { capturedResponses } from './content-shared.js';

// Import functions from data extractor
import {
  consoleLogs,
  extractPageData,
  extractTextContent,
  htmlToMarkdown,
} from './content-data-extractor.js';

// Import element actions
import {
  getSelectedText,
  highlightElement,
  clickElement,
  clickElementByText,
  fillInput,
  fillInputs,
  executeInPageContext,
} from './content-element-actions.js';

// Re-export functions for debugging
export {
  extractPageData,
  extractTextContent,
  htmlToMarkdown,
  getSelectedText,
  highlightElement,
  fillInput,
  consoleLogs,
  capturedResponses,
};

if (window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__) {
  console.debug('Qwen Bridge content script already loaded, skipping.');
} else {
  window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__ = true;

  // Message listener for communication with background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Content script received message:', request);

    switch (request.type) {
      case 'EXTRACT_DATA': {
        // Extract and send page data
        const pageData = extractPageData();
        pageData.consoleLogs = consoleLogs;
        sendResponse({
          success: true,
          data: pageData,
        });
        break;
      }

      case 'GET_CONSOLE_LOGS':
        // Get captured console logs
        sendResponse({
          success: true,
          data: consoleLogs.slice(), // Return a copy
        });
        break;

      case 'GET_SELECTED_TEXT':
        // Get currently selected text
        sendResponse({
          success: true,
          data: getSelectedText(),
        });
        break;

      case 'GET_CAPTURED_RESPONSES': {
        const { urlSubstring, limit } = request || {};
        const max = typeof limit === 'number' && limit > 0 ? limit : 50;
        const filtered = capturedResponses
          .filter((r) => {
            if (!urlSubstring) return true;
            return String(r.url || '').includes(urlSubstring);
          })
          .slice(-max);
        sendResponse({
          success: true,
          data: filtered,
        });
        break;
      }

      case 'FILL_INPUTS': {
        try {
          const results = fillInputs(request.entries || []);
          sendResponse({
            success: true,
            data: { results },
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || String(error),
          });
        }
        break;
      }

      case 'HIGHLIGHT_ELEMENT': {
        // Highlight an element on the page
        const highlighted = highlightElement(request.selector);
        sendResponse({
          success: highlighted,
        });
        break;
      }

      case 'CLICK_ELEMENT': {
        const result = clickElement(request.selector);
        sendResponse(result);
        break;
      }

      case 'CLICK_TEXT': {
        const result = clickElementByText(request.text);
        sendResponse(result);
        break;
      }

      case 'FILL_INPUT': {
        const result = fillInput(request.selector, request.text, {
          clear: request.clear,
        });
        sendResponse(result);
        break;
      }

      case 'EXECUTE_CODE':
        // Execute JavaScript in page context
        executeInPageContext(request.code)
          .then((result) => {
            sendResponse({
              success: true,
              data: result,
            });
          })
          .catch((error) => {
            sendResponse({
              success: false,
              error: error.message,
            });
          });
        return true; // Will respond asynchronously

      case 'SCROLL_TO':
        // Scroll to specific position
        window.scrollTo({
          top: request.y || 0,
          left: request.x || 0,
          behavior: request.smooth ? 'smooth' : 'auto',
        });
        sendResponse({ success: true });
        break;

      case 'QWEN_EVENT':
        // Handle events from Qwen CLI
        console.log('Qwen event received:', request.event);
        // Could trigger UI updates or other actions based on event
        break;

      default:
        sendResponse({
          success: false,
          error: 'Unknown request type',
        });
    }
  });

  // Notify background script that content script is loaded
  chrome.runtime
    .sendMessage({
      type: 'CONTENT_SCRIPT_LOADED',
      url: window.location.href,
    })
    .catch(() => {
      // Ignore errors if background script is not ready
    });

  // Export for debugging (avoid CommonJS in ESM package)
  try {
    (
      globalThis as { __QWEN_CONTENT_SCRIPT_EXPORTS__?: unknown }
    ).__QWEN_CONTENT_SCRIPT_EXPORTS__ = {
      extractPageData,
      extractTextContent,
      htmlToMarkdown,
      getSelectedText,
      highlightElement,
      fillInput,
    };
  } catch {
    // Ignore if globalThis is unavailable
  }
}
