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
  readLocalBootId,
  readPidNamespaceId,
} from '../utils/process-liveness.js';

/**
 * Records the paths `readRecord` stats, while the real filesystem does the
 * work. The `<pid>.json` filename filter is invisible from the outside —
 * the filename/contents agreement check downstream rejects everything a
 * looser regex would let through — so the only way to hold the filter to
 * its stated job, not reading whatever else lives in `~/.qwen/sessions`,
 * is to watch what it opens.
 */
const statCalls: string[] = [];
let recordStatCalls = false;

vi.mock('node:fs/promises', async () => {
  const real =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  return {
    ...real,
    default: real,
    stat: (...args: Parameters<typeof real.stat>) => {
      if (recordStatCalls) statCalls.push(path.basename(String(args[0])));
      return real.stat(...args);
    },
  };
});

vi.mock('../config/storage.js', () => {
  let mockDir: string | null = '/tmp/session-registry-test';
  return {
    Storage: {
      getGlobalQwenDir: () => {
        if (mockDir === null) {
          // Simulates os.homedir() failing (HOME unset, passwd lookup
          // gone) — the registry's "never throws" promise is tested
          // against exactly this.
          throw new Error('home directory unavailable');
        }
        return mockDir;
      },
    },
    __setMockGlobalDir: (d: string | null) => {
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

/**
 * A record body that `listLiveSessions` must accept and return verbatim:
 * schema 1, this process's (live) PID, and no start token, so the liveness
 * check degrades to "the PID is running" on every platform.
 *
 * Every rejection case below is this body with one field spoiled, so a
 * spoiled field that stops being rejected shows up as a listed record
 * rather than as nothing at all.
 */
function liveBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid: process.pid,
    procStart: null,
    // Records planted here model a writer in THIS process, so the
    // namespace identity is the caller's own — anything else would be
    // skipped by the namespace guard before its fields even matter.
    pidNs: readPidNamespaceId(),
    sessionId: 's',
    cwd: '/w',
    name: 'n',
    startedAt: 5,
    qwenVersion: null,
    ...over,
  };
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

  it('keeps non-ASCII letters instead of stripping them to a dash', () => {
    // An ASCII-only character class reduces every CJK basename to the
    // same bare dash — zero identifying information for exactly the
    // projects whose names are not ASCII.
    const a = deriveSessionName('/home/u/项目', 's1');
    const b = deriveSessionName('/home/u/別項目', 's1');
    expect(a).toMatch(/^项目-[0-9a-f]{2}$/);
    expect(b).toMatch(/^別項目-[0-9a-f]{2}$/);
    expect(a).not.toBe(b);
  });

  it('falls back to a placeholder when the basename is empty', () => {
    expect(deriveSessionName('/', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });

  it('falls back to a placeholder when the basename strips to dashes only', () => {
    expect(deriveSessionName('/w/!!!', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });

  it('caps the basename at 32 characters so the name fits a table cell', () => {
    const name = deriveSessionName(`/w/${'a'.repeat(80)}`, 's1');
    expect(name).toMatch(/^a{32}-[0-9a-f]{2}$/);
    expect(name).toHaveLength(35);
  });
});

describe('registerSession', () => {
  it('writes a record for this process and lists it back', async () => {
    const before = Date.now();
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        qwenVersion: '1.2.3',
      }),
    ).toBe(true);
    const after = Date.now();

    const live = await listLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      sessionId: 's1',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
    expect(live[0].name).toMatch(/^app-[0-9a-f]{2}$/);
    // Bounds pin the epoch: a seconds-vs-milliseconds refactor (or a
    // constant) ships green through every other assertion here, then
    // breaks the AGE column and the newest-first ordering for everyone.
    expect(live[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(live[0].startedAt).toBeLessThanOrEqual(after);
  });

  it('records the writer’s PID namespace identity', async () => {
    await registerSession({ sessionId: 's1', cwd: '/w/app' });
    const raw = JSON.parse(
      await fs.readFile(getSessionRecordPath(), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['pidNs']).toBe(readPidNamespaceId());
  });

  it('records an explicit null qwenVersion when it is omitted', async () => {
    // The key must exist as null, not be silently dropped by
    // JSON.stringify(undefined): the record format has a declared
    // schemaVersion, and schema drift on an optional field is still drift.
    await registerSession({ sessionId: 's1', cwd: '/w/app' });
    const raw = JSON.parse(
      await fs.readFile(getSessionRecordPath(), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw).toHaveProperty('qwenVersion', null);
  });

  // Only Linux has a start token to record; elsewhere this is a visible
  // skip rather than a test that passes without asserting.
  it.runIf(process.platform === 'linux')(
    'records the live start token on registration',
    async () => {
      // The writer side of the PID-reuse guard: a null token here would
      // degrade every later liveness check to a bare kill(pid, 0) and
      // let a recycled PID resurrect this record after exit.
      await registerSession({ sessionId: 's1', cwd: '/w/app' });
      const raw = JSON.parse(
        await fs.readFile(getSessionRecordPath(), 'utf8'),
      ) as Record<string, unknown>;
      expect(raw['procStart']).toMatch(/^[0-9a-f-]+:\d+$/i);
    },
  );

  // Windows synthesizes st_mode from file attributes and `chmod` can only
  // toggle the read-only bit, so permission assertions are meaningless
  // there. Guarded rather than deleted, the same way
  // `session-writer-lease.test.ts` guards its identical 0700/0600 pair.
  const itPosix = it.runIf(process.platform !== 'win32');

  itPosix('creates the registry directory as 0700', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
    });
    const stat = await fs.stat(getSessionRegistryDir());
    expect(stat.mode & 0o777).toBe(0o700);
  });

  itPosix('tightens a pre-existing loose registry directory', async () => {
    await fs.mkdir(getSessionRegistryDir(), { recursive: true, mode: 0o755 });
    await fs.chmod(getSessionRegistryDir(), 0o755);

    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
    });

    const stat = await fs.stat(getSessionRegistryDir());
    expect(stat.mode & 0o777).toBe(0o700);
  });

  itPosix('writes the record as 0600', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
    });
    const stat = await fs.stat(getSessionRecordPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  itPosix(
    'replaces a pre-planted symlink instead of writing through it',
    async () => {
      // Anything that can create a file in the registry directory could park
      // a symlink at `<pid>.json` and redirect the registration write. With
      // `noFollow` the rename replaces the link; without it the write
      // resolves the chain and lands on the attacker's target.
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      const outside = path.join(tmpDir, 'outside.txt');
      await fs.writeFile(outside, 'untouched');
      await fs.symlink(outside, getSessionRecordPath());

      expect(await registerSession({ sessionId: 's1', cwd: '/w/app' })).toBe(
        true,
      );

      expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
      expect((await fs.lstat(getSessionRecordPath())).isSymbolicLink()).toBe(
        false,
      );
    },
  );

  it('refuses to overwrite a record held by another PID namespace', async () => {
    // Host + devcontainer (or sibling containers) sharing one home can
    // collide on a PID number; the loser of an overwrite would lose its
    // record when the winner exits. First writer wins instead, and the
    // second session stays undiscoverable — degraded but safe.
    const foreign = liveBody({ pidNs: 1, sessionId: 'theirs' });
    await writeRaw(`${process.pid}.json`, foreign);

    expect(await registerSession({ sessionId: 'mine', cwd: '/w/app' })).toBe(
      false,
    );

    expect(
      JSON.parse(await fs.readFile(getSessionRecordPath(), 'utf8')),
    ).toEqual(foreign);
  });

  it.runIf(process.platform === 'linux')(
    'refuses to overwrite a record held by another machine’s boot',
    async () => {
      // The initial PID namespace inode is a kernel constant identical on
      // every Linux machine, so machines sharing a home over NFS pass
      // the namespace comparison — only the boot prefix separates them.
      expect(readLocalBootId()).not.toBeNull();
      const foreign = liveBody({
        procStart: 'not-this-boot:1',
        sessionId: 'theirs',
      });
      await writeRaw(`${process.pid}.json`, foreign);

      expect(await registerSession({ sessionId: 'mine', cwd: '/w/app' })).toBe(
        false,
      );

      expect(
        JSON.parse(await fs.readFile(getSessionRecordPath(), 'utf8')),
      ).toEqual(foreign);
    },
  );

  it('reports failure instead of throwing when the home dir is unwritable', async () => {
    __setMockGlobalDir(path.join(tmpDir, 'nope', '\0invalid'));
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
      }),
    ).toBe(false);
  });
});

