/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  formatLogArgs,
  LOG_LEVELS,
  type LogLevel,
} from '../../utils/logger.js';

export interface VSCodeAPI {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare const acquireVsCodeApi: () => VSCodeAPI;

/**
 * Module-level VS Code API instance cache
 * acquireVsCodeApi() can only be called once, must be cached at module level
 */
let vscodeApiInstance: VSCodeAPI | null = null;

/**
 * Get VS Code API instance
 * Uses module-level cache to ensure acquireVsCodeApi() is only called once
 */
function getVSCodeAPI(): VSCodeAPI {
  if (vscodeApiInstance) {
    return vscodeApiInstance;
  }

  if (typeof acquireVsCodeApi !== 'undefined') {
    vscodeApiInstance = acquireVsCodeApi();
    return vscodeApiInstance;
  }

  // Fallback for development/testing
  vscodeApiInstance = {
    postMessage: (message: unknown) => {
      console.log('Mock postMessage:', message);
    },
    getState: () => ({}),
    setState: (state: unknown) => {
      console.log('Mock setState:', state);
    },
  };
  return vscodeApiInstance;
}

export function initializeWebviewLogger(): void {
  if (typeof acquireVsCodeApi === 'undefined') {
    return;
  }

  const vscode = getVSCodeAPI();
  const postLog = (level: LogLevel, args: unknown[]) => {
    vscode.postMessage({
      type: 'log',
      data: { level, message: formatLogArgs(args) },
    });
  };
  for (const level of LOG_LEVELS) {
    globalThis.console[level] = (...args: unknown[]) => postLog(level, args);
  }
}

/**
 * Hook to get VS Code API
 * Multiple components can safely call this hook, API instance will be reused
 */
export function useVSCode(): VSCodeAPI {
  return getVSCodeAPI();
}
