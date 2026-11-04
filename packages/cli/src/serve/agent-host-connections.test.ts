/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';
import {
  type AgentHostRestoreRuntime,
  agentHostConnectionsPath,
  findAgentHostConnection,
  findAgentHostConnectionChecked,
  readAgentHostConnections,
  removeAgentHostConnection,
  restoreAgentHostConnections,
  saveAgentHostConnection,
} from './agent-host-connections.js';

const { hasCredential, startConnection, isRunning } = vi.hoisted(() => ({
  hasCredential: vi.fn<(...args: unknown[]) => Promise<boolean | undefined>>(),
  startConnection: vi.fn<(...args: unknown[]) => Promise<void>>(),
  isRunning: vi.fn<(...args: unknown[]) => boolean>(),
}));
vi.mock('./agent-host-client.js', () => ({
  hasAgentHostCredential: hasCredential,
  isAgentHostConnectionRunning: isRunning,
  startAgentHostConnection: startConnection,
}));
vi.mock('../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));
// Passed through; individual cases step in between a write's steps.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  };
});

let home: string;
const record = {
  serverUrl: 'https://hub.example',
  workspaceId: 'ws_1',
  workspaceCwd: '/work',
  allowHttp: false,
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'host-connections-'));
  vi.stubEnv('QWEN_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

it('saves one record per connection, privately, and removes it', async () => {
  await saveAgentHostConnection(record);
  await saveAgentHostConnection({ ...record, allowHttp: true });
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_2' });

  expect(await readAgentHostConnections()).toEqual([
    { ...record, allowHttp: true },
    { ...record, workspaceId: 'ws_2' },
  ]);
  if (process.platform !== 'win32') {
    expect((await fs.stat(agentHostConnectionsPath())).mode & 0o777).toBe(
      0o600,
    );
  }

  expect(await removeAgentHostConnection(record)).toBe(true);
  expect(await removeAgentHostConnection(record)).toBe(false);
  expect(await readAgentHostConnections()).toEqual([
    { ...record, workspaceId: 'ws_2' },
  ]);
});

it('finds a saved connection by its key, reading an unreadable file as none', async () => {
  expect(await findAgentHostConnection(record)).toBeUndefined();
  await saveAgentHostConnection(record);
  // The key leaves `allowHttp` out, as the restore loop's match does.
  const overHttp = { ...record, allowHttp: true };
  expect(await findAgentHostConnection(overHttp)).toEqual(record);
  for (const other of [
    { ...record, workspaceId: 'ws_2' },
    { ...record, workspaceCwd: '/other' },
    { ...record, serverUrl: 'https://elsewhere.example' },
  ]) {
    expect(await findAgentHostConnection(other)).toBeUndefined();
  }
  await fs.writeFile(agentHostConnectionsPath(), '{not json');
  expect(await findAgentHostConnection(record)).toBeUndefined();
});

it('tells an absent record apart from an unreadable file', async () => {
  // The disconnect guard may only stop a connection it can confirm is
  // forgotten; "could not read" must not pass for "no record", or the restore
  // loop reconnects the record still on disk and undoes the disconnect.
  expect(await findAgentHostConnectionChecked(record)).toEqual({
    kind: 'absent',
  });
  await saveAgentHostConnection(record);
  expect(await findAgentHostConnectionChecked(record)).toEqual({
    kind: 'found',
    record,
  });
  // A corrupt file is not a readable empty one.
  await fs.writeFile(agentHostConnectionsPath(), '{not json');
  expect(await findAgentHostConnectionChecked(record)).toEqual({
    kind: 'unreadable',
  });
  // Nor is a read failure: a path that is a directory reads as EISDIR, a
  // non-ENOENT error the strict reader must surface rather than swallow.
  await fs.rm(agentHostConnectionsPath(), { force: true });
  await fs.mkdir(agentHostConnectionsPath());
  expect(await findAgentHostConnectionChecked(record)).toEqual({
    kind: 'unreadable',
  });
  // The resilient lookup the restore loop uses still reads unreadable as none.
  await fs.rm(agentHostConnectionsPath(), { recursive: true, force: true });
  await fs.writeFile(agentHostConnectionsPath(), '{not json');
  expect(await findAgentHostConnection(record)).toBeUndefined();
});

const actualFs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const lockBusy = () =>
  Object.assign(new Error('Lock file is already being held'), {
    code: 'ELOCKED',
  });

/** A lock spy whose first call resolves `attempted`, without advancing time. */
function spyOnLock(
  implementation: typeof lockfile.lock = async () => {
    throw lockBusy();
  },
) {
  let attempted!: () => void;
  const firstAttempt = new Promise<void>((resolve) => (attempted = resolve));
  const spy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementation((...args: Parameters<typeof lockfile.lock>) => {
      attempted();
      return implementation(...args);
    });
  return { spy, firstAttempt };
}

it('waits out a lock that a crashed process left behind', async () => {
  // A holder killed while it held the lock (SIGKILL, OOM) leaves it until it
  // goes stale (10 s). A shorter wait reported the join unsaved, so a restart
  // lost the connection. This lock was last refreshed 4 s ago and goes stale
  // in about 6 s (5 s if the filesystem rounds mtimes to the second), past
  // the 3.75 s the old retries waited.
  await fs.mkdir(path.dirname(agentHostConnectionsPath()), { recursive: true });
  const lockDir = `${agentHostConnectionsPath()}.lock`;
  await fs.mkdir(lockDir);
  const lastRefresh = new Date(Date.now() - 4000);
  await fs.utimes(lockDir, lastRefresh, lastRefresh);
  const startedAt = Date.now();
  await saveAgentHostConnection(record);
  // The wait shows the planted lock was in the way; a lock the code never
  // looked at would let the write through in milliseconds.
  expect(Date.now() - startedAt).toBeGreaterThan(4000);
  expect(await readAgentHostConnections()).toEqual([record]);
}, 20_000);

it("waits longer than a dead holder's lock can take to go stale", async () => {
  // A lock stamped just before its holder crashed can take `stale` plus 1 s
  // to go stale: proper-lockfile stamps a process's first lock up to 1 s
  // ahead. The writer must still be waiting by then, with some margin.
  vi.useFakeTimers();
  // No jitter, so the last attempt lands right after the deadline.
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  const { spy, firstAttempt } = spyOnLock();
  try {
    const startedAt = Date.now();
    const outcome = saveAgentHostConnection(record).catch(
      (error: unknown) => error,
    );
    await firstAttempt;
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ code: 'ELOCKED' });
    // proper-lockfile's default: daemons of other versions share this lock.
    const { stale } = spy.mock.calls[0][1]!;
    expect(stale).toBe(10_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(12_000);
  } finally {
    spy.mockRestore();
    random.mockRestore();
    vi.useRealTimers();
  }
});