describe('never-throw guarantee', () => {
  it('every entry point resolves when the home directory cannot be resolved', async () => {
    // `os.homedir()` throws when HOME is unset and the passwd lookup
    // fails (some containers/CI images). `ps` has no catch on the
    // strength of the registry's promise, so a rejection here would be
    // an unhandled rejection in exactly that environment.
    __setMockGlobalDir(null);

    await expect(listLiveSessions()).resolves.toEqual([]);
    await expect(
      patchSessionRecord({ sessionId: 'new' }),
    ).resolves.toBeUndefined();
    await expect(
      registerSession({ sessionId: 's1', cwd: '/w/app' }),
    ).resolves.toBe(false);
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('patchSessionRecord', () => {
  it('updates a field without dropping the others', async () => {
    await registerSession({
      sessionId: 'old',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
    const [before] = await listLiveSessions();

    await patchSessionRecord({ sessionId: 'new', name: 'renamed' });

    const [record] = await listLiveSessions();
    expect(record).toMatchObject({
      sessionId: 'new',
      name: 'renamed',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
    // Both production patch sites omit `startedAt`; a re-stamp would
    // reset the AGE column and the newest-first ordering on every
    // /clear and /cd.
    expect(record.startedAt).toBe(before.startedAt);
  });

  it('does not create a record for a session that never registered', async () => {
    // The registry directory exists, so the only thing standing between a
    // patch and a half-populated record on disk is the missing-record
    // guard. Asserting an empty listing is not enough: a record built from
    // the patch alone fails validation and so lists as nothing either way.
    await fs.mkdir(getSessionRegistryDir(), { recursive: true });

    await patchSessionRecord({ sessionId: 'new' });

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(getSessionRecordPath())).rejects.toThrow();
  });

  it('leaves a foreign record sitting at this pid’s path untouched', async () => {
    // `readRecord` does not check filename/contents agreement, so without
    // the pid guard a patch would merge into someone else's record and
    // write back something `listLiveSessions` will neither show nor sweep.
    const foreign = liveBody({ pid: process.pid + 1, sessionId: 'theirs' });
    const filePath = await writeRaw(`${process.pid}.json`, foreign);

    await patchSessionRecord({ sessionId: 'mine' });

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(foreign);
  });

  it.runIf(process.platform === 'linux')(
    'refuses to merge into a stale record left by a dead previous incarnation of this PID',
    async () => {
      // Session A died without unlinking (SIGKILL); PID P was recycled by
      // session B whose registration failed. B's patch passes the pid,
      // namespace and boot checks — same machine — and only the start
      // token proves the record is not A's; without it the merge would
      // graft B's fields onto A's startedAt/version/name and list the
      // chimera as live. (A foreign boot prefix would be refused by the
      // machine-identity check instead.)
      const bootId = readLocalBootId();
      expect(bootId).not.toBeNull();
      const filePath = await writeRaw(
        `${process.pid}.json`,
        liveBody({ procStart: `${bootId}:1`, sessionId: 'incarnation-a' }),
      );

      await patchSessionRecord({ sessionId: 'incarnation-b' });

      expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
        sessionId: 'incarnation-a',
      });
    },
  );

  it('preserves the identity fields across the patch merge', async () => {
    // Both production patch sites run in ordinary use; a merge that
    // drops `procStart` degrades every later liveness check to a bare
    // kill(pid, 0) — a recycled PID resurrects the record — and a
    // dropped `pidNs` hides the session behind the namespace guard.
    await registerSession({ sessionId: 's1', cwd: '/w/app' });
    const before = JSON.parse(
      await fs.readFile(getSessionRecordPath(), 'utf8'),
    ) as Record<string, unknown>;
    if (process.platform === 'linux') {
      // Otherwise the procStart equality pin below is vacuous.
      expect(before['procStart']).not.toBeNull();
    }

    await patchSessionRecord({ sessionId: 'new', cwd: '/w/b' });

    const after = JSON.parse(
      await fs.readFile(getSessionRecordPath(), 'utf8'),
    ) as Record<string, unknown>;
    expect(after['procStart']).toBe(before['procStart']);
    expect(after['pidNs']).toBe(before['pidNs']);
    expect(after['pid']).toBe(process.pid);
  });

  it('still patches a record written without a start token', async () => {
    // Tokenless platforms must keep working through the pid comparison —
    // the guard only fires when BOTH sides have a token to compare.
    await writeRaw(`${process.pid}.json`, liveBody());

    await patchSessionRecord({ sessionId: 'new' });

    const [record] = await listLiveSessions();
    expect(record.sessionId).toBe('new');
  });

  const itPosixPatch = it.runIf(process.platform !== 'win32');

  itPosixPatch('keeps the record at 0600 across a patch', async () => {
    await registerSession({ sessionId: 's1', cwd: '/w/app' });
    await patchSessionRecord({ sessionId: 'new' });
    const stat = await fs.stat(getSessionRecordPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  itPosixPatch(
    'replaces a symlinked record instead of patching through it',
    async () => {
      // Mirror of the registration symlink test: the patch path is
      // written on every /clear and /cd, so a dropped `noFollow` would
      // redirect those writes through a pre-planted link just the same.
      await registerSession({ sessionId: 's1', cwd: '/w/app' });
      const outside = path.join(tmpDir, 'outside.json');
      await fs.writeFile(
        outside,
        JSON.stringify(liveBody({ sessionId: 'outside' })),
      );
      await fs.rm(getSessionRecordPath());
      await fs.symlink(outside, getSessionRecordPath());

      await patchSessionRecord({ sessionId: 'patched' });

      const outsideRecord = JSON.parse(
        await fs.readFile(outside, 'utf8'),
      ) as Record<string, unknown>;
      expect(outsideRecord['sessionId']).toBe('outside');
      expect((await fs.lstat(getSessionRecordPath())).isSymbolicLink()).toBe(
        false,
      );
      const [record] = await listLiveSessions();
      expect(record?.sessionId).toBe('patched');
    },
  );
});

describe('unregisterSession', () => {
  it('removes the record', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
    });
    await unregisterSession();
    expect(await listLiveSessions()).toEqual([]);
  });

  it('removes only this process’s record, leaving siblings intact', async () => {
    // Plant a live sibling: a broadened deletion ("also clean up stale
    // records on exit") would wipe it too, and registration is one-shot
    // — the victim would stay invisible in `ps` for its whole lifetime.
    await writeRaw(
      `${process.ppid}.json`,
      liveBody({
        pid: process.ppid,
        sessionId: 's-sibling',
        startedAt: Date.now(),
      }),
    );
    await registerSession({ sessionId: 's1', cwd: '/w/app' });

    await unregisterSession();

    await expect(fs.stat(getSessionRecordPath())).rejects.toThrow();
    const live = await listLiveSessions();
    expect(live.map((r) => r.sessionId)).toEqual(['s-sibling']);
  });

  it('leaves a foreign-identity record at its path alone', async () => {
    // The path is keyed by PID alone: the record sitting there may
    // belong to a live session in another namespace that shares the
    // number. Unlinking it would hide that session until it restarts.
    const foreign = liveBody({ pidNs: 1, sessionId: 'theirs' });
    await writeRaw(`${process.pid}.json`, foreign);

    await unregisterSession();

    expect(
      JSON.parse(await fs.readFile(getSessionRecordPath(), 'utf8')),
    ).toEqual(foreign);
  });

  it('is a no-op when nothing was registered', async () => {
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('listLiveSessions', () => {
  it('returns an empty list when the registry does not exist', async () => {
    expect(await listLiveSessions()).toEqual([]);
  });

  it('sweeps a record whose process is gone', async () => {
    const filePath = await writeRaw(
      `${DEAD_PID}.json`,
      liveBody({
        pid: DEAD_PID,
        sessionId: 's-dead',
        cwd: '/w/app',
        name: 'app-aa',
        startedAt: Date.now(),
      }),
    );

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  // Only Linux has a start token to disagree with, so elsewhere this is a
  // visible skip rather than a test that passes without asserting.
  it.runIf(process.platform === 'linux')(
    'treats a recycled PID as stale',
    async () => {
      // Our own PID is alive, but the recorded start token belongs to a
      // different process on THIS boot — so the record describes a
      // session that is gone. (A foreign boot prefix would model another
      // machine, which is skipped rather than swept.)
      const bootId = readLocalBootId();
      expect(bootId).not.toBeNull();
      const filePath = await writeRaw(
        `${process.pid}.json`,
        liveBody({
          procStart: `${bootId}:1`,
          sessionId: 's-recycled',
          cwd: '/w/app',
          name: 'app-aa',
          startedAt: Date.now(),
        }),
      );

      expect(await listLiveSessions()).toEqual([]);
      await expect(fs.stat(filePath)).rejects.toThrow();
    },
  );

  it('neither lists nor sweeps a record from a different PID namespace, even a dead one', async () => {
    // PID numbers do not resolve across the namespace boundary: kill(pid, 0)
    // over here reports ESRCH for a process alive over there, and a
    // "matching" starttime can belong to an unrelated process. Liveness
    // proved on the wrong side is worse than no answer, so the record is
    // left for a reader on the writer's own side — even when its PID
    // looks dead here.
    const filePath = await writeRaw(
      `${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, pidNs: 1 }),
    );

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('does not list a foreign-namespace record under a live PID', async () => {
    // The sharp end of the guard: without it this record passes plain
    // liveness (the PID is us) and is listed as our session.
    const filePath = await writeRaw(
      `${process.pid}.json`,
      liveBody({ pidNs: 1 }),
    );

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it.runIf(process.platform === 'linux')(
    'neither lists nor sweeps a record from another machine’s boot',
    async () => {
      // Same initial-namespace inode on every Linux machine, so the
      // namespace guard cannot separate two machines sharing one home —
      // the boot prefix must. The recorded PID is dead on this side, so
      // without the guard the sweep unlinks a live session's record on
      // the other machine.
      expect(readLocalBootId()).not.toBeNull();
      const filePath = await writeRaw(
        `${DEAD_PID}.json`,
        liveBody({ pid: DEAD_PID, procStart: 'not-this-boot:1' }),
      );

      expect(await listLiveSessions()).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    },
  );

  it('sweeps registration temp files orphaned by a crashed write', async () => {
    // A writer that dies between the temp write and the rename leaves
    // the temp behind; nothing else ever removes it.
    const orphan = await writeRaw(`${process.pid}.json.0123456789ab.tmp`, '{}');
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(orphan, stale, stale);

    // A fresh temp may belong to a writer mid-rename — the age check
    // must spare it.
    const fresh = await writeRaw(`${process.pid}.json.fedcba987654.tmp`, '{}');

    await listLiveSessions();

    await expect(fs.stat(orphan)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
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
      startedAt: 1,
    });

    expect(await listLiveSessions()).toEqual([]);
    // Critically, none of them were deleted.
    const remaining = await fs.readdir(getSessionRegistryDir());
    expect(remaining.sort()).toEqual([
      '007.json',
      '2026-planning-notes.json',
      'notes.txt',
    ]);
  });

  it('never opens a file that is not named <pid>.json', async () => {
    await writeRaw('2026-planning-notes.json', { hello: 'world' });
    await writeRaw('notes.txt', 'nope');
    // Anchored at both ends, with the dot escaped: `session-2026.json`
    // defeats a regex missing its `^`, `12.json.bak` one missing its `$`,
    // and `12xjson` one whose `.` is a wildcard.
    await writeRaw('session-2026.json', { hello: 'world' });
    await writeRaw('12.json.bak', { hello: 'world' });
    await writeRaw('12xjson', { hello: 'world' });
    await writeRaw(`${process.pid}.json`, liveBody());

    statCalls.length = 0;
    recordStatCalls = true;
    try {
      expect(await listLiveSessions()).toEqual([liveBody()]);
    } finally {
      recordStatCalls = false;
    }

    expect(statCalls).toEqual([`${process.pid}.json`]);
  });

  it('skips a record whose pid disagrees with its filename', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid + 1,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      startedAt: 1,
    });
    expect(await listLiveSessions()).toEqual([]);
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
      startedAt: 1,
    });
    await writeRaw('13.json', {
      schemaVersion: 1,
      pid: 13,
      sessionId: 's',
      cwd: '/w',
      name: 42,
      startedAt: 1,
    });

    expect(await listLiveSessions()).toEqual([]);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual([
      '11.json',
      '12.json',
      '13.json',
    ]);
  });

  it('returns a well-formed record verbatim', async () => {
    // The control for every rejection case below, and the only assertion
    // that pins the exact field set a reader gets back.
    await writeRaw(`${process.pid}.json`, liveBody());
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it('drops unknown fields rather than passing them on', async () => {
    // Without the drop, arbitrary keys from a hand-planted <pid>.json
    // would ride the typed record into `ps --json` output — and be
    // re-persisted permanently by patchSessionRecord's merge.
    await writeRaw(`${process.pid}.json`, { ...liveBody(), extraField: 'x' });
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it('nulls optional fields of the wrong type rather than passing them on', async () => {
    // A numeric `procStart` handed to `isSameProcess` would never equal the
    // string token it reads back, so a live session would be swept; a
    // numeric `qwenVersion` would reach every consumer typed as a string.
    await writeRaw(
      `${process.pid}.json`,
      liveBody({ procStart: 12345, qwenVersion: 7 }),
    );
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it.each([
    ['a string schemaVersion', { schemaVersion: '1' }],
    ['no schemaVersion at all', { schemaVersion: undefined }],
    ['a string pid', { pid: String(process.pid) }],
    ['a non-string sessionId', { sessionId: 42 }],
    ['a non-string cwd', { cwd: null }],
    ['a non-string name', { name: 42 }],
    ['a string startedAt', { startedAt: '5' }],
  ])(
    'skips a record with %s, and never sweeps it',
    async (_what, over: Record<string, unknown>) => {
      const filePath = await writeRaw(`${process.pid}.json`, liveBody(over));
      expect(await listLiveSessions()).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    },
  );

  it('skips a record whose startedAt is not finite', async () => {
    // JSON has no Infinity literal, but 1e999 parses to one — and an
    // Infinity `startedAt` sorts every real session below it forever.
    const filePath = await writeRaw(
      `${process.pid}.json`,
      JSON.stringify(liveBody()).replace('"startedAt":5', '"startedAt":1e999'),
    );
    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('never sweeps 0.json, which no real process can own', async () => {
    // `0.json` clears the filename regex and agrees with its own contents,
    // so only the `pid <= 0` check stops `process.kill(0, 0)` — a
    // whole-process-group signal — from deciding a stranger's file's fate.
    const filePath = await writeRaw('0.json', liveBody({ pid: 0 }));
    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('refuses to parse a record larger than 64 KiB', async () => {
    const filePath = await writeRaw(
      `${process.pid}.json`,
      liveBody({ cwd: `/w/${'x'.repeat(70_000)}` }),
    );
    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('sorts newest first', async () => {
    await registerSession({
      sessionId: 's-self',
      cwd: '/w/app',
    });
    await patchSessionRecord({ startedAt: 1000 });
    await writeRaw(
      `${process.ppid}.json`,
      liveBody({
        pid: process.ppid,
        sessionId: 's-parent',
        cwd: '/w/other',
        name: 'other-bb',
        startedAt: 2000,
      }),
    );

    const live = await listLiveSessions();
    expect(live.map((r) => r.sessionId)).toEqual(['s-parent', 's-self']);
  });
});
