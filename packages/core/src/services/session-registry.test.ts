/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  PID_NAMESPACE_UNREADABLE,
  readMachineId,
  readPidNamespaceId,
  readProcStartToken,
} from '../utils/process-liveness.js';

/**
 * Lets a test put this process in the state the sentinel exists for: a
 * platform that has PID namespaces, on which our own could not be read.
 * Everything else passes through to the real implementation.
 */
const selfNamespaceUnreadable = vi.hoisted(() => ({ value: false }));

vi.mock('../utils/process-liveness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/process-liveness.js')>();
  return {
    ...actual,
    readPidNamespaceId: () =>
      selfNamespaceUnreadable.value
        ? actual.PID_NAMESPACE_UNREADABLE
        : actual.readPidNamespaceId(),
  };
});

/**
 * Lets a test reproduce the one state a real attacker produces and a
 * fixture cannot: an entry whose `fstat` size and whose actual byte count
 * disagree, because the inode grew between the two. Everything else about
 * `node:fs/promises` passes straight through.
 */
const statSizeLie = vi.hoisted(() => ({ value: null as number | null }));

/**
 * Lets a test land another session's sweep in the one window a fixture
 * cannot reach: after a replacing write has staged its temp file and
 * before it commits, which is where the entry it pinned can still be
 * unlinked out from under it. Armed with the path to remove; fires once.
 */
const sweepBeforeCommit = vi.hoisted(() => ({ value: null as string | null }));

/**
 * Lets a test make `readdir` fail the way an unreadable registry directory
 * does, without depending on the uid the suite runs as. A chmod-based
 * fixture proves nothing under root — which is what CI containers and this
 * repo's own sandbox commonly run as — and would silently degrade to a
 * no-op assertion there. Armed with an errno; fires once.
 */
