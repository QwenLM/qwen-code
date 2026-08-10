/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveSessionName,
  getSessionRecordPath,
  getSessionRegistryDir,
  listLiveSessions,
  patchSessionRecord,
  readOwnSessionRecord,
  registerSession,
  unregisterSession,
  SESSION_REGISTRY_SCHEMA_VERSION,
} from './session-registry.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/session-registry-test';
  return {
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-registry-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(fileName: string, body: unknown): Promise<string> {
  const dir = getSessionRegistryDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(
    filePath,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  return filePath;
}

describe('deriveSessionName', () => {
  it('combines the cwd basename with a session-derived suffix', () => {
    const name = deriveSessionName('/home/u/projects/qwen-code', 'abc-123');
    expect(name).toMatch(/^qwen-code-[0-9a-f]{2}$/);
  });

  it('separates two sessions in the same directory', () => {
    const a = deriveSessionName('/w/app', 'session-a');
    const b = deriveSessionName('/w/app', 'session-b');
    expect(a).not.toBe(b);
  });

  it('is stable for the same inputs', () => {
    expect(deriveSessionName('/w/app', 's1')).toBe(
      deriveSessionName('/w/app', 's1'),
    );
  });

  it('strips characters that would not survive a shell or a table', () => {
    const name = deriveSessionName('/w/my project (v2)', 's1');
    expect(name).toMatch(/^[\w.-]+$/);
  });

  it('falls back to a placeholder when the basename is empty', () => {
    expect(deriveSessionName('/', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });

  // An ASCII-only strip collapsed these to a bare `-`, which is truthy, so
  // the placeholder never fired and every non-Latin project listed as
  // `--<xx>` — two different projects becoming byte-identical labels.
  it('keeps non-Latin basenames legible', () => {
    expect(deriveSessionName('/home/u/工作/项目', 's1')).toMatch(
      /^项目-[0-9a-f]{2}$/,
    );
    expect(deriveSessionName('/home/u/проекты', 's1')).toMatch(
      /^проекты-[0-9a-f]{2}$/,
    );
    expect(deriveSessionName('/home/u/工作/项目', 's1')).not.toBe(
      deriveSessionName('/home/u/проекты', 's1'),
    );
  });

  it('does not split an astral character at the length cap', () => {
    // U+1D400 is a letter, so it survives the strip. Slicing by UTF-16 unit
    // would cut the 16th of these in half and leave a lone surrogate in the
    // advertised name; slicing by code point keeps 32 whole characters.
    const name = deriveSessionName(`/w/${'𝐀'.repeat(40)}`, 's1');
    expect(name).toMatch(/^𝐀+-[0-9a-f]{2}$/u);
    expect([...name.slice(0, -3)]).toHaveLength(32);
  });
});

describe('registerSession', () => {
  it('writes a record for this process and lists it back', async () => {
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
        qwenVersion: '1.2.3',
      }),
    ).toBe(true);

    const live = await listLiveSessions({ includeSelf: true });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
      qwenVersion: '1.2.3',
    });
    expect(live[0].name).toMatch(/^app-[0-9a-f]{2}$/);
  });

  // Windows synthesizes st_mode from file attributes (a writable dir reads
  // 0o777, a file 0o666) and chmod there can only toggle the read-only bit,
  // so POSIX permission bits are not assertable on the test_windows gate.
  // Same guard as atomicFileWrite.test.ts and session-writer-lease.test.ts.
  it.skipIf(process.platform === 'win32')(
    'creates the registry directory as 0700',
    async () => {
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      });
      const stat = await fs.stat(getSessionRegistryDir());
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing loose registry directory',
    async () => {
      await fs.mkdir(getSessionRegistryDir(), { recursive: true, mode: 0o755 });
      await fs.chmod(getSessionRegistryDir(), 0o755);

      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      });

      const stat = await fs.stat(getSessionRegistryDir());
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'writes the record as 0600',
    async () => {
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      });
      const stat = await fs.stat(getSessionRecordPath());
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it('reports failure instead of throwing when the home dir is unwritable', async () => {
    __setMockGlobalDir(path.join(tmpDir, 'nope', '\0invalid'));
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(false);
  });
});

