/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { glob } from './glob.js';
const mockRipGrep = vi.hoisted(() => vi.fn());

vi.mock('./ripgrep.js', () => ({
  ripGrep: async (...args: unknown[]) => {
    const paths = await mockRipGrep(...args);
    return paths.length ? [paths.join('\0') + '\0'] : [];
  },
}));

describe('glob result filtering', () => {
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    mockRipGrep.mockReset();
  });

  it('marks a partial process result as incomplete even below the page limit', async () => {
    mockRipGrep.mockImplementation(async (_args, _target, _signal, options) => {
      options.onPartialResults();
      return ['/root/a.txt'];
    });
    const result = await glob(
      '*.txt',
      '/root',
      { limit: 100, offset: 0 },
      abortSignal,
    );
    expect(result).toMatchObject({
      files: ['/root/a.txt'],
      totalMatches: 1,
      countIsComplete: false,
      truncated: true,
    });
  });

  // WHY before the slice: a filtered-out file must not consume the
  // offset/limit quota, otherwise excluded entries (e.g. Read-denied files)
  // would shrink the visible page below the requested limit.
  it('applies the result filter before offset/limit slicing', async () => {
    mockRipGrep.mockResolvedValue([
      '/root/denied.txt',
      '/root/a.txt',
      '/root/b.txt',
    ]);
    const denyFilter = (p: string) => p === '/root/denied.txt';

    const result = await glob(
      '*.txt',
      '/root',
      { limit: 2, offset: 0 },
      abortSignal,
      [],
      denyFilter,
    );

    expect(result.files).toEqual(['/root/a.txt', '/root/b.txt']);
    expect(result.truncated).toBe(false);
  });

  it('without a filter, the same input is truncated by the quota (baseline)', async () => {
    mockRipGrep.mockResolvedValue([
      '/root/denied.txt',
      '/root/a.txt',
      '/root/b.txt',
    ]);

    const result = await glob(
      '*.txt',
      '/root',
      { limit: 2, offset: 0 },
      abortSignal,
    );

    expect(result.files).toEqual(['/root/denied.txt', '/root/a.txt']);
    expect(result.truncated).toBe(true);
  });

  it('leaves results untouched when the filter denies nothing', async () => {
    mockRipGrep.mockResolvedValue(['/root/a.txt', '/root/b.txt']);
    const denyFilter = (p: string) => p === '/root/other.txt';

    const result = await glob(
      '*.txt',
      '/root',
      { limit: 100, offset: 0 },
      abortSignal,
      [],
      denyFilter,
    );

    expect(result.files).toEqual(['/root/a.txt', '/root/b.txt']);
    expect(result.truncated).toBe(false);
  });
});
