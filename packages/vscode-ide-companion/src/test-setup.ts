/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Global test setup file
 * Provides global mocks for VSCode API, ensuring test environment is correctly initialized.
 *
 * Note: VSCode API mock is now implemented via alias configuration in vitest.config.ts,
 * pointing to src/__mocks__/vscode.ts
 */

import '@testing-library/jest-dom';
import { vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock WebView API (window.acquireVsCodeApi)
 *
 * React components in WebView communicate with extension via acquireVsCodeApi().
 * This provides mock implementation for component testing.
 */
export const mockVSCodeWebViewAPI = {
  postMessage: vi.fn(),
  getState: vi.fn(() => ({})),
  setState: vi.fn(),
};

beforeEach(() => {
  // Setup WebView API mock
  (
    globalThis as unknown as {
      acquireVsCodeApi: () => typeof mockVSCodeWebViewAPI;
    }
  ).acquireVsCodeApi = () => mockVSCodeWebViewAPI;
});

afterEach(() => {
  // Clear all mock call records
  vi.clearAllMocks();

  // Clear jsdom window to prevent React element cache issues
  if (typeof window !== 'undefined') {
    // Clean up DOM after each test without removing <body>/<head>
    document.body?.replaceChildren();
    document.head?.replaceChildren();
  }
});
