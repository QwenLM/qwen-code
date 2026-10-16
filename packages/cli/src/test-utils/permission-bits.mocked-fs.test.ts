/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';

import { arePermissionBitsEnforced } from './permission-bits.js';

// A test file that replaces node:fs, as some callers of the probe do, must
// not change its answer: the probe asks the kernel, not the mock. The test
// makes the mock answer the opposite of the kernel, so a probe that read the
// mock fails here whoever runs it.
const mocked = vi.hoisted(() => ({
  mkdtempSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
// Both the named exports and the default one: a probe reading either would
// answer for the mock.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, ...mocked, default: { ...actual, ...mocked } };
});

const realFs = createRequire(import.meta.url)(
  'node:fs',
) as typeof import('node:fs');

function refusedWithEacces(attempt: () => unknown): boolean {
  try {
    attempt();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EACCES';
  }
}

it.skipIf(process.platform === 'win32')(
  'answers for the kernel while the test file mocks node:fs',
  () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'locked-'));
    realFs.chmodSync(dir, 0o000);
    let enforced: boolean;
    try {
      enforced =
        refusedWithEacces(() => realFs.readdirSync(dir)) &&
        refusedWithEacces(() =>
          realFs.writeFileSync(path.join(dir, 'probe'), ''),
        );
    } finally {
      realFs.chmodSync(dir, 0o700);
      realFs.rmSync(dir, { recursive: true, force: true });
    }
    mocked.mkdtempSync.mockImplementation((prefix: string) =>
      realFs.mkdtempSync(prefix),
    );
    if (enforced) {
      // The mock lists and writes freely: it would answer false.
      mocked.readdirSync.mockReturnValue([]);
    } else {
      // The mock refuses both: it would answer true.
      const eacces = () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      };
      mocked.readdirSync.mockImplementation(eacces);
      mocked.writeFileSync.mockImplementation(eacces);
    }
    expect(arePermissionBitsEnforced()).toBe(enforced);
  },
);
