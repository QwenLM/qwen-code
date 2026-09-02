/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Unsaturated counterpart to daemon-memory-budget-parity.test.ts. The two
// cases are split across files because getAcpMemoryArgs() memoizes into module
// state; a fresh registry per file keeps them independent of execution order
// without a slow vi.resetModules() re-import inside a test.
import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CHILD_HEAP_FRACTION,
  legacyChildCeilingMb,
  MAX_CHILD_HEAP_MB,
} from './daemon-memory-budget.js';
import { getAcpMemoryArgs } from './spawnChannel.js';

const MB = 1024 * 1024;

const { mockedTotalMem, mockedHeapSizeLimit } = vi.hoisted(() => ({
  mockedTotalMem: { value: 8_192 * 1024 * 1024 },
  mockedHeapSizeLimit: { value: 2_048 * 1024 * 1024 },
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
  it('getAcpMemoryArgs uses the same fraction as legacyChildCeilingMb (unsaturated)', () => {
    const availableMb = 8_192;
    mockedTotalMem.value = availableMb * MB;
    mockedHeapSizeLimit.value = 2_048 * MB;
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const args = getAcpMemoryArgs();
    const expected = legacyChildCeilingMb(availableMb);
    expect(expected).toBe(
      Math.min(
        Math.floor(availableMb * LEGACY_CHILD_HEAP_FRACTION),
        MAX_CHILD_HEAP_MB,
      ),
    );
    expect(expected).toBeLessThan(MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });
});
