/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  legacyChildCeilingMb,
  MAX_CHILD_HEAP_MB,
} from './daemon-memory-budget.js';
import { getAcpMemoryArgs } from './spawnChannel.js';

const MB = 1024 * 1024;
const MOCKED_AVAILABLE_MB = 65_536;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    totalmem: () => MOCKED_AVAILABLE_MB * MB,
  };
});

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    getHeapStatistics: () => ({
      ...actual.getHeapStatistics(),
      heap_size_limit: 4_096 * MB,
    }),
  };
});

describe('spawn-path constant parity', () => {
  it('getAcpMemoryArgs uses the same fraction and cap as legacyChildCeilingMb', () => {
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const args = getAcpMemoryArgs();
    const expected = legacyChildCeilingMb(MOCKED_AVAILABLE_MB);
    expect(expected).toBe(MAX_CHILD_HEAP_MB);
    expect(args).toContain(`--max-old-space-size=${expected}`);
  });
});
