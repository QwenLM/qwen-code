/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isPidAlive,
  isSameProcess,
  readProcStartToken,
} from './process-liveness.js';

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

const FAKE_BOOT_ID = '1e0d09fd-4d0b-4b9d-9d1b-2f0c1a3b4c5d';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

/**
 * A synthetic `/proc/<pid>/stat` line.
 *
 * The field arithmetic in `readProcStartToken` is only testable against a
 * fake: a real `/proc` entry cannot be made to hold a `comm` containing
 * ')', a non-numeric field 22, or a missing boot id, and every neighbour
 * of field 22 in a real line is also a plain integer — so reading the
 * wrong index off a real process still yields something that looks like a
 * valid token.
 */
function statLine(comm: string, startTime: string): string {
  // Fields 3..22. Once the parenthesised `comm` is stripped, field N sits
  // at index N - 3, so `startTime` (field 22, `starttime`) is the
  // twentieth entry. The neighbours are deliberately distinct values so an
  // off-by-one read is visible.
  // prettier-ignore
  const fields = [
    'S', '1', '2', '3', '4', '-1', '4194304', '100', '0', '200',
    '0', '10', '20', '30', '40', '20', '0', '1', '0', startTime,
  ];
  return `4242 (${comm}) ${fields.join(' ')} 1000 2000 3000\n`;
}

interface FakeProc {
  mod: typeof import('./process-liveness.js');
  reads: string[];
}

/**
 * Load a fresh copy of the module with `/proc` served out of `files` and
 * the platform forced to Linux, so the parser is exercised on every CI
 * runner rather than only the Linux one.
 */
async function withFakeProc(files: Record<string, string>): Promise<FakeProc> {
  const reads: string[] = [];
  vi.resetModules();
  vi.doMock('node:fs', () => ({
    readFileSync: (p: unknown) => {
      reads.push(String(p));
      const body = files[String(p)];
      if (body === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return body;
    },
  }));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const mod = await import('./process-liveness.js');
  return { mod, reads };
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it('rejects nonsense pids without throwing', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  // EPERM is the whole reason this helper is not a bare try/catch: a
  // process owned by another user is alive, and calling it dead would let
  // one user's sweep delete another user's registry record. The test suite
  // cannot rely on such a process existing, so the errno is injected.
  it('treats EPERM — another user’s process — as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
    });
    expect(isPidAlive(4242)).toBe(true);
  });

  it('treats ESRCH as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(isPidAlive(4242)).toBe(false);
  });
});

describe('readProcStartToken', () => {
  it('returns a boot-scoped token for a live process on Linux', () => {
    const token = readProcStartToken(process.pid);
    if (process.platform !== 'linux') {
      expect(token).toBeNull();
      return;
    }
    // <boot_id>:<starttime> — the boot id is what keeps a record from a
    // previous boot from matching a recycled PID.
    expect(token).toMatch(/^[0-9a-f-]+:\d+$/i);
  });

  it('is stable across calls', () => {
    expect(readProcStartToken(process.pid)).toBe(
      readProcStartToken(process.pid),
    );
  });

  it('returns null for a dead pid', () => {
    expect(readProcStartToken(DEAD_PID)).toBeNull();
  });

  it('reads starttime as field 22, counting from the last ")" in comm', async () => {
    const { mod } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      // A `comm` holding both a space and a ')' — legal, and fatal to any
      // parser that splits the whole line or anchors on the first ')'.
      '/proc/4242/stat': statLine('we ) ird', '987654'),
    });
    expect(mod.readProcStartToken(4242)).toBe(`${FAKE_BOOT_ID}:987654`);
  });

  it('returns null when the stat line has no comm parentheses at all', async () => {
    const { mod } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      '/proc/4242/stat':
        '4242 qwen S 1 2 3 4 -1 4194304 100 0 200 0 10 20 30 40 20 0 1 0 987654 1000\n',
    });
    // Without the `commEnd === -1` bail this counts from the start of the
    // line and confidently returns field 20 as if it were starttime.
    expect(mod.readProcStartToken(4242)).toBeNull();
  });

  it('returns null when field 22 is not a number', async () => {
    const { mod } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      '/proc/4242/stat': statLine('qwen', 'not-a-number'),
    });
    expect(mod.readProcStartToken(4242)).toBeNull();
  });

  it('returns null rather than a bare tick count when the boot id is unreadable', async () => {
    // Two token shapes on one machine would let a reader that has the boot
    // id "mismatch" a live session recorded without it and sweep it.
    const { mod } = await withFakeProc({
      '/proc/4242/stat': statLine('qwen', '987654'),
    });
    expect(mod.readProcStartToken(4242)).toBeNull();
  });

  it('rejects a boot id that is not a hex-and-dash uuid', async () => {
    const { mod } = await withFakeProc({
      [BOOT_ID_PATH]: 'not a uuid\n',
      '/proc/4242/stat': statLine('qwen', '987654'),
    });
    expect(mod.readProcStartToken(4242)).toBeNull();
  });

  it('reads the boot id once however many records are checked', async () => {
    const { mod, reads } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      '/proc/4242/stat': statLine('qwen', '987654'),
      '/proc/4243/stat': statLine('qwen', '987655'),
    });
    mod.readProcStartToken(4242);
    mod.readProcStartToken(4243);
    expect(reads.filter((p) => p === BOOT_ID_PATH)).toHaveLength(1);
    expect(reads.filter((p) => p.endsWith('/stat'))).toHaveLength(2);
  });

  it('rejects nonsense pids before touching /proc', async () => {
    const { mod, reads } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      // Planted so a missing pid guard would find something to return.
      '/proc/0/stat': statLine('qwen', '111'),
      '/proc/1.5/stat': statLine('qwen', '222'),
    });
    expect(mod.readProcStartToken(0)).toBeNull();
    expect(mod.readProcStartToken(-1)).toBeNull();
    expect(mod.readProcStartToken(1.5)).toBeNull();
    expect(reads.filter((p) => p.endsWith('/stat'))).toEqual([]);
  });
});

describe('isSameProcess', () => {
  it('is false for a dead pid regardless of token', () => {
    expect(isSameProcess(DEAD_PID, null)).toBe(false);
    expect(isSameProcess(DEAD_PID, '123')).toBe(false);
  });

  it('accepts a live pid recorded without a token', () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });

  it('accepts a live pid whose token still matches', () => {
    const token = readProcStartToken(process.pid);
    expect(isSameProcess(process.pid, token)).toBe(true);
  });

  // Only Linux produces a token to disagree with; elsewhere this is a
  // visible skip rather than a test that passes without asserting.
  it.runIf(process.platform === 'linux')(
    'rejects a live pid whose token has changed',
    () => {
      expect(isSameProcess(process.pid, 'definitely-not-the-token')).toBe(
        false,
      );
    },
  );

  it('keeps a live session whose token cannot be read right now', async () => {
    // /proc unreadable in a container, or the boot id missing: a record
    // that carries a token must still count as live, because deleting a
    // running session's record is the worse of the two failures.
    const { mod } = await withFakeProc({});
    expect(mod.isSameProcess(process.pid, 'a-token-we-cannot-compare')).toBe(
      true,
    );
  });
});
