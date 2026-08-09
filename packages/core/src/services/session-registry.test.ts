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
  registerSession,
  unregisterSession,
  SESSION_REGISTRY_SCHEMA_VERSION,
} from './session-registry.js';
import {
  readMachineId,
  readPidNamespaceId,
  readProcStartToken,
} from '../utils/process-liveness.js';

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

/**
 * Plant a file in the registry directory verbatim.
 *
 * Object bodies get this machine's `machineId` unless they name one
 * themselves: a record without it reads as "written somewhere else",
 * which is what the origin tests below assert deliberately and every
 * other test would then hit by accident.
 */
async function writeRaw(fileName: string, body: unknown): Promise<string> {
  const dir = getSessionRegistryDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  const content =
    typeof body === 'string'
      ? body
      : JSON.stringify({ machineId: readMachineId(), ...(body as object) });
  await fs.writeFile(filePath, content);
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

  it('records a start-time token so a recycled pid cannot resurrect it', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });

    // Enumerate as a *different* process: the self-pid shortcut never
    // calls isSameProcess, so it is the only path on which the recorded
    // token is read at all. Without this, a regression writing
    // `procStart: null` stays green here and, in production, degrades
    // every sibling's check to bare liveness — the exact recycled-pid
    // hole the token exists to close.
    const live = await listLiveSessions({
      selfPid: DEAD_PID,
      sweepStale: false,
    });
    expect(live).toHaveLength(1);
    if (process.platform === 'linux') {
      expect(live[0].procStart).toBe(readProcStartToken(process.pid));
      expect(live[0].procStart).toMatch(/^\d+$/);
    } else {
      expect(live[0].procStart).toBeNull();
    }
  });

  it('records the PID namespace the pid was allocated in', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });

    // Same reason as the token above: the self-pid shortcut skips every
    // check, so read it back as a different process. A regression writing
    // `pidNamespace: null` would let a sandboxed sibling sweep this
    // record while the session is still running.
    const [record] = await listLiveSessions({
      selfPid: DEAD_PID,
      sweepStale: false,
    });
    expect(record.pidNamespace).toBe(readPidNamespaceId());
    if (process.platform === 'linux') {
      expect(record.pidNamespace).toMatch(/^\d+$/);
    } else {
      expect(record.pidNamespace).toBeNull();
    }
  });

  it('records the machine the pid was allocated on', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });

    // The namespace id alone cannot carry this: every non-containerized
    // Linux host reports the same initial-namespace inode, so a record
    // without a machine claim is sweepable by any other machine sharing
    // the directory.
    const [record] = await listLiveSessions({
      selfPid: DEAD_PID,
      sweepStale: false,
    });
    expect(record.machineId).toBe(readMachineId());
    expect(record.machineId).not.toBeNull();
  });

  it('refuses to overwrite a record from another origin', async () => {
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-theirs',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // Their PID number, not ours to reuse: the session behind it is still
    // running over there, registration is startup-only, so clobbering the
    // file removes it from discovery for the rest of its life.
    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
      }),
    ).toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      sessionId: 's-theirs',
      cwd: '/w/theirs',
    });
  });

  it('overwrites a same-origin record left at its own pid', async () => {
    // The origin guard's other branch, and the only recovery path there
    // is: a predecessor that died without unlinking leaves its record at
    // this PID, registration happens once at startup, and the sole sweep
    // trigger is `qwen sessions ps`. Widening the guard to refuse on any
    // existing record leaves the rest of this suite green while making
    // every session on a recycled PID invisible for its whole life.
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      procStart: '1',
      pidNamespace: readPidNamespaceId(),
      machineId: readMachineId(),
      sessionId: 's-predecessor',
      cwd: '/w/before',
      name: 'before-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
      }),
    ).toBe(true);

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      sessionId: 's-ours',
      cwd: '/w/ours',
    });
  });

  it('reports an origin conflict to the caller', async () => {
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-theirs',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // Nothing removes an ownerless foreign record and registration is
    // startup-only, so this blackout never lifts on its own — a bare
    // `false`, indistinguishable from a transient I/O failure, is not
    // enough for the caller to say so.
    const conflicts: Array<{ pid: number; filePath: string }> = [];
    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
        onOriginConflict: (info) => conflicts.push(info),
      }),
    ).toBe(false);

    expect(conflicts).toEqual([{ pid: process.pid, filePath }]);
  });

  it('does not report a conflict when registration succeeds', async () => {
    const onOriginConflict = vi.fn();
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
        onOriginConflict,
      }),
    ).toBe(true);
    expect(onOriginConflict).not.toHaveBeenCalled();
  });

  it('still reports failure when the conflict callback throws', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-theirs',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // Reporting is a courtesy; it must not escalate a discovery miss into
    // a failed startup.
    await expect(
      registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
        onOriginConflict: () => {
          throw new Error('reporting blew up');
        },
      }),
    ).resolves.toBe(false);
  });

  // Symlinks are not creatable without elevation on stock Windows.
  it.skipIf(process.platform === 'win32')(
    'does not write through a symlink planted at its record path',
    async () => {
      const victim = path.join(tmpDir, 'victim.txt');
      await fs.writeFile(victim, 'do not clobber me');
      const dir = getSessionRegistryDir();
      await fs.mkdir(dir, { recursive: true });
      await fs.symlink(victim, getSessionRecordPath());

      expect(
        await registerSession({
          sessionId: 's1',
          cwd: '/w/app',
          kind: 'interactive',
        }),
      ).toBe(true);

      // The sandbox mounts this directory across a trust boundary, so a
      // planted `<pid>.json -> <host path>` is a write primitive pointed
      // at a file the attacker chooses. Replacing the link is the correct
      // outcome, not refusing to register.
      expect(await fs.readFile(victim, 'utf8')).toBe('do not clobber me');
      expect((await fs.lstat(getSessionRecordPath())).isSymbolicLink()).toBe(
        false,
      );
      expect(await listLiveSessions({ includeSelf: true })).toHaveLength(1);
    },
  );

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
    await patchSessionRecord({ sessionId: 'new' });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('leaves a record from another origin unmerged', async () => {
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: null,
      pidNamespace: 'not-our-namespace',
      machineId: readMachineId(),
      sessionId: 's-theirs',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // A merge here would rewrite their sessionId/cwd/name in place,
    // pointing every reader of that record at our transcript.
    await patchSessionRecord({ sessionId: 'ours', cwd: '/w/ours' });

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      sessionId: 's-theirs',
      cwd: '/w/theirs',
    });
  });

  it.each([
    ['unparseable', 'not json at all'],
    [
      'a future schema version',
      {
        schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
        pid: process.pid,
        sessionId: 's-future',
        cwd: '/w/future',
      },
    ],
  ])('leaves %s record at its own pid untouched', async (_label, body) => {
    const filePath = await writeRaw(`${process.pid}.json`, body);
    const before = await fs.readFile(filePath, 'utf8');

    // `readRecord` returns null for both, and a resurrect-on-null patch
    // would overwrite a record this code did not write — a newer build's,
    // once the schema bumps.
    await patchSessionRecord({ sessionId: 'ours', cwd: '/w/ours' });

    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
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

  it('leaves a record from another origin in place', async () => {
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-theirs',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: 1000,
    });

    // Our exit says nothing about their session, and they will not
    // re-register: registration happens once, at startup.
    await unregisterSession();

    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it.each([
    ['unparseable', 'not json at all'],
    [
      'a future schema version',
      {
        schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
        pid: process.pid,
        sessionId: 's-future',
        cwd: '/w/future',
      },
    ],
  ])('leaves %s record at its own pid in place', async (_label, body) => {
    const filePath = await writeRaw(`${process.pid}.json`, body);
    const before = await fs.readFile(filePath, 'utf8');

    // "Not a record this code wrote, so not this code's to delete." An
    // exit-time cleanup that unlinked whenever `readRecord` returned null
    // would swallow its own ENOENT and pass every other test here, while
    // deleting a newer build's record at a recycled PID.
    await unregisterSession();

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(before);
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
      pidNamespace: readPidNamespaceId(),
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
      pidNamespace: readPidNamespaceId(),
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
      pidNamespace: readPidNamespaceId(),
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

  it('neither lists nor sweeps a same-origin record with no start token', async () => {
    // Where a token is readable this build always records one, so a
    // same-origin record without one did not come from this code. Trusting
    // it collapses the check to bare liveness, and every field a reader
    // shows — sessionId, cwd, name — is then whoever wrote the file's to
    // choose; the origin fields it has to match are plaintext in every
    // sibling record.
    if (process.platform !== 'linux') return;
    const filePath = await writeRaw(`${process.ppid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.ppid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: readMachineId(),
      sessionId: 's-forged',
      cwd: '/w/forged',
      name: 'forged-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions()).toEqual([]);
    // Not swept: it may be a future version's record, and registration is
    // startup-only, so a wrong unlink hides that session permanently.
    await expect(fs.stat(filePath)).resolves.toBeDefined();
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

  // The sandbox mounts the host's global qwen dir — `sessions/` included —
  // into a container that gets its own PID namespace, so both sides read
  // each other's records while neither can see the other's processes. A
  // PID that is invisible here is not therefore dead there.
  it('neither lists nor sweeps a record from another PID namespace', async () => {
    // Same PID as this very process, so the local liveness probe would
    // say "alive"; the record still must not be reported, because that
    // number names an unrelated process on the other side of the border.
    const livePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNamespace: 'not-our-namespace',
      sessionId: 's-foreign-live',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });
    // And a PID that is invisible here, which is what the sweep would
    // otherwise read as proof of death.
    const deadPath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      pidNamespace: 'not-our-namespace',
      sessionId: 's-foreign-invisible',
      cwd: '/w/app',
      name: 'app-bb',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions({ selfPid: process.ppid })).toEqual([]);
    // Registration is startup-only and patchSessionRecord no-ops on a
    // missing record, so an unlink here would hide a live session for the
    // rest of its life. Both files must survive.
    await expect(fs.stat(livePath)).resolves.toBeDefined();
    await expect(fs.stat(deadPath)).resolves.toBeDefined();
  });

  it('does not adopt a foreign record sitting at our own PID number', async () => {
    // The test above routes around the self-pid shortcut by enumerating
    // as another process. This one does not: container PIDs are small and
    // host PIDs recycle, so `<our pid>.json` written on the other side of
    // the border is the collision that actually happens.
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNamespace: 'not-our-namespace',
      sessionId: 's-foreign-self',
      cwd: '/w/theirs',
      name: 'theirs-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    // Reported as our own session, `qwen sessions ps` would print their
    // sessionId, cwd and name as this process's — and ours not at all.
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  // `QWEN_HOME` on a shared volume, or an NFS home: one registry
  // directory, two machines. The initial PID namespace inode is the same
  // constant on both, so the namespace gate alone waves them through.
  it('neither lists nor sweeps a record from another machine', async () => {
    const deadPath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-remote-invisible',
      cwd: '/w/app',
      name: 'app-bb',
      kind: 'interactive',
      startedAt: Date.now(),
    });
    // No PID collision needed for the sweep to fire: it is enough that
    // this machine has no process with that number, which is the normal
    // case.
    const livePath = await writeRaw(`${process.ppid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: 'another-machine',
      sessionId: 's-remote-live',
      cwd: '/w/app',
      name: 'app-cc',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(deadPath)).resolves.toBeDefined();
    await expect(fs.stat(livePath)).resolves.toBeDefined();
  });

  it('leaves a record alone when its machine is unrecorded', async () => {
    // Written by a build that predates the machine field: no claim we can
    // check, so no proof its PID is ours to read.
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      pidNamespace: readPidNamespaceId(),
      machineId: null,
      sessionId: 's-unknown-machine',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('leaves a record alone when its namespace is unrecorded', async () => {
    // Written by a build that predates the namespace field. We cannot
    // prove it is ours, so we cannot prove its PID is dead either.
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      sessionId: 's-unknown-ns',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    const live = await listLiveSessions();
    if (readPidNamespaceId() === null) {
      // No namespaces on this platform: nothing to disagree about, so the
      // record is ours and the sweep proceeds as it always did.
      expect(live).toEqual([]);
      await expect(fs.stat(filePath)).rejects.toThrow();
    } else {
      expect(live).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    }
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
      // A real token: a live record without one is unprovable and is
      // withheld from callers, which would empty this list before it
      // could be sorted.
      procStart: readProcStartToken(process.ppid),
      pidNamespace: readPidNamespaceId(),
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
