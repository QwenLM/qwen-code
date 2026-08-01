/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

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

// getAcpMemoryArgs() memoizes into module-level cachedMemoryArgs, so each case
// resets the registry and re-imports. This keeps the file independent of test
// order and of which case first populates the cache.
async function importFresh() {
  vi.resetModules();
  vi.spyOn(
    process as { constrainedMemory: () => number },
    'constrainedMemory',
  ).mockReturnValue(0);
  const spawn = await import('./spawnChannel.js');
  const budget = await import('./daemon-memory-budget.js');
  return { spawn, budget };
}

describe('spawn-path constant parity', () => {
  it('getAcpMemoryArgs uses the same cap as legacyChildCeilingMb (saturated)', async () => {
    mockedTotalMem.value = 65_536 * MB;
    mockedHeapSizeLimit.value = 4_096 * MB;
    const { spawn, budget } = await importFresh();

    const args = spawn.getAcpMemoryArgs();
    const expected = budget.legacyChildCeilingMb(65_536);
    expect(expected).toBe(budget.MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });

  it('getAcpMemoryArgs uses the same fraction as legacyChildCeilingMb (unsaturated)', async () => {
    const availableMb = 8_192;
    mockedTotalMem.value = availableMb * MB;
    mockedHeapSizeLimit.value = 2_048 * MB;
    const { spawn, budget } = await importFresh();

    const args = spawn.getAcpMemoryArgs();
    const expected = budget.legacyChildCeilingMb(availableMb);
    expect(expected).toBe(
      Math.min(
        Math.floor(availableMb * budget.LEGACY_CHILD_HEAP_FRACTION),
        budget.MAX_CHILD_HEAP_MB,
      ),
    );
    expect(expected).toBeLessThan(budget.MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });
});