it('does not wait again for each writer queued behind a held lock', async () => {
  // Writers in one daemon take turns; the wait counts from each call, so a
  // second writer queued behind one that waited the lock out gives up with
  // it instead of waiting its own full turn after it.
  vi.useFakeTimers();
  const { spy, firstAttempt } = spyOnLock();
  try {
    const startedAt = Date.now();
    const outcomes = await Promise.all([
      saveAgentHostConnection(record).catch((error: unknown) => error),
      removeAgentHostConnection(record).catch((error: unknown) => error),
      (async () => {
        await firstAttempt;
        await vi.runAllTimersAsync();
      })(),
    ]);
    expect(outcomes.slice(0, 2)).toMatchObject([
      { code: 'ELOCKED' },
      { code: 'ELOCKED' },
    ]);
    expect(Date.now() - startedAt).toBeLessThan(14_000);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});

it('still tries once when its turn comes after its wait is over', async () => {
  // Queued behind a writer that waited a held lock out: by its turn the lock
  // is free, so it takes it rather than failing without a look.
  vi.useFakeTimers();
  const realLock = lockfile.lock;
  let free = false;
  const { spy, firstAttempt } = spyOnLock(async (...args) => {
    if (!free) throw lockBusy();
    return realLock(...args);
  });
  try {
    const first = saveAgentHostConnection(record).catch((error: unknown) => {
      free = true;
      return error;
    });
    const second = saveAgentHostConnection({ ...record, workspaceId: 'ws_2' });
    await firstAttempt;
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ code: 'ELOCKED' });
    await second;
    expect(spy.mock.calls.length).toBeGreaterThan(2);
    expect(
      (await readAgentHostConnections()).map((entry) => entry.workspaceId),
    ).toEqual(['ws_2']);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});

