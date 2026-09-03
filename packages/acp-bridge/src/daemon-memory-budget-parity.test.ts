/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// getAcpMemoryArgs() memoizes its result into module state, so the saturated
// and unsaturated parity cases live in separate files: each test file gets a
// fresh module registry, which keeps the cases independent of execution order
// without a slow vi.resetModules() re-import inside a test.
import { describe, expect, it, vi } from 'vitest';
import {
  legacyChildCeilingMb,
  MAX_CHILD_HEAP_MB,
} from './daemon-memory-budget.js';
import { getAcpMemoryArgs } from './spawnChannel.js';

const MB = 1024 * 1024;

const { mockedTotalMem, mockedHeapSizeLimit } = vi.hoisted(() => ({
  mockedTotalMem: { value: 65_536 * 1024 * 1024 },
  mockedHeapSizeLimit: { value: 4_096 * 1024 * 1024 },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    totalmem: () => mockedTotalMem.value,
  };
});

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    getHeapStatistics: () => ({
      ...actual.getHeapStatistics(),
      heap_size_limit: mockedHeapSizeLimit.value,
    }),
  };
});

describe('spawn-path constant parity', () => {
  it('getAcpMemoryArgs uses the same cap as legacyChildCeilingMb (saturated)', () => {
    mockedTotalMem.value = 65_536 * MB;
    mockedHeapSizeLimit.value = 4_096 * MB;
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const args = getAcpMemoryArgs();
    const expected = legacyChildCeilingMb(65_536);
    expect(expected).toBe(MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });
});
