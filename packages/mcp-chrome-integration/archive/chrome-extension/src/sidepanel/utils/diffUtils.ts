/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared utilities for handling diff operations in the webview
 */

import type { VSCodeAPI } from '../hooks/useVSCode.js';

/**
 * Handle opening a diff view for a file
 * @param vscode Webview API instance
 * @param path File path
 * @param oldText Original content (left side)
 * @param newText New content (right side)
 */
export const handleOpenDiff = (
  vscode: VSCodeAPI,
  path: string | undefined,
  oldText: string | null | undefined,
  newText: string | undefined,
): void => {
  if (path) {
    vscode.postMessage({
      type: 'openDiff',
      data: { path, oldText: oldText || '', newText: newText || '' },
    });
  }
};