const readdirFails = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Cast rather than annotated: `readdir` is an overload set whose return
  // type varies with `withFileTypes`, and a single async wrapper satisfies
  // none of the signatures directly. The wrapper is pass-through, so the
  // real types still hold at every call site.
  const readdir = (async (...args: unknown[]) => {
    const code = readdirFails.value;
    if (code !== null) {
      readdirFails.value = null;
      const error: NodeJS.ErrnoException = new Error(
        `${code}: permission denied, scandir`,
      );
      error.code = code;
      throw error;
    }
    return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as unknown as typeof actual.readdir;
  const writeFile: typeof actual.writeFile = async (...args) => {
    const result = await actual.writeFile(...args);
    const victim = sweepBeforeCommit.value;
    // Only the staged temp file: the arming test's own fixture write goes
    // through here too, and disarming on it would fire in the wrong place.
    if (
      victim !== null &&
      typeof args[0] === 'string' &&
      args[0].endsWith('.tmp')
    ) {
      sweepBeforeCommit.value = null;
      await actual.rm(victim, { force: true });
    }
    return result;
  };
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const realStat = handle.stat.bind(handle);
    handle.stat = async (options?: Parameters<typeof realStat>[0]) => {
      const stat = await realStat(options);
      if (statSizeLie.value === null) return stat;
      // Prototype-chained rather than spread: `isFile()` and friends live
      // on `Stats.prototype`, and a spread copy would lose them.
      return Object.create(stat, {
        size: { value: statSizeLie.value, enumerable: true },
      });
    };
    return handle;
  };
  return {
    ...actual,
    default: { ...actual, open, writeFile, readdir },
    open,
    writeFile,
    readdir,
  };
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
  statSizeLie.value = null;
  sweepBeforeCommit.value = null;
  readdirFails.value = null;
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

/**
 * Fail a hang as a normal assertion rather than as a suite timeout.
 *
 * A blocked FIFO open is held by a libuv fs thread that nothing can
 * cancel, so letting the test time out would take the rest of the file
 * down with it. Four seconds is far past any honest read of a directory
 * holding a handful of small files.
 */
async function withinFourSeconds<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('blocked for over 4s')), 4000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
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

  it('clears a file planted at the registry directory path and registers', async () => {
    // The co-tenant's two syscalls: move the directory aside, drop a
    // regular file at its name. Without a repair path this is a permanent
    // registration blackout — mkdir throws EEXIST here forever after.
    const dir = getSessionRegistryDir();
    await fs.writeFile(dir, 'not a directory');

    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(true);

    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    const live = await listLiveSessions({ includeSelf: true });
    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe('s1');
  });

  it('clears a dangling symlink planted at the registry directory path', async () => {
    // Fails mkdir with ENOENT rather than EEXIST, so it only gets repaired
    // if the branch keys on what is at the path rather than on the errno.
    const dir = getSessionRegistryDir();
    await fs.symlink(path.join(tmpDir, 'nowhere'), dir);

    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(true);

    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    expect(await listLiveSessions({ includeSelf: true })).toHaveLength(1);
  });

  it('clears a symlink to a file without following it', async () => {
    // The unlink must remove the link, never the thing it points at: a
    // repair that followed would delete an arbitrary attacker-named path.
    const dir = getSessionRegistryDir();
    const target = path.join(tmpDir, 'victim');
    await fs.writeFile(target, 'must survive');
    await fs.symlink(target, dir);

    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(true);

    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('must survive');
  });

  it('leaves an existing registry directory and its records alone', async () => {
    // The repair is reachable only through a failed mkdir. If it ever fired
    // on the healthy path it would unlink the directory every other live
    // session is registered in.
    const sibling = await writeRaw('4242.json', {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: 4242,
      sessionId: 'sibling',
      cwd: '/w/other',
      name: 'other-aa',
      kind: 'interactive',
      startedAt: Date.now(),
      pidNamespace: readPidNamespaceId(),
      procStart: null,
    });

    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(true);

    await expect(fs.stat(sibling)).resolves.toBeDefined();
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
    // The recorded token must always equal what this process reads for
    // itself — that is the regression this guards. The *shape* assertion
    // is separate and conditional: `readProcStartToken` returns null by
    // design where /proc is absent or restricted (a hardened container, a
    // hidepid mount), and requiring digits there would fail the suite for
    // an environmental reason rather than a code one.
    const selfToken =
      process.platform === 'linux' ? readProcStartToken(process.pid) : null;
    expect(live[0].procStart).toBe(selfToken);
    if (selfToken !== null) {
      expect(live[0].procStart).toMatch(/^\d+$/);
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
    const selfNamespace = readPidNamespaceId();
    expect(record.pidNamespace).toBe(selfNamespace);
    if (process.platform === 'linux') {
      // Either a namespace inode or the explicit "could not read it"
      // sentinel — never null, which would mean "this platform has no
      // namespaces" and let two containers agree they are one origin.
      expect(record.pidNamespace).not.toBeNull();
      if (selfNamespace !== PID_NAMESPACE_UNREADABLE) {
        expect(record.pidNamespace).toMatch(/^\d+$/);
      }
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

  it.skipIf(
    process.platform === 'win32' || typeof process.geteuid !== 'function',
  )(
    'takes over a same-origin record another user owns, rather than writing into it',
    async () => {
      // `sudo qwen` against the same HOME — a deployment this module's
      // threat model already names — leaves a 0600 record owned by root
      // at that PID. It is same-origin, so the recovery path above
      // applies, but a write that preserved the predecessor's inode
      // could not open it: registration would fail silently, and
      // nothing re-runs it. Replacement is what the entry is for.
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
      await fs.chmod(filePath, 0o600);
      const before = await fs.stat(filePath);

      // The fixture cannot be given a foreign uid without root, so the
      // comparison the decision actually reads is moved instead.
      const realGeteuid = process.geteuid!;
      process.geteuid = () => before.uid + 1;
      try {
        expect(
          await registerSession({
            sessionId: 's-ours',
            cwd: '/w/ours',
            kind: 'interactive',
          }),
        ).toBe(true);
      } finally {
        process.geteuid = realGeteuid;
      }

      // A new inode is the proof: the in-place path preserves it, and is
      // the one that cannot work on a file this process does not own.
      expect((await fs.stat(filePath)).ino).not.toBe(before.ino);
      expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
        sessionId: 's-ours',
        cwd: '/w/ours',
      });
    },
  );

  it('re-decides when a sweep unlinks the record it was replacing', async () => {
    // The replace path's version of the create path's lost race. Another
    // session's `qwen sessions ps` legitimately sweeps the stale
    // predecessor while this write sits between validation and commit;
    // the commit assertion then finds nothing. Giving up there costs the
    // session its entire lifetime on the register, because registration
    // is startup-only and nothing else writes the record.
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
    sweepBeforeCommit.value = filePath;

    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
      }),
    ).toBe(true);

    // Second pass sees a free name and claims it exclusively.
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

  it('refuses a foreign record it could not parse, instead of clobbering it', async () => {
    // A record one schema version ahead is rejected by the reader with its
    // origin thrown away, which lands it on the *replacing* write rather
    // than the origin gate. Being unreadable to us is not what makes a
    // record ours: this one is live somewhere else, nothing sweeps a
    // foreign entry, and registration only runs at startup — so the
    // clobber would take that session out of discovery for good.
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
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
    const before = await fs.readFile(filePath, 'utf8');

    const conflicts: Array<{ pid: number; filePath: string }> = [];
    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
        onOriginConflict: (info) => conflicts.push(info),
      }),
    ).toBe(false);

    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect(conflicts).toEqual([{ pid: process.pid, filePath }]);
  });

  it('still replaces an unusable entry that claims this origin', async () => {
    // The other half of the rule above: a truncated write from a previous
    // run of *this* session is exactly what the replacing write is for.
    // Refusing everything unparseable would strand registration on it
    // permanently.
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
      pidNamespace: readPidNamespaceId(),
      machineId: readMachineId(),
    });

    const onOriginConflict = vi.fn();
    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
        onOriginConflict,
      }),
    ).toBe(true);

    expect(onOriginConflict).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      sessionId: 's-ours',
    });
  });

  it('replaces an entry whose bytes carry no origin claim at all', async () => {
    const filePath = await writeRaw(`${process.pid}.json`, 'not json at all');

    expect(
      await registerSession({
        sessionId: 's-ours',
        cwd: '/w/ours',
        kind: 'interactive',
      }),
    ).toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      sessionId: 's-ours',
    });
  });

  // `mkfifo` has no Windows equivalent, and the flag it needs is absent
  // from `fs.constants` there.
  it.skipIf(process.platform === 'win32')(
    'does not hang on a FIFO planted at its own record path',
    async () => {
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      execFileSync('mkfifo', [getSessionRecordPath()]);

      // A blocking `O_RDONLY` open on a FIFO waits for a writer that never
      // comes, and the type check that would reject it cannot run until
      // the open returns — so startup registration never completes.
      await expect(
        withinFourSeconds(
          registerSession({
            sessionId: 's1',
            cwd: '/w/app',
            kind: 'interactive',
          }),
        ),
      ).resolves.toBe(true);
      expect((await fs.lstat(getSessionRecordPath())).isFIFO()).toBe(false);
    },
  );
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
    // The directory has to already exist, and that is not scene-setting:
    // it is what makes the failure reachable. With no `sessions/` at all
    // the stub write fails with ENOENT into `patchSessionRecord`'s catch,
    // so the guard could be gone and nothing would be written either way.
    // Production almost always has the directory — any other session on
    // the machine creates it — so the state this pins is the normal one,
    // not the empty-machine one.
    await fs.mkdir(getSessionRegistryDir(), { recursive: true });

    await patchSessionRecord({ sessionId: 'new' });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    // The list assertion alone cannot see this. Drop the `existing === null`
    // guard and the merge writes a stub `{sessionId: 'new'}` with no
    // schemaVersion, kind or startedAt; `readRecord` rejects it, so the
    // list is still empty and this test would stay green while the stub
    // sat at `<pid>.json` forever — never swept, because a record that
    // fails to read is skipped by the sweep, and invisible to every
    // reader. Production reaches that state whenever startup registration
    // fails (the best-effort path startInteractiveUI deliberately allows)
    // and a later `/clear` or cwd change patches anyway.
    await expect(fs.stat(getSessionRecordPath())).rejects.toThrow();
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

  it('throws rather than reporting an empty machine it could not read', async () => {
    // "Nothing is running" and "I could not look" are different facts, and
    // a diagnostic command that renders them identically is the one that
    // gets believed. ENOENT stays an empty list — see the test above — but
    // EACCES is the registry directory re-created by another uid, a
    // restrictive NFS export, or a sandbox uid mapping, and `qwen sessions
    // ps` has to be able to say so and exit non-zero.
    await fs.mkdir(getSessionRegistryDir(), { recursive: true });
    readdirFails.value = 'EACCES';

    await expect(listLiveSessions({ includeSelf: true })).rejects.toThrow(
      /EACCES/,
    );
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

// Symlinks are not creatable without elevation on stock Windows.
describe.skipIf(process.platform === 'win32')(
  'reading a record does not follow a symlink at its path',
  () => {
    /**
     * A valid record body sitting *outside* the registry directory, so
     * the only way to reach it is through the planted link. Inside the
     * directory it would be a sweep candidate in its own right and the
     * assertions below could not tell the two causes apart.
     */
    async function plantVictimOutsideRegistry(pid: number): Promise<string> {
      const victim = path.join(tmpDir, 'victim-record.json');
      await fs.writeFile(
        victim,
        JSON.stringify({
          schemaVersion: 1,
          pid,
          // A real token, so a build that followed the link would find a
          // record it considers live and report it. `null` would be
          // withheld anyway and the assertion below could not tell the
          // two reasons apart.
          procStart: readProcStartToken(pid),
          pidNamespace: readPidNamespaceId(),
          machineId: readMachineId(),
          sessionId: 's-victim',
          cwd: '/w/victim',
          name: 'victim-aa',
          kind: 'interactive',
          startedAt: 1000,
        }),
      );
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      return victim;
    }

    it('does not list what the link points at', async () => {
      // The write paths already refuse to follow a link here, so the read
      // that authorizes them must refuse too. Otherwise the *target* is
      // what gets validated while the *link* is what gets mutated, and a
      // co-tenant who aims `<pid>.json` at a sibling's record gets that
      // record acted on for them.
      //
      // The parent process is the one PID other than our own that is
      // reliably alive, which is what makes "not listed" load-bearing
      // rather than a restatement of the staleness sweep.
      const victim = await plantVictimOutsideRegistry(process.ppid);
      await fs.symlink(victim, getSessionRecordPath(process.ppid));

      expect(await listLiveSessions({ sweepStale: true })).toEqual([]);
      await expect(fs.stat(victim)).resolves.toBeDefined();
    });

    it('does not patch or unlink through one at its own record path', async () => {
      const victim = await plantVictimOutsideRegistry(DEAD_PID);
      await fs.symlink(victim, getSessionRecordPath(DEAD_PID));
      const before = await fs.readFile(victim, 'utf8');

      await patchSessionRecord({ sessionId: 'rewritten' }, DEAD_PID);
      await unregisterSession(DEAD_PID);

      expect(await fs.readFile(victim, 'utf8')).toBe(before);
      // The link itself is left alone too: it is not a record this code
      // wrote, so it is not this code's to delete.
      expect(
        (await fs.lstat(getSessionRecordPath(DEAD_PID))).isSymbolicLink(),
      ).toBe(true);
    });
  },
);

describe('an unreadable PID namespace is not an origin', () => {
  it('neither lists nor sweeps a record that could not name its namespace', async () => {
    // `null` means "this platform has no PID namespaces", which is a claim
    // two peers can share. The sentinel is the absence of a claim, and two
    // containers behind a hidepid mount would otherwise match on it and
    // read each other's PID numbers as their own.
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: '1',
      pidNamespace: PID_NAMESPACE_UNREADABLE,
      sessionId: 's-elsewhere',
      cwd: '/w/elsewhere',
      name: 'elsewhere-dd',
      kind: 'interactive',
      startedAt: 1000,
    });

    expect(await listLiveSessions({ sweepStale: true })).toEqual([]);
    // Not listed *and* not swept. A dead PID plus a same-origin verdict
    // would have deleted it; the file surviving is what shows the origin
    // gate rejected it first.
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('does not match another record that could not name its namespace either', async () => {
    // The case the sentinel exists for, and the only one plain inequality
    // does not already cover: two containers behind a `hidepid` mount,
    // sharing a machine id and a `QWEN_HOME`. Both write the sentinel, so
    // a `null`-collapsing build reads them as one origin and lets a
    // matching PID number list, overwrite, patch or sweep the other's
    // record.
    selfNamespaceUnreadable.value = true;
    try {
      const filePath = await writeRaw(`${DEAD_PID}.json`, {
        schemaVersion: 1,
        pid: DEAD_PID,
        procStart: '1',
        pidNamespace: PID_NAMESPACE_UNREADABLE,
        sessionId: 's-other-container',
        cwd: '/w/other',
        name: 'other-ee',
        kind: 'interactive',
        startedAt: 1000,
      });

      expect(await listLiveSessions({ sweepStale: true })).toEqual([]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      // The write paths keep their hands off it too.
      await patchSessionRecord({ sessionId: 'mine' }, DEAD_PID);
      await unregisterSession(DEAD_PID);
      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(onDisk.sessionId).toBe('s-other-container');
    } finally {
      selfNamespaceUnreadable.value = false;
    }
  });

  it('refuses to overwrite one at its own PID', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: '1',
      pidNamespace: PID_NAMESPACE_UNREADABLE,
      sessionId: 's-elsewhere',
      cwd: '/w/elsewhere',
      name: 'elsewhere-dd',
      kind: 'interactive',
      startedAt: 1000,
    });

    const conflicts: number[] = [];
    await expect(
      registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
        onOriginConflict: ({ pid }) => conflicts.push(pid),
      }),
    ).resolves.toBe(false);
    expect(conflicts).toEqual([process.pid]);

    const onDisk = JSON.parse(
      await fs.readFile(getSessionRecordPath(), 'utf8'),
    );
    expect(onDisk.sessionId).toBe('s-elsewhere');
  });
});

