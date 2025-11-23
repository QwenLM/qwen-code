/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';

export interface VSCodeAPI {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare const acquireVsCodeApi: () => VSCodeAPI;

export function useVSCode(): VSCodeAPI {
  return useMemo(() => {
    if (typeof acquireVsCodeApi !== 'undefined') {
      return acquireVsCodeApi();
    }

    // Fallback for development/testing
    return {
      postMessage: (message: unknown) => {
        console.log('Mock postMessage:', message);
      },
      getState: () => ({}),
      setState: (state: unknown) => {
        console.log('Mock setState:', state);
      },
    };
  }, []);
}
