/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('loadIconvLite', () => {
  afterEach(() => {
    vi.doUnmock('iconv-lite');
    vi.resetModules();
  });

  it('unwraps the CommonJS default and single-flights concurrent loads', async () => {
    const iconvLite = {
      decode: vi.fn(),
      encode: vi.fn(),
      encodingExists: vi.fn(),
    };
    vi.doMock('iconv-lite', () => ({ default: iconvLite }));
    const { loadIconvLite } = await import('./load-iconv-lite.js');

    const first = loadIconvLite();
    const second = loadIconvLite();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(iconvLite);
  });

  it('uses named exports', async () => {
    const iconvLite = {
      decode: vi.fn(),
      encode: vi.fn(),
      encodingExists: vi.fn(),
    };
    vi.doMock('iconv-lite', () => iconvLite);
    const { loadIconvLite } = await import('./load-iconv-lite.js');

    await expect(loadIconvLite()).resolves.toEqual(iconvLite);
  });

  it('rejects an unexpected module shape', async () => {
    vi.doMock('iconv-lite', () => ({ default: undefined }));
    const { loadIconvLite } = await import('./load-iconv-lite.js');

    await expect(loadIconvLite()).rejects.toThrow(
      'iconv-lite module does not match the expected API',
    );
  });
});