describe('ordering registry writes against withdrawal', () => {
  it('drops a patch that was queued before the record was withdrawn', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
      pid: DEAD_PID,
    });

    // `Config.refreshSessionId` queues its patch and returns without
    // awaiting it, so this is the production shape: a `/clear` still in
    // flight when exit cleanup runs. Both orders have to hold — the patch
    // must not land in the middle of the unlink, and must not run after
    // it either.
    const patch = patchSessionRecord({ sessionId: 's2' }, DEAD_PID);
    const withdraw = unregisterSession(DEAD_PID);
    await Promise.all([patch, withdraw]);

    await expect(fs.stat(getSessionRecordPath(DEAD_PID))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('drops a patch issued after the record was withdrawn', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
      pid: DEAD_PID,
    });
    await unregisterSession(DEAD_PID);
    await patchSessionRecord({ sessionId: 's2' }, DEAD_PID);

    await expect(fs.stat(getSessionRecordPath(DEAD_PID))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('reopens the register when the PID registers again', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
      pid: DEAD_PID,
    });
    await unregisterSession(DEAD_PID);
    await registerSession({
      sessionId: 's2',
      cwd: '/w/app',
      kind: 'interactive',
      pid: DEAD_PID,
    });
    await patchSessionRecord({ cwd: '/w/moved' }, DEAD_PID);

    const onDisk = JSON.parse(
      await fs.readFile(getSessionRecordPath(DEAD_PID), 'utf8'),
    );
    expect(onDisk.cwd).toBe('/w/moved');
  });
});

