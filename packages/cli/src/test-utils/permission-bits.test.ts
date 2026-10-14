/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { arePermissionBitsEnforced } from './permission-bits.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    readdirSync: vi.fn(actual.readdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

function refusal(code: string): () => never {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

describe('arePermissionBitsEnforced', () => {
  const initialTmpdir = process.env['TMPDIR'];
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-bits-test-'));
    process.env['TMPDIR'] = tmp;
  });

  afterEach(() => {
    vi.mocked(fs.chmodSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    if (initialTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = initialTmpdir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** The probe was made in os.tmpdir() and is gone again. */
  function expectProbeCleanedUp(): void {
    const probe = String(vi.mocked(fs.chmodSync).mock.calls[0]?.[0]);
    expect(probe.startsWith(path.join(tmp, 'qwen-permission-probe-'))).toBe(
      true,
    );
    expect(fs.readdirSync(tmp)).toEqual([]);
  }

  it.skipIf(process.platform === 'win32')(
    'answers true only when listing and writing are both refused',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(refusal('EACCES'));
      vi.mocked(fs.writeFileSync).mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced()).toBe(true);
      expectProbeCleanedUp();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when the directory can still be listed',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(() => []);
      vi.mocked(fs.writeFileSync).mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when listing is refused but writing is not',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(refusal('EACCES'));
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => undefined);
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false for a refusal other than EACCES',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(refusal('EPERM'));
      vi.mocked(fs.writeFileSync).mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false, without throwing, when the directory refuses chmod',
    () => {
      vi.mocked(fs.chmodSync).mockImplementationOnce(refusal('EPERM'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'agrees with whether a mode-000 directory refuses this process',
    () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'locked-'));
      fs.chmodSync(dir, 0o000);
      let refused = false;
      try {
        fs.readdirSync(dir);
      } catch (error) {
        refused = (error as NodeJS.ErrnoException).code === 'EACCES';
      } finally {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      expect(arePermissionBitsEnforced()).toBe(refused);
    },
  );

  it('answers false on Windows without probing', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(arePermissionBitsEnforced()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });
});