it('gives up at its deadline when the writer ahead of it is stuck', async () => {
  // A writer stuck on a hung disk must not hold every later write, and the
  // join waiting on one, past its own wait. The writer after that still
  // waits for the stuck one, so the two never write at once.
  vi.useFakeTimers();
  const realLock = lockfile.lock;
  let unstick!: (error: Error) => void;
  const { spy, firstAttempt } = spyOnLock((...args) =>
    spy.mock.calls.length === 1
      ? new Promise((_resolve, reject) => {
          unstick = reject;
        })
      : realLock(...args),
  );
  try {
    const stuck = saveAgentHostConnection(record).catch(
      (error: unknown) => error,
    );
    await firstAttempt;
    const queued = removeAgentHostConnection(record).catch(
      (error: unknown) => error,
    );
    // Its own wait, plus the short grace for the writer ahead's last try.
    await vi.advanceTimersByTimeAsync(13_500);
    expect(await queued).toMatchObject({ code: 'ELOCKED' });
    const next = saveAgentHostConnection({ ...record, workspaceId: 'ws_2' });
    const tookLock = await vi
      .waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
        timeout: 300,
        interval: 20,
      })
      .then(
        () => true,
        () => false,
      );
    expect(tookLock).toBe(false);
    unstick(Object.assign(new Error('EIO'), { code: 'EIO' }));
    expect(await stuck).toMatchObject({ code: 'EIO' });
    await next;
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});

it('lets writers in one process take turns instead of racing for the lock', async () => {
  // Two writers behind the same dead lock would reach proper-lockfile's
  // stale takeover together and could both take it. Taking turns, each one
  // finds the lock free and takes it on its first attempt.
  const lockSpy = vi.spyOn(lockfile, 'lock');
  try {
    await Promise.all(
      ['ws_1', 'ws_2', 'ws_3', 'ws_4'].map((workspaceId) =>
        saveAgentHostConnection({ ...record, workspaceId }),
      ),
    );
    expect(lockSpy).toHaveBeenCalledTimes(4);
    expect(
      (await readAgentHostConnections()).map((entry) => entry.workspaceId),
    ).toEqual(['ws_1', 'ws_2', 'ws_3', 'ws_4']);
  } finally {
    lockSpy.mockRestore();
  }
});

it('retries a lock that vanished while it was being taken, and its directory', async () => {
  // Two waiters taking over the same stale lock: one removes the lock the
  // other has just made, and that attempt fails with ENOENT. So does one
  // whose directory went away. Neither is a reason to give up.
  const directory = path.dirname(agentHostConnectionsPath());
  const realLock = lockfile.lock;
  const lockSpy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementationOnce(async (...args) => {
      await fs.rm(directory, { recursive: true, force: true });
      return realLock(...args);
    })
    .mockImplementation(realLock);
  try {
    await saveAgentHostConnection(record);
    expect(lockSpy).toHaveBeenCalledTimes(2);
    expect(await readAgentHostConnections()).toEqual([record]);
  } finally {
    lockSpy.mockRestore();
  }
});

