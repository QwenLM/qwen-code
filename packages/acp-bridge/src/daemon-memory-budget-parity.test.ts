/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CHILD_HEAP_FRACTION,
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
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const args = getAcpMemoryArgs();
    const expected = legacyChildCeilingMb(65_536);
    expect(expected).toBe(MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });

  it('getAcpMemoryArgs uses the same fraction as legacyChildCeilingMb (unsaturated)', async () => {
    const availableMb = 8_192;
    mockedTotalMem.value = availableMb * MB;
    mockedHeapSizeLimit.value = 2_048 * MB;
    vi.resetModules();

    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const spawn = await import('./spawnChannel.js');
    const budget = await import('./daemon-memory-budget.js');

    const args = spawn.getAcpMemoryArgs();
    const expected = budget.legacyChildCeilingMb(availableMb);
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
