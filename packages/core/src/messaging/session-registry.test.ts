/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { toUdsAddress } from './peer-address.js';
import {
  PEER_PROTOCOL_VERSION,
  _resetSessionRegistryStateForTest,
  getSessionRegistryDir,
  getSessionRegistryPath,
  getSessionRegistryRefreshFailures,
  isKnownPeerAddress,
  isProcessAlive,
  listLivePeerSessions,
  probeSocket,
  readSessionRegistry,
  refreshSessionRegistryEntry,
  removeSessionRegistryEntry,
  writeSessionRegistryEntry,
  type SessionRegistryEntry,
} from './session-registry.js';

// Pass-through, so the registry still reads a real directory; the spy is how
// a test counts reads.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let configHome: string;
let socketDir: string;
const servers: net.Server[] = [];

function entry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    pid: process.pid,
    procStart: Date.now() - 1000,
    startedAt: Date.now(),
    cwd: '/tmp/project',
    sessionId: 'session-1',
    kind: 'interactive',
    status: 'idle',
    messagingSocketPath: '',
    peerProtocol: PEER_PROTOCOL_VERSION,
    ...overrides,
  };
}

/** Binds a real listening socket so probes have something to find. */
async function listen(name: string): Promise<string> {
  const socketPath = path.join(socketDir, name);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  server.unref();
  servers.push(server);
  return socketPath;
}

