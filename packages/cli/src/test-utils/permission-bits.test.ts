/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { arePermissionBitsEnforced } from './permission-bits.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    mkdtempSync: vi.fn(actual.mkdtempSync),
    readdirSync: vi.fn(actual.readdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

function refusal(code: string, syscall?: string): () => never {
  return () => {
    throw Object.assign(new Error(code), { code, syscall });
  };
}

describe('arePermissionBitsEnforced', () => {
  const initialTmpdir = process.env['TMPDIR'];
  let tmp: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-bits-test-'));
    process.env['TMPDIR'] = tmp;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.mocked(fs.chmodSync).mockReset();
    vi.mocked(fs.mkdtempSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    if (initialTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = initialTmpdir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** What the probe wrote to stderr about an inconclusive measurement. */
  function diagnostics(): string[] {
    return stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[permission-bits]'));
  }

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
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when the directory can still be listed',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(() => []);
      vi.mocked(fs.writeFileSync).mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      // Bits that do not bind are an answer, not a failed measurement.
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when listing is refused but writing is not',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(refusal('EACCES'));
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => undefined);
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false for a refusal other than EACCES',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(refusal('EPERM'));
      vi.mocked(fs.writeFileSync).mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (EPERM)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names a measurement lost to fd exhaustion instead of skipping silently',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(
        refusal('EMFILE', 'scandir'),
      );
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringMatching(
          /probe inconclusive \(EMFILE in scandir\) for .+permission-bits\.test\.ts;/,
        ),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names a temp directory that cannot hold the probe, without throwing',
    () => {
      vi.mocked(fs.mkdtempSync).mockImplementationOnce(refusal('ENOSPC'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expect(fs.chmodSync).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (ENOSPC)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false, without throwing, when the directory refuses chmod',
    () => {
      vi.mocked(fs.chmodSync).mockImplementationOnce(refusal('EPERM'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (EPERM)'),
      ]);
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
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false, without throwing, for a value its diagnostic cannot print',
    () => {
      // Thrown where only the diagnostic's own guard stands between it and
      // a failed test file.
      vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
        throw Object.assign(Object.create(null), { code: Symbol('odd') });
      });
      expect(arePermissionBitsEnforced()).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (an unprintable value)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prints an error whose code is not an errno by its message',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('odd'), { code: Symbol('odd') });
      });
      expect(arePermissionBitsEnforced()).toBe(false);
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (Error: odd)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still names the errno when its syscall cannot be read',
    () => {
      vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
        const error = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        Object.defineProperty(error, 'syscall', {
          get() {
            throw new Error('no syscall');
          },
        });
        throw error;
      });
      expect(arePermissionBitsEnforced()).toBe(false);
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (EPERM)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false, without throwing, when stderr itself refuses the line',
    () => {
      stderr.mockImplementationOnce(() => {
        throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
      });
      // The outer catch reports here, so nothing else stands between the
      // throwing write and the test file.
      vi.mocked(fs.mkdtempSync).mockImplementationOnce(refusal('ENOSPC'));
      expect(arePermissionBitsEnforced()).toBe(false);
      expect(fs.readdirSync(tmp)).toEqual([]);
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
    expect(diagnostics()).toEqual([]);
  });
});
