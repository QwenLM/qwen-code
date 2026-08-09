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
import { readProcStartToken } from '../utils/process-liveness.js';

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

  // Symlinks are not creatable without elevation on the win32 gate.
  it.skipIf(process.platform === 'win32')(
    'does not write through a symlink planted at the record path',
    async () => {
      // The 0700 directory excludes other uids but not other same-uid
      // processes, which this feature already treats as adversarial. PIDs
      // are allocated predictably enough to plant a link for an upcoming
      // one, and both the write and the forced 0600 chmod would follow it.
      const victim = path.join(tmpDir, 'precious.txt');
      await fs.writeFile(victim, 'do not clobber', { mode: 0o644 });
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      await fs.symlink(victim, getSessionRecordPath(process.pid));

      expect(
        await registerSession({
          sessionId: 's1',
          cwd: '/w/app',
          kind: 'interactive',
        }),
      ).toBe(true);

      expect(await fs.readFile(victim, 'utf8')).toBe('do not clobber');
      expect((await fs.stat(victim)).mode & 0o777).toBe(0o644);
      // The link itself was atomically replaced, so it is not left armed.
      const planted = await fs.lstat(getSessionRecordPath(process.pid));
      expect(planted.isSymbolicLink()).toBe(false);
      expect(planted.isFile()).toBe(true);
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
    await patchSessionRecord({ sessionId: 'new' });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  // Symlinks are not creatable without elevation on the win32 gate.
  it.skipIf(process.platform === 'win32')(
    'replaces a planted symlink instead of contaminating its target',
    async () => {
      // readRecord follows the link and accepts a *valid* record, so the
      // damaging shape is a link aimed at a sibling session's record: the
      // merge lands the patch on the sibling's pid and reply address.
      const sibling = {
        schemaVersion: 1,
        pid: DEAD_PID,
        procStart: null,
        sessionId: 'sibling',
        cwd: '/w/other',
        name: 'other-bb',
        kind: 'interactive',
        startedAt: 1000,
        qwenVersion: null,
        peerProtocol: 1,
      };
      const victim = await writeRaw(`${DEAD_PID}.json`, sibling);
      await fs.symlink(victim, getSessionRecordPath(process.pid));

      await patchSessionRecord({ sessionId: 'patched' });

      // The sibling record is untouched and the link was replaced by a
      // real file, not written through.
      expect(JSON.parse(await fs.readFile(victim, 'utf8'))).toEqual(sibling);
      expect((await fs.lstat(getSessionRecordPath(process.pid))).isFile()).toBe(
        true,
      );
    },
  );
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

  it('treats a recycled PID as stale', async () => {
    // Our own PID is alive, but the recorded start token belongs to a
    // different process — so the record describes a session that is gone.
    if (process.platform !== 'linux') return;
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
  });

  it('rejects a startedAt outside the Date epoch range', async () => {
    // `list_agents` renders this field with `new Date(startedAt)
    // .toISOString()`, which throws RangeError past ±8.64e15. One poison
    // record would fail the whole tool for every session on the machine,
    // and it is never swept because its writer is alive — so the bound
    // belongs here, at the parse boundary.
    // A real start token, so the record survives the liveness check and
    // the epoch bound is the only thing left that can reject it. With
    // `procStart: null` this passed on Linux via `isSameProcess` instead,
    // and stayed green with the bound removed.
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      sessionId: 's-poison',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: 1e300,
      ipcPath: '/tmp/poison.sock',
    });

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    expect(() => new Date(1e300).toISOString()).toThrow(RangeError);
  });

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

  it('sorts newest first', async () => {
    await registerSession({
      sessionId: 's-self',
      cwd: '/w/app',
      kind: 'interactive',
    });
    await patchSessionRecord({ startedAt: 1000 });
    await writeRaw(`${process.ppid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      // A real token, not an omitted one: a token-less record is not a
      // record this code could have written on a platform that has
      // tokens, so leaving it out would make this test pass through the
      // gap rather than through the ordering it is named for.
      procStart: readProcStartToken(process.ppid),
      sessionId: 's-parent',
      cwd: '/w/other',
      name: 'other-bb',
      kind: 'interactive',
      startedAt: 2000,
    });

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

  // The token check above is not reachable when the contents name a
  // different PID: the attacker picks a PID they can read a real token
  // for, so the token agrees and only the filename disagrees.
  it('refuses a record whose contents name a different pid', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      procStart: readProcStartToken(process.ppid),
      sessionId: 's-planted',
      cwd: '/w/attacker',
      name: 'ops-admin',
      kind: 'interactive',
      startedAt: Date.now(),
      ipcPath: '/tmp/attacker.sock',
    });

    expect(await readOwnSessionRecord()).toBeNull();
  });
});

describe('readRecord name validation', () => {
  // `name` is half of the `name [ref]` address grammar, and a record is a
  // file any same-uid process can write. A name allowed to contain the
  // grammar's own terminals can spell another session's disambiguated
  // address, and a caller sending to the address it was shown reaches the
  // wrong session.
  // A live PID, so the record is rejected for its name and not because
  // liveness already disqualified it.
  async function plantNamed(name: string): Promise<void> {
    await writeRaw(`${process.ppid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      procStart: readProcStartToken(process.ppid),
      sessionId: 's-planted',
      cwd: '/w/attacker',
      name,
      kind: 'interactive',
      startedAt: Date.now(),
    });
  }

  it('lists a planted record whose name is well-formed', async () => {
    // The control: everything about this record except the name is what
    // the cases below carry, so a green assertion there means the name
    // was the reason.
    await plantNamed('docs-aa');
    expect(
      (await listLiveSessions({ includeSelf: true })).map((r) => r.sessionId),
    ).toEqual(['s-planted']);
  });

  it.each([
    ['docs [aaaaaa]', 'the address grammar itself'],
    ['has space', 'a space'],
    ['bracket]', 'a stray bracket'],
    ['', 'the empty string'],
  ])('rejects a record named %j (%s)', async (name) => {
    await plantNamed(name);
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('accepts every name deriveSessionName can produce', async () => {
    const name = deriveSessionName('/w/my project (v2)', 's1');
    await registerSession({
      sessionId: 's-live',
      cwd: '/w/app',
      name,
      kind: 'interactive',
    });

    expect(await readOwnSessionRecord()).toMatchObject({ name });
  });
});
