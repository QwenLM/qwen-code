/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Regression tests for #10208 — failed concurrent spawn
 * can persist a ghost member in config.json — and for the #10297
 * commit-aware failed-spawn compensating-write gate.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TeamFile } from './types.js';
import { formatAgentId, readTeamFile } from './teamHelpers.js';
import * as teamHelpers from './teamHelpers.js';
import { TeamCoordinationHarness } from './test-utils/coordination-harness.js';
import type { FakeBackend } from './test-utils/fake-backend.js';
import { Storage } from '../../config/storage.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Gates teammate spawns behind per-agent promises while each agent still
 * registers synchronously in the backend map. This is the suite's most
 * delicate contract: `FakeBackend.spawnAgent` creates the FakeAgent before
 * its first await, which keeps these races deterministic. Calling the
 * original fire-and-forget keeps that registration (`getAgentFromBackend`
 * finds the handle while the spawn is gated); returning the gate lets each
 * test choose when the gated `spawnTeammate` continues past its await.
 * Ungated agents throw, or with `passthroughUnknown` spawn normally.
 */
function gateSpawns(
  backend: FakeBackend,
  gates: Map<string, Promise<void>>,
  options?: { passthroughUnknown?: boolean },
): void {
  const originalSpawnAgent = backend.spawnAgent.bind(backend);
  backend.spawnAgent = (config) => {
    const gate = gates.get(config.agentId);
    if (gate) {
      void originalSpawnAgent(config);
      return gate;
    }
    if (options?.passthroughUnknown) {
      return originalSpawnAgent(config);
    }
    throw new Error(`Unexpected agent: ${config.agentId}`);
  };
}

const spawn = (h: TeamCoordinationHarness, name: string) =>
  h.teamManager.spawnTeammate({ name, cwd: h.tmpDir });

/** Lets gated spawnAgent calls start (agents created in the backend map). */
const letSpawnsStart = () => new Promise((r) => setTimeout(r, 50));

const enospc = () => new Error('ENOSPC: no space left on device');

/** Gates alpha's and beta's spawns (see gateSpawns) behind fresh deferreds. */
function gateAlphaBeta(
  h: TeamCoordinationHarness,
  options?: { passthroughUnknown?: boolean },
) {
  const deferredA = createDeferred<void>();
  const deferredB = createDeferred<void>();
  gateSpawns(
    h.backend,
    new Map([
      [formatAgentId('alpha', h.teamName), deferredA.promise],
      [formatAgentId('beta', h.teamName), deferredB.promise],
    ]),
    options,
  );
  return { deferredA, deferredB };
}

/**
 * Spies on writeTeamFile and holds the first roster write until `release()`.
 * The held write then persists a `snapshot` taken when it started, persists
 * the `live` roster it was handed (serialized only after the await, like the
 * real writer after `await fs.mkdir`), or `reject`s with ENOSPC. Later
 * writes go straight through.
 */
function holdFirstWrite(mode: 'snapshot' | 'live' | 'reject') {
  const realWriteTeamFile = teamHelpers.writeTeamFile;
  let writeCalls = 0;
  let release!: () => void;
  const firstWriteGate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(teamHelpers, 'writeTeamFile').mockImplementation(
    async (name, tf) => {
      writeCalls++;
      if (writeCalls === 1) {
        const held: TeamFile =
          mode === 'snapshot' ? JSON.parse(JSON.stringify(tf)) : tf;
        await firstWriteGate;
        if (mode === 'reject') throw enospc();
        return realWriteTeamFile(name, held);
      }
      return realWriteTeamFile(name, tf);
    },
  );
  return { writeCalls: () => writeCalls, release };
}

/** Reads config.json, asserting it exists; returns it and its member names. */
async function readPersisted(h: TeamCoordinationHarness) {
  const persisted = await readTeamFile(h.teamName);
  expect(persisted).toBeDefined();
  return {
    persisted: persisted!,
    names: persisted!.members.map((m) => m.name),
  };
}

const inMemoryNames = (h: TeamCoordinationHarness) =>
  (h.teamManager as unknown as { teamFile: TeamFile }).teamFile.members.map(
    (m) => m.name,
  );