it.each([
  ['win32', 'EPERM', 2],
  ['win32', 'EBUSY', 2],
  ['linux', 'EPERM', 1],
] as const)(
  'retries what a directory being deleted gives on Windows (%s, %s)',
  async (platform, code, attempts) => {
    const realLock = lockfile.lock;
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockRejectedValueOnce(Object.assign(new Error(code), { code }))
      .mockImplementation(realLock);
    try {
      const outcome = await saveAgentHostConnection(record).then(
        () => 'saved',
        (error: { code?: string }) => error.code,
      );
      expect(outcome).toBe(attempts === 2 ? 'saved' : code);
      expect(lockSpy).toHaveBeenCalledTimes(attempts);
    } finally {
      lockSpy.mockRestore();
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  },
);

it('surfaces what still fails at the deadline as it is', async () => {
  // On Windows EPERM is also a lasting "access denied": reported as a busy
  // lock, a disconnect would answer 503 forever and never read the file.
  vi.useFakeTimers();
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const { spy: lockSpy, firstAttempt } = spyOnLock(async () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
    });
  });
  try {
    const startedAt = Date.now();
    const outcome = saveAgentHostConnection(record).catch(
      (error: unknown) => error,
    );
    await firstAttempt;
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({
      code: 'EPERM',
      message: 'EPERM: operation not permitted',
    });
    // Retried all the way, as a directory being deleted can answer it too.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(12_000);
    expect(lockSpy.mock.calls.length).toBeGreaterThan(1);
  } finally {
    lockSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.useRealTimers();
  }
});

/**
 * A spy over the real lock that hands back the options it was given, runs
 * `afterLock` once it holds it, and releases whatever it took.
 */
function spyOnRealLock(afterLock?: (given: lockfile.LockOptions) => void) {
  const realLock = lockfile.lock;
  const options: lockfile.LockOptions[] = [];
  const calledAt: number[] = [];
  const releases: Array<() => Promise<void>> = [];
  const spy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementation(async (file, given) => {
      calledAt.push(Date.now());
      options.push(given!);
      const release = await realLock(file, given);
      releases.push(release);
      afterLock?.(given!);
      return release;
    });
  return {
    options,
    calledAt,
    restore: async () => {
      spy.mockRestore();
      for (const release of releases) await release().catch(() => undefined);
    },
  };
}

const compromise = () =>
  Object.assign(new Error('Unable to update lock within the stale threshold'), {
    code: 'ECOMPROMISED',
  });

it('does not write once another writer has taken its lock over', async () => {
  // A holder that stalled past `stale` (a paused VM, a hung disk) has lost
  // its lock. proper-lockfile's default handler would throw from a timer
  // and take the daemon down; this one only records it, and the write is
  // refused, so it cannot overwrite the record of the writer that took over.
  await saveAgentHostConnection(record);
  const lock = spyOnRealLock((given) => {
    expect(() => given.onCompromised!(compromise())).not.toThrow();
  });
  vi.mocked(fs.writeFile).mockClear();
  try {
    await expect(
      saveAgentHostConnection({ ...record, workspaceId: 'ws_2' }),
    ).rejects.toMatchObject({ code: 'ECOMPROMISED' });
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(await readAgentHostConnections()).toEqual([record]);
  } finally {
    await lock.restore();
  }
});

it('does not rename its write into place when the lock is reported lost after writing it', async () => {
  await saveAgentHostConnection(record);
  const lock = spyOnRealLock();
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    lock.options[0].onCompromised!(compromise());
  });
  try {
    await expect(
      saveAgentHostConnection({ ...record, workspaceId: 'ws_2' }),
    ).rejects.toMatchObject({ code: 'ECOMPROMISED' });
    expect(await readAgentHostConnections()).toEqual([record]);
    // The refused write leaves no temporary file behind.
    const entries = await fs.readdir(path.dirname(agentHostConnectionsPath()));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    // Nor does it remove the lock, which is another writer's now.
    expect(entries).toContain('connections.json.lock');
  } finally {
    await lock.restore();
  }
});

it('does not write after stalling past the hold limit, and still lets go of the lock', async () => {
  // Stalled for 8 s while holding it: another writer may have taken the lock
  // over as stale, so the write is refused. The lock is let go of at once,
  // rather than held up for a waiter in another daemon.
  await saveAgentHostConnection(record);
  const lock = spyOnRealLock();
  const realNow = Date.now;
  const lockDir = `${agentHostConnectionsPath()}.lock`;
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    const later = realNow() + 8000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
  });
  try {
    await expect(
      saveAgentHostConnection({ ...record, workspaceId: 'ws_2' }),
    ).rejects.toMatchObject({ code: 'ECOMPROMISED' });
    expect(await readAgentHostConnections()).toEqual([record]);
    const entries = await fs.readdir(path.dirname(agentHostConnectionsPath()));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(Date.now).mockRestore?.();
    await lock.restore();
  }
});

