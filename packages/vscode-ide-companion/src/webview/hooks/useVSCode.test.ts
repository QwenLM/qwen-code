/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('initializeWebviewLogger', () => {
  afterEach(() => {
    delete (
      globalThis as typeof globalThis & {
        __qwenWebviewLoggerInitialized?: boolean;
      }
    ).__qwenWebviewLoggerInitialized;
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
    const error = vi.mocked(console.error);
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    const { initializeWebviewLogger } = await import('./useVSCode.js');

    initializeWebviewLogger();
    console.error('Bundled WebUI failure');

    expect(error).toHaveBeenCalledWith('Bundled WebUI failure');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'log',
      data: {
        level: 'error',
        message: 'Bundled WebUI failure',
      },
    });
  });

  it('keeps console calls alive when log forwarding fails', async () => {
    const postMessage = vi.fn(() => {
      throw new Error('disposed');
    });
    vi.stubGlobal('console', {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    });
    const warn = vi.mocked(console.warn);
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    const { initializeWebviewLogger } = await import('./useVSCode.js');

    initializeWebviewLogger();

    expect(() => console.warn('late warning')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('late warning');
  });

  it('does not stack console wrappers when initialized twice', async () => {
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
    initializeWebviewLogger();
    console.log('only once');

    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
