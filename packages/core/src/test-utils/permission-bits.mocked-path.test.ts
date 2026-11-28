/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import mockedPathDefault, * as mockedPath from 'node:path';
import { expect, it, vi } from 'vitest';

import { arePermissionBitsEnforced } from './permission-bits.js';

// A test file that automocks node:path (for example sessionService.test.ts)
// must not break the probe into returning false via an inconclusive TypeError.
// The probe resolves node:path outside vitest's module graph so chmod-gated
// tests still run there instead of silently skipping.
vi.mock('node:path');

const nodeRequire = createRequire(import.meta.url);
const realFs = nodeRequire('node:fs') as typeof import('node:fs');
const realOs = nodeRequire('node:os') as typeof import('node:os');
const realPath = nodeRequire('node:path') as typeof import('node:path');

function refusedWithEacces(attempt: () => unknown): boolean {
  try {
    attempt();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EACCES';
  }
}

it.skipIf(process.platform === 'win32')(
  'answers for the kernel without going inconclusive while the test file mocks node:path',
  () => {
    expect(mockedPath.join('a', 'b')).toBeUndefined();
    expect(mockedPathDefault.join('a', 'b')).toBeUndefined();

    const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'locked-'));
    realFs.chmodSync(dir, 0o000);
    let enforced: boolean;
    try {
      enforced =
        refusedWithEacces(() => realFs.readdirSync(dir)) &&
        refusedWithEacces(() =>
          realFs.writeFileSync(realPath.join(dir, 'probe'), ''),
        );
    } finally {
      realFs.chmodSync(dir, 0o700);
      realFs.rmSync(dir, { recursive: true, force: true });
    }

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(arePermissionBitsEnforced()).toBe(enforced);
      const diagnostics = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('[permission-bits]'));
      expect(diagnostics).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  },
);
