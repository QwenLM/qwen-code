/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CHILD_HEAP_FRACTION,
  legacyChildCeilingMb,
  MAX_CHILD_HEAP_MB,
} from './daemon-memory-budget.js';

const MB = 1024 * 1024;

const { mockedTotalMem, mockedHeapSizeLimit } = vi.hoisted(() => ({
  mockedTotalMem: { value: 8_192 * 1024 * 1024 },
  mockedHeapSizeLimit: { value: 2_048 * 1024 * 1024 },
}));

// Without this stub each of the 11 vi.resetModules() + spawnChannel.js
// re-imports below re-evaluates core's built barrel, which registers two
// top-level process 'exit' listeners per cycle (sleepInhibitor and
// ShellExecutionService's static block):
// ~6s slower here, and Node's MaxListenersExceededWarning once past 5 cycles.
// The suite still passes without it, so this is a runtime/noise guard, not a
// module-resolution requirement. Extend this object if the closure grows
// another core-root value import.
vi.mock('@qwen-code/qwen-code-core', () => ({
  SkillError: class extends Error {},
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const totalmem = () => mockedTotalMem.value;
  return {
    ...actual,
    default: { ...actual, totalmem },
    totalmem,
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

beforeEach(() => {
  // getAcpMemoryArgs() memoizes its result into spawnChannel module state, so
  // every case resets the registry and re-imports the module dynamically.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spawn-path constant parity', () => {
  it('getAcpMemoryArgs uses the same fraction as legacyChildCeilingMb (unsaturated)', async () => {
    const availableMb = 8_192;
    mockedTotalMem.value = availableMb * MB;
    mockedHeapSizeLimit.value = 2_048 * MB;
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);

    const { getAcpMemoryArgs } = await import('./spawnChannel.js');
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
    mockedTotalMem.value = 4_096 * MB;
    expect(getAcpMemoryArgs()).toBe(args);
  });

  it.each([
    ['cgroup v1 unlimited sentinel', 7_265, 2 ** 63 - 4_096, 2_096, 3_632],
    ['cgroup v2 unlimited sentinel', 7_265, 2 ** 64, 2_096, 3_632],
    ['cgroup limit above host memory', 7_265, 8_192 * MB, 2_096, 3_632],
    ['cgroup limit equal to host memory', 7_265, 7_265 * MB, 2_096, 3_632],
    ['unconstrained host', 7_265, 0, 2_096, 3_632],
    ['6 GiB cgroup limit', 7_265, 6_144 * MB, 2_096, 3_072],
    [
      '4 GiB cgroup limit below the current heap limit',
      7_265,
      4_096 * MB,
      2_096,
      undefined,
    ],
    [
      '2 GiB cgroup limit below the current heap limit',
      7_265,
      2_048 * MB,
      1_048,
      undefined,
    ],
    [
      'target equal to the current heap limit',
      7_265,
      6_144 * MB,
      3_072,
      undefined,
    ],
    ['saturated 64 GiB host', 65_536, 0, 4_096, MAX_CHILD_HEAP_MB],
  ] as const)(
    'preserves the host-derived policy for %s',
    async (
      _name,
      hostMb,
      constrainedBytes,
      currentLimitMb,
      expectedTargetMb,
    ) => {
      mockedTotalMem.value = hostMb * MB;
      mockedHeapSizeLimit.value = currentLimitMb * MB;
      vi.spyOn(process, 'constrainedMemory').mockReturnValue(constrainedBytes);

      const { getAcpMemoryArgs } = await import('./spawnChannel.js');
      expect(getAcpMemoryArgs()).toEqual([
        ...(expectedTargetMb === undefined
          ? []
          : [`--max-old-space-size=${expectedTargetMb}`]),
        '--expose-gc',
      ]);
    },
  );

  it('caps the modeled ceiling at MAX_CHILD_HEAP_MB on a saturated host', () => {
    // floor(32_768 * 0.5) lands exactly on the cap, so only a host strictly
    // above it exercises the Math.min in legacyChildCeilingMb.
    expect(legacyChildCeilingMb(65_536)).toBe(MAX_CHILD_HEAP_MB);
  });
});
