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

/** The real filesystem, with each call the probe makes open to a fault. */
function probeFs() {
  return {
    mkdtempSync: vi.fn((prefix: string) => fs.mkdtempSync(prefix)),
    chmodSync: vi.fn((file: string, mode: number) => fs.chmodSync(file, mode)),
    readdirSync: vi.fn((file: string): unknown => fs.readdirSync(file)),
    writeFileSync: vi.fn((file: string, data: string) =>
      fs.writeFileSync(file, data),
    ),
    rmSync: vi.fn(
      (file: string, options: { recursive: boolean; force: boolean }) =>
        fs.rmSync(file, options),
    ),
  };
}

function refusal(code: string, syscall?: string): () => never {
  return () => {
    throw Object.assign(new Error(code), { code, syscall });
  };
}

describe('arePermissionBitsEnforced', () => {
  const initialTmpdir = process.env['TMPDIR'];
  let tmp: string;
  let stderr: MockInstance<typeof process.stderr.write>;
  let probe: ReturnType<typeof probeFs>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-bits-test-'));
    process.env['TMPDIR'] = tmp;
    // The diagnostic's shape depends on it, and CI sets it.
    vi.stubEnv('GITHUB_ACTIONS', '');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    probe = probeFs();
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
    if (initialTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = initialTmpdir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** What the probe wrote to stderr about an inconclusive measurement. */
  function diagnostics(): string[] {
    return stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => /^(::warning::)?\[permission-bits\]/.test(line));
  }

  /** The probe was made in os.tmpdir() and is gone again. */
  function expectProbeCleanedUp(): void {
    const dir = String(probe.chmodSync.mock.calls[0]?.[0]);
    expect(dir.startsWith(path.join(tmp, 'qwen-permission-probe-'))).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
  }

  it.skipIf(process.platform === 'win32')(
    'answers true only when listing and writing are both refused',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EACCES'));
      probe.writeFileSync.mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced(probe)).toBe(true);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when the directory can still be listed',
    () => {
      probe.readdirSync.mockImplementationOnce(() => []);
      probe.writeFileSync.mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expectProbeCleanedUp();
      // Bits that do not bind are an answer, not a failed measurement.
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false when listing is refused but writing is not',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EACCES'));
      probe.writeFileSync.mockImplementationOnce(() => undefined);
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false for a refusal other than EACCES',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EPERM'));
      probe.writeFileSync.mockImplementationOnce(refusal('EACCES'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (EPERM)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names a measurement lost to fd exhaustion instead of skipping silently',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EMFILE', 'scandir'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
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
      probe.mkdtempSync.mockImplementationOnce(refusal('ENOSPC'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expect(probe.chmodSync).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmp)).toEqual([]);
      // One whole line, with no workflow command outside GitHub Actions.
      expect(diagnostics()).toEqual([
        expect.stringMatching(
          /^\[permission-bits\] probe inconclusive \(ENOSPC\)[^\n]*\n$/,
        ),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'opens the line with a warning command under GitHub Actions',
    () => {
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      probe.mkdtempSync.mockImplementationOnce(refusal('ENOSPC'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      // A workflow command counts only at the start of a line.
      expect(diagnostics()).toEqual([
        expect.stringMatching(
          /^::warning::\[permission-bits\] probe inconclusive \(ENOSPC\)[^\n]*\n$/,
        ),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers false, without throwing, when the directory refuses chmod',
    () => {
      probe.chmodSync.mockImplementationOnce(refusal('EPERM'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
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
      probe.chmodSync.mockImplementationOnce(() => {
        throw Object.assign(Object.create(null), { code: Symbol('odd') });
      });
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expectProbeCleanedUp();
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (an unprintable value)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prints an error whose code is not an errno by its message',
    () => {
      probe.readdirSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('odd'), { code: Symbol('odd') });
      });
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expect(diagnostics()).toEqual([
        expect.stringContaining('probe inconclusive (Error: odd)'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still names the errno when its syscall cannot be read',
    () => {
      probe.readdirSync.mockImplementationOnce(() => {
        const error = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        Object.defineProperty(error, 'syscall', {
          get() {
            throw new Error('no syscall');
          },
        });
        throw error;
      });
      expect(arePermissionBitsEnforced(probe)).toBe(false);
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
      probe.mkdtempSync.mockImplementationOnce(refusal('ENOSPC'));
      expect(arePermissionBitsEnforced(probe)).toBe(false);
      expect(fs.readdirSync(tmp)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers, without throwing, when the probe cannot be removed',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EACCES'));
      probe.writeFileSync.mockImplementationOnce(refusal('EACCES'));
      probe.rmSync.mockImplementationOnce(refusal('EBUSY'));
      expect(arePermissionBitsEnforced(probe)).toBe(true);
      expect(diagnostics()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers, without throwing, when the probe mode cannot be restored',
    () => {
      probe.readdirSync.mockImplementationOnce(refusal('EACCES'));
      probe.writeFileSync.mockImplementationOnce(refusal('EACCES'));
      probe.chmodSync
        .mockImplementationOnce((file: string, mode: number) =>
          fs.chmodSync(file, mode),
        )
        .mockImplementationOnce(refusal('EPERM'));
      try {
        expect(arePermissionBitsEnforced(probe)).toBe(true);
        expect(diagnostics()).toEqual([]);
      } finally {
        // Newer Node versions cannot remove a mode-000 directory, so open
        // whatever the probe left behind before afterEach clears tmp.
        const dir = probe.chmodSync.mock.calls[0]?.[0];
        if (dir !== undefined && fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
      }
    },
  );

  it('answers false on Windows without probing', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(arePermissionBitsEnforced(probe)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(probe.chmodSync).not.toHaveBeenCalled();
    expect(diagnostics()).toEqual([]);
  });
});