let harness: TeamCoordinationHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  vi.restoreAllMocks();
});

async function createHarness(): Promise<TeamCoordinationHarness> {
  const h = await TeamCoordinationHarness.create();
  setMockDir(h.tmpDir);
  harness = h;
  return h;
}

describe('TeamManager ghost member regression (#10208)', () => {
  it('does not persist a failed concurrent spawn in config.json', async () => {
    const h = await createHarness();

    // Controlled spawn: gate each agent's promise while the agent
    // still registers synchronously in the backend map (gateSpawns).
    const { deferredA, deferredB } = gateAlphaBeta(h);

    // Start two concurrent spawns.
    const spawnA = spawn(h, 'alpha');
    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // A succeeds → continues to writeTeamFile (serializes both A and B).
    deferredA.resolve();
    await spawnA;

    // B fails → rollback removes B from memory; the compensating write
    // re-persists the roster without B.
    deferredB.reject(new Error('spawn failed'));
    await expect(spawnB).rejects.toThrow('spawn failed');

    const { names } = await readPersisted(h);
    expect(names).toContain('alpha');
    // Bug: B should NOT be in the persisted file after failed spawn.
    expect(names).not.toContain('beta');
  });

  it('preserves both members when concurrent spawns both succeed', async () => {
    const h = await createHarness();

    // Both spawns succeed concurrently.
    await Promise.all([spawn(h, 'alpha'), spawn(h, 'beta')]);

    const { persisted, names } = await readPersisted(h);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(persisted.members).toHaveLength(2);
  });

  it('keeps the roster ghost-free when a slow success write lands last (write serialization)', async () => {
    const h = await createHarness();
    const { deferredA, deferredB } = gateAlphaBeta(h);

    // Hold A's roster write after it snapshots the roster. The real write
    // serializes synchronously when it starts, so the snapshot is
    // [alpha, beta] while beta is still pending; the rename lands only
    // when the gate opens. Without serialized writes the compensating
    // write commits [alpha] first and this stale snapshot lands last,
    // re-persisting ghost beta (#10208 symptom).
    const write = holdFirstWrite('snapshot');

    const spawnA = spawn(h, 'alpha');
    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // A succeeds and its roster write starts (held at the gate).
    deferredA.resolve();
    await vi.waitFor(() => expect(write.writeCalls()).toBe(1));

    // B fails while A's stale write is still in flight; rollback removes
    // B from memory and queues the compensating write.
    deferredB.reject(new Error('spawn failed'));

    // Release A's stale write; the compensating write must land after it
    // with the post-rollback state.
    write.release();
    await spawnA;
    await expect(spawnB).rejects.toThrow('spawn failed');
    expect(write.writeCalls()).toBe(2);

    const { names } = await readPersisted(h);
    expect(names).toContain('alpha');
    expect(names).not.toContain('beta');
  });

  it('still rejects with the original spawn error when the compensating write fails', async () => {
    const h = await createHarness();

    // Gate alpha and beta; later agents (gamma) pass through to the
    // original backend spawn.
    const { deferredA, deferredB } = gateAlphaBeta(h, {
      passthroughUnknown: true,
    });

    // Start both spawns so beta is already in the live roster when
    // alpha's success write runs — that write persists beta, which is
    // what makes beta's compensating write necessary (the gate must
    // let it through).
    const spawnA = spawn(h, 'alpha');
    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // A succeeds; its success write lands before we arm the spy.
    deferredA.resolve();
    await spawnA;

    // Witness for the leader notification (see below).
    const leaderSpy = vi.fn();
    h.teamManager.setLeaderMessageCallback(leaderSpy);

    // Make the next roster write (B's compensating write) fail.
    const writeSpy = vi
      .spyOn(teamHelpers, 'writeTeamFile')
      .mockRejectedValueOnce(enospc());

    deferredB.reject(new Error('spawn failed'));

    // The compensating write failure must not mask the spawn error...
    await expect(spawnB).rejects.toThrow('spawn failed');
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // ...and beta must be rolled back from the in-memory roster.
    expect(inMemoryNames(h)).toContain('alpha');
    expect(inMemoryNames(h)).not.toContain('beta');

    // The failure must also be surfaced to the leader — a debug-only
    // trail is invisible in production.
    const notice = leaderSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('Compensating team-file write'),
    );
    expect(notice).toBeDefined();
    expect(notice![0]).toContain('<team_error>');
    expect(notice![0]).toContain(formatAgentId('beta', h.teamName));

    // A rejected write must not poison the write queue: a subsequent
    // normal spawn has to land its roster write on disk.
    await spawn(h, 'gamma');

    const { names } = await readPersisted(h);
    expect(names).toContain('alpha');
    expect(names).toContain('gamma');
    expect(names).not.toContain('beta');
  });

  it('does not persist in-flight siblings when the failed spawn is the first write (compensating-write gate)', async () => {
    const h = await createHarness();
    const { deferredA, deferredB } = gateAlphaBeta(h);

    // Watch roster writes: when no earlier write could have persisted
    // the failed member, the compensating write must not run at all.
    const writeSpy = vi.spyOn(teamHelpers, 'writeTeamFile');

    // Start two concurrent spawns; both members are pushed to the live
    // roster while both spawnAgent calls are still gated.
    const spawnA = spawn(h, 'alpha');
    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // Alpha fails BEFORE any roster write has started. The compensating
    // write must be skipped: it would serialize the live roster and
    // persist beta, whose spawn is still pending — a ghost member if
    // the process exits before beta resolves (#10208 symptom).
    deferredA.reject(new Error('spawn failed'));
    await expect(spawnA).rejects.toThrow('spawn failed');
    expect(writeSpy).not.toHaveBeenCalled();

    const { persisted, names } = await readPersisted(h);
    expect(names).not.toContain('alpha');
    expect(names).not.toContain('beta');
    expect(persisted.members).toHaveLength(0);

    // The gate must not break the normal path: beta then succeeds and
    // its own success write persists the roster.
    deferredB.resolve();
    await spawnB;
    expect((await readPersisted(h)).names).toEqual(['beta']);
  });

  it('excludes members pushed during the fs-await window of a held write (snapshot at counted point)', async () => {
    const h = await createHarness();
    const { deferredA, deferredB } = gateAlphaBeta(h);

    // Mirror the real `writeTeamFile` order (await fs.mkdir, then
    // stringify). If the queued task handed the writer the live roster
    // instead of a snapshot taken synchronously at the counted start, the
    // member pushed during the held await would be persisted by a write
    // the gate counts as pre-push, and its compensating write would be
    // skipped — re-persisting the ghost #10208 removes.
    const write = holdFirstWrite('live');

    const spawnA = spawn(h, 'alpha');
    await letSpawnsStart();

    // Alpha succeeds; its roster write starts (counter 0->1) and hangs
    // in the mocked fs await. Only now is beta pushed, capturing
    // writesStartedAtPush = 1.
    deferredA.resolve();
    await vi.waitFor(() => expect(write.writeCalls()).toBe(1));

    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // Release alpha's write: serialization happens now. Beta's spawn
    // then fails; the gate sees no write started after beta's push and
    // skips the compensating write — correct only if alpha's write did
    // not serialize beta.
    write.release();
    await spawnA;

    deferredB.reject(new Error('spawn failed'));
    await expect(spawnB).rejects.toThrow('spawn failed');
    expect(write.writeCalls()).toBe(1);

    const { names } = await readPersisted(h);
    expect(names).toContain('alpha');
    expect(names).not.toContain('beta');

    expect(inMemoryNames(h)).toEqual(['alpha']);
  });

  it('still rejects with the original spawn error when the compensating-write failure notice throws', async () => {
    const h = await createHarness();
    const { deferredA, deferredB } = gateAlphaBeta(h, {
      passthroughUnknown: true,
    });

    // Start both spawns so beta is already in the live roster when
    // alpha's success write lands — that write is what gates beta's
    // compensating write in.
    const spawnA = spawn(h, 'alpha');
    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // A succeeds; its success write lands before we arm the spy.
    deferredA.resolve();
    await spawnA;

    // The leader notification for a failed compensating write sits in an
    // inner try/catch: if the callback throws, the original spawn error
    // must stay the rejection reason instead of being masked.
    const leaderSpy = vi.fn().mockImplementation(() => {
      throw new Error('cb boom');
    });
    h.teamManager.setLeaderMessageCallback(leaderSpy);

    // Make the next roster write (beta's compensating write) fail.
    vi.spyOn(teamHelpers, 'writeTeamFile').mockRejectedValueOnce(enospc());

    deferredB.reject(new Error('spawn failed'));

    await expect(spawnB).rejects.toThrow('spawn failed');
    // The throwing notification was attempted exactly once.
    expect(leaderSpy).toHaveBeenCalledTimes(1);

    expect(inMemoryNames(h)).toContain('alpha');
    expect(inMemoryNames(h)).not.toContain('beta');
  });
});