it('still writes when the write took a while, short of the hold limit', async () => {
  // A slow disk is not a stall: 7 s from the attempt is inside the 8 s limit.
  await saveAgentHostConnection(record);
  const lock = spyOnRealLock();
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    const later = lock.calledAt[0] + 7000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
  });
  try {
    await saveAgentHostConnection({ ...record, workspaceId: 'ws_2' });
    expect(
      (await readAgentHostConnections()).map((entry) => entry.workspaceId),
    ).toEqual(['ws_1', 'ws_2']);
  } finally {
    vi.mocked(Date.now).mockRestore?.();
    await lock.restore();
  }
});

it('counts the hold from the attempt, which is when the lock is dated', async () => {
  // Taking the lock took 5 s, and the write 3.5 s more: 8.5 s since the
  // lock's mtime was set, so the write is refused.
  await saveAgentHostConnection(record);
  const realNow = Date.now;
  const lock = spyOnRealLock(() => {
    const later = realNow() + 5000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
  });
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    const later = realNow() + 8500;
    vi.mocked(Date.now).mockImplementation(() => later);
  });
  try {
    await expect(
      saveAgentHostConnection({ ...record, workspaceId: 'ws_2' }),
    ).rejects.toMatchObject({ code: 'ECOMPROMISED' });
  } finally {
    vi.mocked(Date.now).mockRestore?.();
    await lock.restore();
  }
});

it('does not replace a file that a newer version wrote', async () => {
  // Its records are unknown here; a newer daemon on this machine still
  // needs them.
  await fs.mkdir(path.dirname(agentHostConnectionsPath()), { recursive: true });
  const newer = JSON.stringify({ schemaVersion: 2, hosts: [{ id: 'x' }] });
  await fs.writeFile(agentHostConnectionsPath(), newer);
  await expect(saveAgentHostConnection(record)).rejects.toMatchObject({
    code: 'ENEWERSCHEMA',
    message: expect.stringMatching(/newer version of Qwen Code \(schema 2\)/),
  });
  expect(await fs.readFile(agentHostConnectionsPath(), 'utf8')).toBe(newer);
});

it('refuses to write over a file it cannot read right now', async () => {
  // A transient EMFILE or EIO is not an empty file: writing would replace
  // every other saved connection with this one.
  await saveAgentHostConnection(record);
  vi.mocked(fs.readFile).mockRejectedValueOnce(
    Object.assign(new Error('EMFILE: too many open files'), {
      code: 'EMFILE',
    }),
  );
  await expect(
    saveAgentHostConnection({ ...record, workspaceId: 'ws_2' }),
  ).rejects.toMatchObject({ code: 'EMFILE' });
  expect(await readAgentHostConnections()).toEqual([record]);
});

it('replaces a corrupt file, which holds nothing the restore loop would use', async () => {
  await fs.mkdir(path.dirname(agentHostConnectionsPath()), { recursive: true });
  await fs.writeFile(agentHostConnectionsPath(), '{not json');
  await saveAgentHostConnection(record);
  expect(await readAgentHostConnections()).toEqual([record]);
});

// POSIX only: what rmdir reports for a regular file is platform-specific.
it.skipIf(process.platform === 'win32')(
  'fails at once when waiting cannot help',
  async () => {
    // A regular file where the lock directory goes cannot be removed as a
    // stale lock (ENOTDIR), however long the writer waits; nor does a
    // read-only or full disk clear in seconds.
    await fs.mkdir(path.dirname(agentHostConnectionsPath()), {
      recursive: true,
    });
    const lockPath = `${agentHostConnectionsPath()}.lock`;
    await fs.writeFile(lockPath, '');
    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, longAgo, longAgo);
    const lockSpy = vi.spyOn(lockfile, 'lock');
    try {
      const startedAt = Date.now();
      await expect(saveAgentHostConnection(record)).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      // Well short of any retry budget.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(lockSpy.mock.calls[0][1]).not.toHaveProperty('retries');
    } finally {
      lockSpy.mockRestore();
    }
  },
);

