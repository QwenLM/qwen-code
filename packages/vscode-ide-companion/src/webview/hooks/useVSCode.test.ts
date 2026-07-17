/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('initializeWebviewLogger', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('forwards webview logs to the extension host', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('console', {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    });
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    const { initializeWebviewLogger } = await import('./useVSCode.js');

    initializeWebviewLogger();
    console.error('Bundled WebUI failure');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'log',
      data: {
        level: 'error',
        message: 'Bundled WebUI failure',
      },
    });
  });
});