describe('TeamManager commit-aware compensating-write gate (#10297)', () => {
  it('skips the compensating write when the only write in the window rejected (solo)', async () => {
    const h = await createHarness();

    const leaderSpy = vi.fn();
    h.teamManager.setLeaderMessageCallback(leaderSpy);

    // Disk full: the member's own roster write rejects, and a
    // compensating write attempted while the disk is still full would
    // reject too.
    const writeSpy = vi
      .spyOn(teamHelpers, 'writeTeamFile')
      .mockRejectedValueOnce(enospc())
      .mockRejectedValueOnce(enospc());

    await expect(spawn(h, 'alpha')).rejects.toThrow('ENOSPC');

    // The only write that ran in the member's window rejected and
    // persisted nothing, so there is nothing to compensate: exactly one
    // write attempt...
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // ...and no ghost-member notice reaches the leader on top of the
    // spawn error that already carries the real cause (disk full).
    expect(leaderSpy).not.toHaveBeenCalled();

    // The member is rolled back in memory and nothing reached the disk.
    expect(inMemoryNames(h)).toHaveLength(0);
    const { persisted } = await readPersisted(h);
    expect(persisted.members).toHaveLength(0);
  });

  it('still repairs a member persisted by a committed window write (five-step interleaving)', async () => {
    // The issue's counterexample to decrement-on-reject:
    // 1. alpha's write starts (snapshot taken) and hangs in an fs await;
    // 2. beta is pushed while it is in flight;
    // 3. alpha's write rejects — a decrement would drop the counter
    //    back to beta's push watermark;
    // 4. gamma's write starts, reusing that counter value, and commits
    //    a snapshot that still contains beta;
    // 5. beta's spawn fails — the gate must still fire the repair,
    //    or gamma's committed write leaves ghost beta on disk (#10208).
    const h = await createHarness();
    const { deferredA, deferredB } = gateAlphaBeta(h, {
      passthroughUnknown: true,
    });
    const write = holdFirstWrite('reject');

    const spawnA = spawn(h, 'alpha');
    await letSpawnsStart();

    // Alpha succeeds; its write starts and hangs, then beta is pushed
    // while it is in flight.
    deferredA.resolve();
    await vi.waitFor(() => expect(write.writeCalls()).toBe(1));

    const spawnB = spawn(h, 'beta');
    await letSpawnsStart();

    // Alpha's write rejects; alpha rolls back. Nothing has committed.
    write.release();
    await expect(spawnA).rejects.toThrow('ENOSPC');

    // Gamma succeeds; its write snapshots the live roster — beta is
    // still in it — and commits beta to disk.
    await spawn(h, 'gamma');

    // Beta's spawn fails. A write inside beta's window committed a
    // snapshot containing beta, so the compensating write must run.
    deferredB.reject(new Error('spawn failed'));
    await expect(spawnB).rejects.toThrow('spawn failed');

    const { names } = await readPersisted(h);
    expect(names).toContain('gamma');
    expect(names).not.toContain('alpha');
    expect(names).not.toContain('beta');
  });
});