function runtime(workspaceCwd: string) {
  return {
    bridge: { workspaceCwd } as unknown as AcpSessionBridge,
    workspaceCwd,
    generationGuard: createWorkspaceGenerationGuard(),
  };
}

/** Runs a restore and stops its loops afterwards. */
async function restoring(
  runtimeFor: (workspaceCwd: string) => AgentHostRestoreRuntime | undefined,
  body: () => Promise<void>,
) {
  const stop = new AbortController();
  try {
    await restoreAgentHostConnections({
      runtimeFor,
      signal: stop.signal,
      retryMs: 10,
      watchMs: 10,
    });
    await body();
  } finally {
    stop.abort();
  }
}

it('restores the connections of every trusted workspace and prunes one without a credential', async () => {
  await saveAgentHostConnection(record);
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_revoked' });
  await saveAgentHostConnection({ ...record, workspaceCwd: '/elsewhere' });
  await saveAgentHostConnection({ ...record, workspaceCwd: '/untrusted' });
  hasCredential.mockImplementation(
    async (target) =>
      (target as { workspaceId: string }).workspaceId !== 'ws_revoked',
  );
  startConnection.mockResolvedValue(undefined);
  isRunning.mockReturnValue(true);
  const work = runtime('/work');
  const elsewhere = runtime('/elsewhere');

  await restoring(
    (cwd) =>
      cwd === '/work' ? work : cwd === '/elsewhere' ? elsewhere : undefined,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
      expect(startConnection).toHaveBeenCalledWith({
        ...record,
        bridge: work.bridge,
        generationGuard: work.generationGuard,
      });
      expect(startConnection).toHaveBeenCalledWith({
        ...record,
        workspaceCwd: '/elsewhere',
        bridge: elsewhere.bridge,
        generationGuard: elsewhere.generationGuard,
      });
      await vi.waitFor(async () =>
        expect(
          (await readAgentHostConnections()).map((entry) => entry.workspaceId),
        ).not.toContain('ws_revoked'),
      );
      // Still waiting for the untrusted one; never connected.
      expect(
        startConnection.mock.calls.some(
          ([target]) =>
            (target as { workspaceCwd: string }).workspaceCwd === '/untrusted',
        ),
      ).toBe(false);
    },
  );
});

it('keeps a connection whose credential cannot be read', async () => {
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_unreadable' });
  hasCredential.mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    (cwd) => (cwd === '/work' ? work : undefined),
    async () => {
      await vi.waitFor(() => expect(hasCredential).toHaveBeenCalled());
      expect(
        (await readAgentHostConnections()).map((entry) => entry.workspaceId),
      ).toContain('ws_unreadable');
      expect(startConnection).not.toHaveBeenCalled();
    },
  );
});

it('retries a coordinator that is down at boot', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    () => work,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
    },
  );
});

it('connects a workspace that becomes available after boot', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  let available: AgentHostRestoreRuntime | undefined;

  await restoring(
    () => available,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(startConnection).not.toHaveBeenCalled();
      available = runtime('/work');
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledOnce());
    },
  );
});

it('supervises a connection saved after boot', async () => {
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    () => work,
    async () => {
      // `qwen agents join` against the running daemon saves the record later.
      await saveAgentHostConnection(record);
      await vi.waitFor(() =>
        expect(startConnection).toHaveBeenCalledWith({
          ...record,
          bridge: work.bridge,
          generationGuard: work.generationGuard,
        }),
      );
    },
  );
});

it('reconnects on the new runtime when the old one is replaced, and lets a removed record go', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  let current = runtime('/work');
  const first = current;

  await restoring(
    () => current,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledOnce());
      current = runtime('/work');
      first.generationGuard.close();
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
      expect(startConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({ bridge: current.bridge }),
      );

      // `DELETE hosts/connect` forgets it; a stopped connection stays down.
      await removeAgentHostConnection(record);
      isRunning.mockReturnValue(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(startConnection).toHaveBeenCalledTimes(2);
    },
  );
});
