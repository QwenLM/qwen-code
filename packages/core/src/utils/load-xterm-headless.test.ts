/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('loadXtermHeadless', () => {
  afterEach(() => {
    vi.doUnmock('@xterm/headless');
    vi.resetModules();
  });

  it('uses named exports and single-flights concurrent loads', async () => {
    class Terminal {}
    vi.doMock('@xterm/headless', () => ({ Terminal }));
    const { loadXtermHeadless } = await import('./load-xterm-headless.js');

    const first = loadXtermHeadless();
    const second = loadXtermHeadless();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ Terminal });
  });

  it('unwraps a default-only CommonJS chunk', async () => {
    class Terminal {}
    vi.doMock('@xterm/headless', () => ({ default: { Terminal } }));
    const { loadXtermHeadless } = await import('./load-xterm-headless.js');

    await expect(loadXtermHeadless()).resolves.toEqual({ Terminal });
  });

  it('rejects an unexpected module shape', async () => {
    vi.doMock('@xterm/headless', () => ({ default: {} }));
    const { loadXtermHeadless } = await import('./load-xterm-headless.js');

    await expect(loadXtermHeadless()).rejects.toThrow(
      '@xterm/headless module does not match the expected API',
    );
  });
});
