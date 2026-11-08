/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isPidAlive,
  isSameProcess,
  readPidNamespaceId,
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
function statLine(comm: string, startTime: string, state = 'S'): string {
  // Fields 3..22. Once the parenthesised `comm` is stripped, field N sits
  // at index N - 3, so `startTime` (field 22, `starttime`) is the
  // twentieth entry. The neighbours are deliberately distinct values so an
  // off-by-one read is visible. Field 3 is the process state.
  // prettier-ignore
  const fields = [
    state, '1', '2', '3', '4', '-1', '4194304', '100', '0', '200',
    '0', '10', '20', '30', '40', '20', '0', '1', '0', startTime,
  ];
  return `4242 (${comm}) ${fields.join(' ')} 1000 2000 3000\n`;
}

const PID_NS_PATH = '/proc/self/ns/pid';
const FAKE_PID_NS_INO = 4026531836;

interface FakeProc {
  mod: typeof import('./process-liveness.js');
  reads: string[];
}

/**
 * Load a fresh copy of the module with `/proc` served out of `files` and
 * the platform forced to Linux, so the parser is exercised on every CI
 * runner rather than only the Linux one.
 */
async function withFakeProc(
  files: Record<string, string>,
  options: { pidNsIno?: number | null } = {},
): Promise<FakeProc> {
  const pidNsIno =
    options.pidNsIno === undefined ? FAKE_PID_NS_INO : options.pidNsIno;
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
    statSync: (p: unknown) => {
      reads.push(String(p));
      if (String(p) === PID_NS_PATH && pidNsIno !== null) {
        return { ino: pidNsIno };
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
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

  it('treats another user’s zombie as dead despite EPERM', async () => {
    // The kernel permission-checks signal 0 regardless of the target's
    // state, so a cross-user zombie reaches the EPERM catch; without the
    // zombie check there it stays listed until its parent reaps it.
    const { mod } = await withFakeProc({
      '/proc/4242/stat': statLine('qwen', '987654', 'Z'),
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
    });
    expect(mod.isPidAlive(4242)).toBe(false);
  });

  // On Windows the "process exists but is owned by another user" errno is
  // EACCES, not EPERM; missing it there would let a sweep delete a live
  // session's record.
  it('treats EACCES — Windows’ other-user errno — as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    });
    expect(isPidAlive(4242)).toBe(true);
  });

  it('treats a zombie — exited but unreaped — as dead on Linux', async () => {
    // A zombie still answers kill(pid, 0): the PID exists until the parent
    // reaps it. Only the state field of /proc/<pid>/stat proves it has
    // already exited, so without the Z check the record stays listed for
    // the parent's whole lifetime. The comm carries a ')' so the
    // lastIndexOf(')') anchoring is part of what this test pins.
    const { mod } = await withFakeProc({
      '/proc/4242/stat': statLine('we ) ird', '987654', 'Z'),
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(mod.isPidAlive(4242)).toBe(false);
  });

  it('does not read a zombie state out of a comm containing ")"', async () => {
    // Anchoring on the FIRST ')' parses the rest of the comm as the
    // state field, and a comm tail starting with 'Z' then marks a live
    // process as a zombie — the sweep would delete a live session's
    // record.
    const { mod } = await withFakeProc({
      '/proc/4242/stat': statLine('a)Zx', '987654'),
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(mod.isPidAlive(4242)).toBe(true);
  });

  it('keeps a live process whose /proc state cannot be read', async () => {
    const { mod } = await withFakeProc({});
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(mod.isPidAlive(4242)).toBe(true);
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

  it('retries the boot id after a failed read instead of caching the failure', async () => {
    // Both first-read moments — startup registration and the first
    // concurrent sweep — are fd-pressure moments. Caching a transient
    // EMFILE as a permanent null would silently disable PID-reuse
    // protection for the whole process lifetime.
    const files: Record<string, string> = {
      '/proc/4242/stat': statLine('qwen', '987654'),
    };
    const { mod, reads } = await withFakeProc(files);

    expect(mod.readProcStartToken(4242)).toBeNull();
    files[BOOT_ID_PATH] = `${FAKE_BOOT_ID}\n`;
    expect(mod.readProcStartToken(4242)).toBe(`${FAKE_BOOT_ID}:987654`);
    expect(reads.filter((p) => p === BOOT_ID_PATH)).toHaveLength(2);
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

describe('readPidNamespaceId', () => {
  it('returns the PID namespace inode on Linux', async () => {
    const { mod } = await withFakeProc({});
    expect(mod.readPidNamespaceId()).toBe(FAKE_PID_NS_INO);
  });

  it('returns null when the namespace file is unreadable', async () => {
    const { mod } = await withFakeProc({}, { pidNsIno: null });
    expect(mod.readPidNamespaceId()).toBeNull();
  });

  it('returns null on platforms without /proc', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(readPidNamespaceId()).toBeNull();
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

  it('rejects a zombie even when its start token still matches', async () => {
    // A zombie's /proc/<pid>/stat persists with its original starttime
    // until the parent reaps it, so the recorded token still agrees —
    // only the liveness check (with its Z exclusion) can catch it. This
    // pins the liveness-before-token ordering: a regression that
    // compares tokens first (or folds the two /proc reads into one and
    // drops the Z exclusion) keeps the zombie listed.
    const { mod } = await withFakeProc({
      [BOOT_ID_PATH]: `${FAKE_BOOT_ID}\n`,
      '/proc/4242/stat': statLine('qwen', '987654', 'Z'),
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(mod.isSameProcess(4242, `${FAKE_BOOT_ID}:987654`)).toBe(false);
  });
});