async function writeRaw(fileName: string, contents: string): Promise<string> {
  const file = path.join(getSessionRegistryDir(), fileName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the published entry satisfies `predicate`.
 *
 * Refresh is fire-and-forget behind a coalescing timer, so there is nothing to
 * await. Polling the artefact peers actually read is both the honest assertion
 * and the only one available.
 */
async function waitForEntry(
  predicate: (row: SessionRegistryEntry | undefined) => boolean,
  timeoutMs = 2000,
): Promise<SessionRegistryEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await readSessionRegistry())[0];
    if (predicate(row)) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for registry entry; last saw ${JSON.stringify(row)}`,
      );
    }
    await sleep(10);
  }
}

describe('session registry', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-registry-'));
    configHome = path.join(root, 'config');
    socketDir = path.join(root, 'socks');
    await fs.mkdir(configHome, { recursive: true });
    await fs.mkdir(socketDir, { recursive: true });
    setConfigHomeDirOverride(configHome);
    _resetSessionRegistryStateForTest();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    _resetSessionRegistryStateForTest();
    setConfigHomeDirOverride(undefined);
    await fs.rm(path.dirname(configHome), { recursive: true, force: true });
  });

  it('writes and reads back an entry', async () => {
    const written = entry({ messagingSocketPath: '/tmp/a.sock' });
    expect(await writeSessionRegistryEntry(written)).toBe(true);

    const rows = await readSessionRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: written.pid,
      cwd: '/tmp/project',
      messagingSocketPath: '/tmp/a.sock',
      kind: 'interactive',
      status: 'idle',
    });
  });

  it('removes an entry', async () => {
    await writeSessionRegistryEntry(entry());
    await removeSessionRegistryEntry();
    expect(await readSessionRegistry()).toHaveLength(0);
  });

  it('returns empty when the directory is absent', async () => {
    expect(await readSessionRegistry()).toHaveLength(0);
  });

  /**
   * The weakest useful check, offered as exactly that: there is no
   * kernel-verified sender identity, so this only separates "a peer this machine
   * has a record of" from "a string someone supplied".
   */
  describe('isKnownPeerAddress', () => {
    it('matches a registry row by socket path', async () => {
      await writeSessionRegistryEntry(
        entry({ messagingSocketPath: '/tmp/peer.sock' }),
      );
      expect(await isKnownPeerAddress('uds:/tmp/peer.sock')).toBe(true);
    });

    it('rejects an address with no registry row', async () => {
      await writeSessionRegistryEntry(
        entry({ messagingSocketPath: '/tmp/peer.sock' }),
      );
      expect(await isKnownPeerAddress('uds:/tmp/ghost.sock')).toBe(false);
    });

    it('rejects a non-uds address', async () => {
      expect(await isKnownPeerAddress('bridge:whatever')).toBe(false);
    });

    it('reads the percent-encoded wire form', async () => {
      const socketPath = '/tmp/test socks/1.sock';
      await writeSessionRegistryEntry(
        entry({ messagingSocketPath: socketPath }),
      );
      expect(await isKnownPeerAddress(toUdsAddress(socketPath))).toBe(true);
    });

    it('returns false when nothing is published', async () => {
      expect(await isKnownPeerAddress('uds:/tmp/peer.sock')).toBe(false);
    });

    // Every inbound message asks this, including one about to be refused, so the
    // answer comes from a snapshot rather than a readdir per message. The cost is
    // bounded staleness, which is the point being asserted here.
    describe('snapshot lifetime', () => {
      beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
      afterEach(() => vi.useRealTimers());

      it('answers from a snapshot until it is invalidated', async () => {
        expect(await isKnownPeerAddress('uds:/tmp/late.sock')).toBe(false);

        await writeSessionRegistryEntry(
          entry({ messagingSocketPath: '/tmp/late.sock' }),
        );
        expect(await isKnownPeerAddress('uds:/tmp/late.sock')).toBe(false);

        _resetSessionRegistryStateForTest();
        expect(await isKnownPeerAddress('uds:/tmp/late.sock')).toBe(true);
      });

      // A miss now holds the message for review, so a peer that registered just
      // after our snapshot gets a second look once the snapshot is not brand new.
      it('re-reads on a miss once the snapshot is a quarter-second old', async () => {
        expect(await isKnownPeerAddress('uds:/tmp/late.sock')).toBe(false);
        await writeSessionRegistryEntry(
          entry({ messagingSocketPath: '/tmp/late.sock' }),
        );

        vi.advanceTimersByTime(250);
        expect(await isKnownPeerAddress('uds:/tmp/late.sock')).toBe(true);
      });

      it('shares one read between concurrent misses', async () => {
        await writeSessionRegistryEntry(
          entry({ messagingSocketPath: '/tmp/peer.sock' }),
        );
        expect(await isKnownPeerAddress('uds:/tmp/peer.sock')).toBe(true);
        vi.advanceTimersByTime(300);

        const readdir = vi.mocked(fs.readdir);
        readdir.mockClear();
        const answers = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            isKnownPeerAddress(`uds:/tmp/ghost-${i}.sock`),
          ),
        );

        expect(answers).toEqual(Array(10).fill(false));
        expect(readdir).toHaveBeenCalledTimes(1);
      });

      it('keeps a positive answer cached', async () => {
        await writeSessionRegistryEntry(
          entry({ messagingSocketPath: '/tmp/peer.sock' }),
        );
        expect(await isKnownPeerAddress('uds:/tmp/peer.sock')).toBe(true);
        vi.advanceTimersByTime(500);

        const readdir = vi.mocked(fs.readdir);
        readdir.mockClear();
        expect(await isKnownPeerAddress('uds:/tmp/peer.sock')).toBe(true);
        expect(readdir).not.toHaveBeenCalled();
      });
    });
  });

  describe('sanitization', () => {
    it('deletes files whose name is not exactly <pid>.json', async () => {
      const file = await writeRaw('007.json', JSON.stringify(entry()));
      await readSessionRegistry();
      await expect(fs.stat(file)).rejects.toThrow();
    });

    it('skips unparseable JSON', async () => {
      await writeRaw('4242.json', 'not json');
      expect(await readSessionRegistry()).toHaveLength(0);
    });

    it('rejects a non-absolute socket path', async () => {
      await writeRaw(
        '4243.json',
        JSON.stringify({ ...entry(), messagingSocketPath: 'relative.sock' }),
      );
      expect((await readSessionRegistry())[0]?.messagingSocketPath).toBe('');
    });

    it('drops out-of-range timestamps and unknown enum values', async () => {
      await writeRaw(
        '4244.json',
        JSON.stringify({
          ...entry(),
          startedAt: 9e15,
          kind: 'root',
          status: 'compromised',
        }),
      );
      const row = (await readSessionRegistry())[0];
      expect(row?.startedAt).toBe(0);
      expect(row?.kind).toBeUndefined();
      expect(row?.status).toBeUndefined();
    });

    it('ignores a file above the size cap', async () => {
      await writeRaw(
        '4245.json',
        JSON.stringify({ ...entry(), cwd: 'x'.repeat(300 * 1024) }),
      );
      expect(await readSessionRegistry()).toHaveLength(0);
    });
  });

  describe('probeSocket', () => {
    it('finds a listening socket', async () => {
      expect(await probeSocket(await listen('live.sock'))).toBe(true);
    });

    it('rejects a path with no listener', async () => {
      expect(await probeSocket(path.join(socketDir, 'missing.sock'))).toBe(false);
    });

    it('rejects a non-local path', async () => {
      expect(await probeSocket('relative.sock')).toBe(false);
    });
  });

  describe('listLivePeerSessions', () => {
    it('lists every reachable session that is not this process', async () => {
      // Both rows survive. The second one stands for the session that spawned
      // us: its path arrives in an inherited ENV_MESSAGING_SOCKET, and passing
      // that in as "our own socket" is what used to take a child's own parent
      // out of the listing it was about to address.
      const peerSocket = await listen('peer.sock');
      const parentSocket = await listen('parent.sock');
      await writeRaw(
        '4321.json',
        JSON.stringify(entry({ pid: 4321, messagingSocketPath: peerSocket })),
      );
      await writeRaw(
        '4322.json',
        JSON.stringify(entry({ pid: 4322, messagingSocketPath: parentSocket })),
      );

      const live = await listLivePeerSessions();
      expect(live.map((session) => session.messagingSocketPath).sort()).toEqual(
        [peerSocket, parentSocket].sort(),
      );
    });

    it('excludes an entry for this process', async () => {
      const socketPath = await listen('self.sock');
      await writeSessionRegistryEntry(entry({ messagingSocketPath: socketPath }));
      expect(await listLivePeerSessions()).toHaveLength(0);
    });

    it('collects the file of a dead unreachable session', async () => {
      // pid 1 exists; use an implausible pid so the reaper sees it as dead.
      const file = await writeRaw(
        '999999.json',
        JSON.stringify(
          entry({ pid: 999999, messagingSocketPath: '/tmp/gone.sock' }),
        ),
      );
      await listLivePeerSessions();
      await expect(fs.stat(file)).rejects.toThrow();
    });

    it('keeps the file of a live but unreachable session', async () => {
      const file = await writeRaw(
        `${process.pid + 0}.json`,
        JSON.stringify(
          entry({ pid: process.pid, messagingSocketPath: '/tmp/gone.sock' }),
        ),
      );
      await listLivePeerSessions();
      await expect(fs.stat(file)).resolves.toBeDefined();
    });

    it('skips entries with no socket', async () => {
      await writeRaw('4444.json', JSON.stringify(entry({ pid: 4444 })));
      expect(await listLivePeerSessions()).toHaveLength(0);
    });
  });

  describe('isProcessAlive', () => {
    it('recognises this process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('rejects invalid pids', () => {
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
    });
  });

  it('derives the registry path from the config home', () => {
    expect(getSessionRegistryPath(77)).toBe(
      path.join(configHome, 'sessions', '77.json'),
    );
  });

  describe('refreshSessionRegistryEntry', () => {
    it('[AC1] republishes a changed name without a second full write', async () => {
      await writeSessionRegistryEntry(entry({ name: 'before' }));
      refreshSessionRegistryEntry({ name: 'after' });

      const row = await waitForEntry((r) => r?.name === 'after');
      expect(row?.name).toBe('after');
    });

    it('replaces the session id and clears the previous name together', async () => {
      await writeSessionRegistryEntry(
        entry({ sessionId: 'old-session', name: 'old-name' }),
      );
      refreshSessionRegistryEntry({
        sessionId: 'new-session',
        name: undefined,
      });

      const row = await waitForEntry(
        (current) => current?.sessionId === 'new-session',
      );
      expect(row?.name).toBeUndefined();
    });

    it('[AC3] preserves startedAt, procStart and pid', async () => {
      const original = entry({ name: 'before' });
      await writeSessionRegistryEntry(original);
      refreshSessionRegistryEntry({ name: 'after' });

      const row = await waitForEntry((r) => r?.name === 'after');
      expect(row?.startedAt).toBe(original.startedAt);
      expect(row?.procStart).toBe(original.procStart);
      expect(row?.pid).toBe(original.pid);
    });

    it('[AC3] ignores immutable fields even when a caller forces them', async () => {
      const original = entry({ name: 'before' });
      await writeSessionRegistryEntry(original);
      refreshSessionRegistryEntry({
        name: 'after',
        startedAt: 1,
        procStart: 2,
      } as Partial<SessionRegistryEntry>);

      const row = await waitForEntry((r) => r?.name === 'after');
      expect(row?.startedAt).toBe(original.startedAt);
      expect(row?.procStart).toBe(original.procStart);
    });

    it('[AC4] writes nothing when no entry was ever published', async () => {
      refreshSessionRegistryEntry({ name: 'ghost' });
      await sleep(400);
      expect(await readSessionRegistry()).toHaveLength(0);
    });

    it('[AC4] writes nothing after a failed publish', async () => {
      // An entry whose directory cannot be created never becomes published, so
      // a later refresh has no base to merge onto.
      const blocked = path.join(configHome, 'sessions');
      await fs.writeFile(blocked, 'not a directory');
      expect(await writeSessionRegistryEntry(entry())).toBe(false);

      refreshSessionRegistryEntry({ name: 'ghost' });
      await sleep(400);
      await fs.rm(blocked, { force: true });
      expect(await readSessionRegistry()).toHaveLength(0);
    });

    it('[AC6] does not write when the merged entry is unchanged', async () => {
      await writeSessionRegistryEntry(entry({ name: 'stable', status: 'idle' }));
      const before = await fs.stat(getSessionRegistryPath());

      refreshSessionRegistryEntry({ name: 'stable' });
      refreshSessionRegistryEntry({ status: 'idle' });
      await sleep(400);

      const after = await fs.stat(getSessionRegistryPath());
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it('[AC6] drops a queued change that is reverted inside the window', async () => {
      await writeSessionRegistryEntry(entry({ status: 'idle' }));
      const before = await fs.stat(getSessionRegistryPath());

      refreshSessionRegistryEntry({ status: 'busy' });
      refreshSessionRegistryEntry({ status: 'idle' });
      await sleep(400);

      const after = await fs.stat(getSessionRegistryPath());
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it('[decision 6] forces a write when changes never stop arriving', async () => {
      await writeSessionRegistryEntry(entry({ status: 'idle' }));

      // Faster than the 250ms coalesce window, so a plain trailing debounce
      // would never fire; the 2s maximum wait is what makes this terminate.
      const statuses = ['busy', 'waiting', 'shell'] as const;
      let index = 0;
      const flapping = setInterval(() => {
        refreshSessionRegistryEntry({ status: statuses[index++ % 3] });
      }, 50);

      try {
        const row = await waitForEntry((r) => r?.status !== 'idle', 4000);
        expect(row?.status).toBeDefined();
      } finally {
        clearInterval(flapping);
      }
    });

    it('[AC7] a pending refresh cannot outlive teardown', async () => {
      await writeSessionRegistryEntry(entry({ name: 'before' }));
      refreshSessionRegistryEntry({ name: 'after' });
      await removeSessionRegistryEntry();

      await sleep(400);
      expect(await readSessionRegistry()).toHaveLength(0);
    });

    it('[AC9] concurrent writes all succeed, and the last one issued wins', async () => {
      // Every write in this process shares one temp path, so these race each
      // other directly: unserialized, they truncate each other's bytes and all
      // but one rename fails ENOENT. Refresh coalesces, so it is this primitive
      // — not a burst of refreshes — that has to hold the line.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeSessionRegistryEntry(entry({ name: `n${i}`, sessionId: `s${i}` })),
        ),
      );

      expect(results.every(Boolean)).toBe(true);
      const row = (await readSessionRegistry())[0];
      expect(row?.name).toBe('n19');
      expect(row?.sessionId).toBe('s19');
    });

    it('[AC9] a refresh flushed onto an in-flight write is not lost', async () => {
      await writeSessionRegistryEntry(entry({ name: 'first' }));

      // Queue a second full publish and a refresh in the same tick. The refresh
      // merges onto whatever is published when it flushes, and must not be
      // overtaken by the write it was issued after.
      const publish = writeSessionRegistryEntry(
        entry({ name: 'second', status: 'busy' }),
      );
      refreshSessionRegistryEntry({ name: 'third' });
      await publish;

      const row = await waitForEntry((r) => r?.name === 'third');
      expect(row?.name).toBe('third');
      expect(getSessionRegistryRefreshFailures()).toBe(0);
    });
  });
});