describe('bounding what one enumeration will do', () => {
  it('caps the records it examines per pass', async () => {
    // The filenames and the file count are both attacker-supplied here: a
    // sandboxed co-tenant can create `<digits>.json` at will, and an
    // unbounded fan-out would open a descriptor for every one of them in
    // a single tick. The sweep is what makes the ceiling observable —
    // exactly the records that were examined are the ones that go away.
    const total = 600;
    const cap = 512;
    for (let i = 0; i < total; i++) {
      const pid = DEAD_PID - i;
      await writeRaw(`${pid}.json`, {
        schemaVersion: 1,
        pid,
        procStart: '1',
        pidNamespace: readPidNamespaceId(),
        sessionId: `s-${i}`,
        cwd: '/w/app',
        name: `app-${i}`,
        kind: 'interactive',
        startedAt: 1000,
      });
    }

    expect(await listLiveSessions({ sweepStale: true })).toEqual([]);

    const left = (await fs.readdir(getSessionRegistryDir())).filter((n) =>
      /^\d+\.json$/.test(n),
    );
    expect(left).toHaveLength(total - cap);

    // Not a leak: the next pass takes the remainder.
    await listLiveSessions({ sweepStale: true });
    expect(
      (await fs.readdir(getSessionRegistryDir())).filter((n) =>
        /^\d+\.json$/.test(n),
      ),
    ).toEqual([]);
  });

  it('bounds the bytes it reads even when the size check was told otherwise', async () => {
    // The size check and a read-to-EOF are two observations of an inode a
    // co-tenant is still writing to, so the check passing at eleven bytes
    // says nothing about what the read returns. With up to 512 candidates
    // per pass and a free retry on every `qwen sessions ps`, an unbounded
    // read there is a memory-exhaustion lever, not a parse error.
    //
    // The padding sits inside an otherwise *valid, live* record on
    // purpose: garbage would be rejected by the parser either way, and the
    // cap would look enforced while nothing enforced it.
    const filePath = await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNamespace: readPidNamespaceId(),
      sessionId: 's-oversized',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
      filler: 'x'.repeat(64 * 1024),
    });
    expect((await fs.stat(filePath)).size).toBeGreaterThan(64 * 1024);
    statSizeLie.value = 11;

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    // Rejected on the byte count, not swept: nothing here proved it dead.
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  // `mkfifo` has no Windows equivalent.
  it.skipIf(process.platform === 'win32')(
    'does not hang on a FIFO planted among the candidates',
    async () => {
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      execFileSync('mkfifo', [getSessionRecordPath(DEAD_PID)]);

      // Under this directory's own threat model a co-tenant names
      // `<digits>.json` at will, so `mkfifo` there is a one-command hang of
      // every `qwen sessions ps` on the box — and a handful of them
      // exhausts libuv's four-thread fs pool for the whole process.
      await expect(withinFourSeconds(listLiveSessions())).resolves.toEqual([]);
    },
  );
});
