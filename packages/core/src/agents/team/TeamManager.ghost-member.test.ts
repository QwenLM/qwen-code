/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Regression test for #10208 — failed concurrent spawn
 * can persist a ghost member in config.json.
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
 * Gate teammate spawns behind per-agent promises while each agent still
 * registers synchronously in the backend map.
 *
 * Encodes the suite's most delicate contract: `FakeBackend.spawnAgent`
 * creates the FakeAgent synchronously before its first await, which is
 * exactly what keeps these race tests deterministic — calling the
 * original fire-and-forget preserves that synchronous registration
 * (`getAgentFromBackend` finds the handle while its spawn promise is
 * still gated), and returning the gate promise lets each test control
 * when the gated `spawnTeammate` continues past its await.
 *
 * Agents without a gate throw by default; with `passthroughUnknown`
 * they spawn normally through the original backend instead.
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
      // Fire-and-forget: the synchronous portion creates the FakeAgent
      // in the backend map so getAgentFromBackend finds it.
      void originalSpawnAgent(config);
      return gate;
    }
    if (options?.passthroughUnknown) {
      return originalSpawnAgent(config);
    }
    throw new Error(`Unexpected agent: ${config.agentId}`);
  };
}

describe('TeamManager ghost member regression (#10208)', () => {
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

  it('does not persist a failed concurrent spawn in config.json', async () => {
    const h = await createHarness();
    const teamName = h.teamName;
    const backend = h.backend;

    // Controlled spawn: gate each agent's promise while the agent
    // still registers synchronously in the backend map (gateSpawns).
    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();
    gateSpawns(
      backend,
      new Map([
        [formatAgentId('alpha', teamName), deferredA.promise],
        [formatAgentId('beta', teamName), deferredB.promise],
      ]),
    );

    // Start two concurrent spawns.
    const spawnA = h.teamManager.spawnTeammate({
      name: 'alpha',
      cwd: h.tmpDir,
    });
    const spawnB = h.teamManager.spawnTeammate({
      name: 'beta',
      cwd: h.tmpDir,
    });

    // Let both spawnAgent calls start (agents created in backend map).
    await new Promise((r) => setTimeout(r, 50));

    // A succeeds → continues to writeTeamFile (serializes both A and B).
    deferredA.resolve();
    await spawnA;

    // B fails → rollback removes B from memory; the compensating write
    // re-persists the roster without B.
    deferredB.reject(new Error('spawn failed'));
    await expect(spawnB).rejects.toThrow('spawn failed');

    // Read persisted config.json.
    const persisted = await readTeamFile(teamName);
    expect(persisted).toBeDefined();

    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    // Bug: B should NOT be in the persisted file after failed spawn.
    expect(persistedNames).not.toContain('beta');
  });

  it('preserves both members when concurrent spawns both succeed', async () => {
    const h = await createHarness();

    // Both spawns succeed concurrently.
    await Promise.all([
      h.teamManager.spawnTeammate({ name: 'alpha', cwd: h.tmpDir }),
      h.teamManager.spawnTeammate({ name: 'beta', cwd: h.tmpDir }),
    ]);

    const persisted = await readTeamFile(h.teamName);
    expect(persisted).toBeDefined();
    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    expect(persistedNames).toContain('beta');
    expect(persisted!.members).toHaveLength(2);
  });

  it('keeps the roster ghost-free when a slow success write lands last (write serialization)', async () => {
    const h = await createHarness();
    const teamName = h.teamName;
    const backend = h.backend;

    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();
    gateSpawns(
      backend,
      new Map([
        [formatAgentId('alpha', teamName), deferredA.promise],
        [formatAgentId('beta', teamName), deferredB.promise],
      ]),
    );

    // Hold A's roster write after it snapshots the roster. The real
    // write serializes synchronously when it starts, so the snapshot
    // here is [alpha, beta] while beta is still pending; the rename
    // only lands when the gate opens. Without serialized writes the
    // compensating write commits [alpha] first and this stale snapshot
    // lands last, re-persisting ghost beta (#10208 symptom).
    const realWriteTeamFile = teamHelpers.writeTeamFile;
    let writeCalls = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((r) => {
      releaseFirstWrite = r;
    });
    vi.spyOn(teamHelpers, 'writeTeamFile').mockImplementation(
      async (name, tf) => {
        writeCalls++;
        if (writeCalls === 1) {
          const snapshot: TeamFile = JSON.parse(JSON.stringify(tf));
          await firstWriteGate;
          return realWriteTeamFile(name, snapshot);
        }
        return realWriteTeamFile(name, tf);
      },
    );

    const spawnA = h.teamManager.spawnTeammate({
      name: 'alpha',
      cwd: h.tmpDir,
    });
    const spawnB = h.teamManager.spawnTeammate({
      name: 'beta',
      cwd: h.tmpDir,
    });

    // Let both spawnAgent calls start (agents created in backend map).
    await new Promise((r) => setTimeout(r, 50));

    // A succeeds and its roster write starts (held at the gate).
    deferredA.resolve();
    await vi.waitFor(() => expect(writeCalls).toBe(1));

    // B fails while A's stale write is still in flight; rollback removes
    // B from memory and queues the compensating write.
    deferredB.reject(new Error('spawn failed'));

    // Release A's stale write; the compensating write must land after it
    // with the post-rollback state.
    releaseFirstWrite();
    await spawnA;
    await expect(spawnB).rejects.toThrow('spawn failed');
    expect(writeCalls).toBe(2);

    const persisted = await readTeamFile(teamName);
    expect(persisted).toBeDefined();
    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    expect(persistedNames).not.toContain('beta');
  });

  it('still rejects with the original spawn error when the compensating write fails', async () => {
    const h = await createHarness();
    const teamName = h.teamName;
    const backend = h.backend;

    // Gate only beta; other agents (alpha, gamma) pass through to
    // the original backend spawn.
    const deferredB = createDeferred<void>();
    gateSpawns(
      backend,
      new Map([[formatAgentId('beta', teamName), deferredB.promise]]),
      { passthroughUnknown: true },
    );

    // A succeeds; its success write lands before we arm the spy.
    await h.teamManager.spawnTeammate({ name: 'alpha', cwd: h.tmpDir });

    // Witness for the leader notification: the compensating-write
    // failure must be surfaced to the leader, since debug logging
    // alone is invisible in production.
    const leaderSpy = vi.fn();
    h.teamManager.setLeaderMessageCallback(leaderSpy);

    // Make the next roster write (B's compensating write) fail.
    const writeSpy = vi
      .spyOn(teamHelpers, 'writeTeamFile')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    const spawnB = h.teamManager.spawnTeammate({
      name: 'beta',
      cwd: h.tmpDir,
    });
    await new Promise((r) => setTimeout(r, 50));
    deferredB.reject(new Error('spawn failed'));

    // The compensating write failure must not mask the spawn error...
    await expect(spawnB).rejects.toThrow('spawn failed');
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // ...and beta must be rolled back from the in-memory roster.
    const inMemory = (h.teamManager as unknown as { teamFile: TeamFile })
      .teamFile;
    const inMemoryNames = inMemory.members.map((m) => m.name);
    expect(inMemoryNames).toContain('alpha');
    expect(inMemoryNames).not.toContain('beta');

    // The failure must also be surfaced to the leader — a debug-only
    // trail is invisible in production.
    const notice = leaderSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('Compensating team-file write'),
    );
    expect(notice).toBeDefined();
    expect(notice![0]).toContain('<team_error>');
    expect(notice![0]).toContain(formatAgentId('beta', teamName));

    // A rejected write must not poison the write queue: a subsequent
    // normal spawn has to land its roster write on disk.
    await h.teamManager.spawnTeammate({ name: 'gamma', cwd: h.tmpDir });

    const persisted = await readTeamFile(teamName);
    expect(persisted).toBeDefined();
    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    expect(persistedNames).toContain('gamma');
    expect(persistedNames).not.toContain('beta');
  });
});