describe('patchSessionRecord', () => {
  it('updates a field without dropping the others', async () => {
    await registerSession({
      sessionId: 'old',
      cwd: '/w/app',
      kind: 'interactive',
      qwenVersion: '1.2.3',
    });

    await patchSessionRecord({ sessionId: 'new', name: 'renamed' });

    const [record] = await listLiveSessions({ includeSelf: true });
    expect(record).toMatchObject({
      sessionId: 'new',
      name: 'renamed',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
  });

  it('does not create a record for a session that never registered', async () => {
    // The registry directory has to already exist, otherwise the mutant that
    // drops the `existing === null` guard also fails inside `atomicWriteFile`
    // and the catch-all swallows it — the assertion would pass either way.
    // Registering then unregistering leaves the directory and no record.
    await registerSession({
      sessionId: 'gone',
      cwd: '/w/app',
      kind: 'interactive',
    });
    await unregisterSession();
    await expect(fs.stat(getSessionRegistryDir())).resolves.toBeDefined();

    await patchSessionRecord({ sessionId: 'new' });

    await expect(fs.stat(getSessionRecordPath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });
});

describe('unregisterSession', () => {
  it('removes the record', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    await unregisterSession();
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('is a no-op when nothing was registered', async () => {
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('listLiveSessions', () => {
  it('excludes the calling session by default', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    expect(await listLiveSessions()).toEqual([]);
  });

  it('returns an empty list when the registry does not exist', async () => {
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('sweeps a record whose process is gone', async () => {
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      sessionId: 's-dead',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
      qwenVersion: null,
      peerProtocol: 1,
    });

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it('leaves a dead record in place when sweeping is disabled', async () => {
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      sessionId: 's-dead',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions({ sweepStale: false })).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('does not delete a record replaced between the stale check and the sweep', async () => {
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      sessionId: 's-dead',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // First read classifies the record as stale; the sweep's re-read then
    // sees a different record — the one a recycled PID's new owner would
    // atomically write into the same file. Deleting by pathname alone
    // would destroy the fresh record, so the sweep must leave it alone.
    const staleBody = await fs.readFile(filePath, 'utf8');
    const replacementBody = JSON.stringify({
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      sessionId: 's-recycled',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: 2000,
    });
    let reads = 0;
    const readSpy = vi.spyOn(fs, 'readFile');
    readSpy.mockImplementation((async () => {
      reads += 1;
      return reads === 1 ? staleBody : replacementBody;
    }) as unknown as typeof fs.readFile);

    try {
      expect(await listLiveSessions()).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    } finally {
      readSpy.mockRestore();
    }
  });

  // Windows has no POSIX permission bits to make a directory unreadable,
  // and root ignores them outright.
  it.skipIf(
    process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  )('surfaces an unreadable registry only when asked to', async () => {
    const dir = getSessionRegistryDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o000);
    try {
      await expect(
        listLiveSessions({ throwOnReadError: true }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      // Discovery callers still degrade to "no sessions".
      expect(await listLiveSessions()).toEqual([]);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'treats a recycled PID as stale',
    async () => {
      // Our own PID is alive, but the recorded start token belongs to a
      // different process — so the record describes a session that is gone.
      await writeRaw(`${process.pid}.json`, {
        schemaVersion: 1,
        pid: process.pid,
        procStart: '1',
        sessionId: 's-recycled',
        cwd: '/w/app',
        name: 'app-aa',
        kind: 'interactive',
        startedAt: Date.now(),
      });

      // selfPid is set elsewhere so this record goes through the liveness
      // path rather than the trust-our-own-record shortcut.
      expect(await listLiveSessions({ selfPid: DEAD_PID })).toEqual([]);
    },
  );

  it('ignores files that are not <pid>.json', async () => {
    await writeRaw('2026-planning-notes.json', { hello: 'world' });
    await writeRaw('notes.txt', 'nope');
    await writeRaw('007.json', {
      schemaVersion: 1,
      pid: 7,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    // Critically, none of them were deleted.
    const remaining = await fs.readdir(getSessionRegistryDir());
    expect(remaining.sort()).toEqual([
      '007.json',
      '2026-planning-notes.json',
      'notes.txt',
    ]);
  });

  it('skips a record whose pid disagrees with its filename', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid + 1,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    await expect(
      fs.stat(path.join(getSessionRegistryDir(), `${process.pid}.json`)),
    ).resolves.toBeDefined();
  });

  it('skips malformed and future-schema records without deleting them', async () => {
    await writeRaw('11.json', 'not json at all');
    await writeRaw('12.json', {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
      pid: 12,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });
    await writeRaw('13.json', {
      schemaVersion: 1,
      pid: 13,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'not-a-kind',
      startedAt: 1,
    });

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual([
      '11.json',
      '12.json',
      '13.json',
    ]);
  });

  it('skips a record larger than the parse ceiling without deleting it', async () => {
    const filePath = await writeRaw('14.json', {
      schemaVersion: 1,
      pid: 14,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
      padding: 'x'.repeat(64 * 1024),
    });
    expect((await fs.stat(filePath)).size).toBeGreaterThan(64 * 1024);

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    // Not deleted: an oversized file is somebody else's to explain, and
    // enumeration must stay read-only. It just never gets read or parsed.
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('sorts newest first', async () => {
    await registerSession({
      sessionId: 's-self',
      cwd: '/w/app',
      kind: 'interactive',
    });
    // The parent record is written *before* self's startedAt is patched
    // down, so the startedAt-newest record is no longer also the
    // newest-written file. Otherwise an mtime-descending sort — the exact
    // regression `patchSessionRecord` invites, since a mid-session rewrite
    // refreshes mtime — produces the same order and ships green.
    await writeRaw(`${process.ppid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      sessionId: 's-parent',
      cwd: '/w/other',
      name: 'other-bb',
      kind: 'interactive',
      startedAt: 2000,
    });
    await patchSessionRecord({ startedAt: 1000 });

    const live = await listLiveSessions({ includeSelf: true });
    expect(live.map((r) => r.sessionId)).toEqual(['s-parent', 's-self']);
  });
});

describe('readOwnSessionRecord', () => {
  it('returns null when this process never registered', async () => {
    expect(await readOwnSessionRecord()).toBeNull();
  });

  it('returns the record this process actually wrote', async () => {
    await registerSession({
      sessionId: 's-self',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
    });

    expect(await readOwnSessionRecord()).toMatchObject({
      sessionId: 's-self',
      pid: process.pid,
    });
  });

  // A SIGKILLed session leaves its record behind and the PID is then
  // recycled by a session that never registered. Filename and schema both
  // still check out, so only the start token can tell the two apart.
  it.skipIf(process.platform !== 'linux')(
    'refuses a record left by an earlier process on our PID',
    async () => {
      const filePath = await writeRaw(`${process.pid}.json`, {
        schemaVersion: 1,
        pid: process.pid,
        procStart: '1',
        sessionId: 's-dead',
        cwd: '/w/app',
        name: 'app-aa',
        kind: 'interactive',
        startedAt: Date.now(),
        ipcPath: '/tmp/dead.sock',
      });

      expect(await readOwnSessionRecord()).toBeNull();
      // Enumeration hides it too, but must not delete it: our PID is alive,
      // so nothing here proves the record dead.
      expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    },
  );
});
