/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { maybe, withTimeout } from './maybe.js';

describe('maybe()', () => {
  it('returns generator result on success', async () => {
    const result = await maybe('test', async () => [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns [] on error (silent degradation)', async () => {
    const result = await maybe('test', async () => {
      throw new Error('boom');
    });
    expect(result).toEqual([]);
  });

  it('returns [] when generator rejects', async () => {
    const result = await maybe('test', () =>
      Promise.reject(new Error('rejected')),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array not undefined on error', async () => {
    const result = await maybe('test', async () => {
      throw new Error('fail');
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

describe('withTimeout()', () => {
  it('returns result before timeout', async () => {
    const result = await withTimeout('test', async () => ['a', 'b'], 1000);
    expect(result).toEqual(['a', 'b']);
  });

  it('returns [] when timeout exceeded', async () => {
    const result = await withTimeout(
      'test',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return ['slow'];
      },
      50, // 50ms timeout
    );
    expect(result).toEqual([]);
  });

  it('returns [] on error', async () => {
    const result = await withTimeout(
      'test',
      async () => {
        throw new Error('fail');
      },
      1000,
    );
    expect(result).toEqual([]);
  });
});
