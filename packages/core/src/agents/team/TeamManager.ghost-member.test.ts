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

    // Controlled spawn: call original synchronously so the agent is
    // created in the backend map, but defer the promise so we control
    // when each spawnTeammate continues past its await.
    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();
    const originalSpawnAgent = backend.spawnAgent.bind(backend);

    backend.spawnAgent = (config) => {
      const agentId = config.agentId;
      // Fire-and-forget: the synchronous portion creates the FakeAgent
      // in the backend map so getAgentFromBackend finds it.
      void originalSpawnAgent(config);

      if (agentId === formatAgentId('alpha', teamName)) {
        return deferredA.promise;
      }
      if (agentId === formatAgentId('beta', teamName)) {
        return deferredB.promise;
      }
      throw new Error(`Unexpected agent: ${agentId}`);
    };

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
    const originalSpawnAgent = backend.spawnAgent.bind(backend);

    backend.spawnAgent = (config) => {
      const agentId = config.agentId;
      void originalSpawnAgent(config);

      if (agentId === formatAgentId('alpha', teamName)) {
        return deferredA.promise;
      }
      if (agentId === formatAgentId('beta', teamName)) {
        return deferredB.promise;
      }
      throw new Error(`Unexpected agent: ${agentId}`);
    };

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

    const deferredB = createDeferred<void>();
    const originalSpawnAgent = backend.spawnAgent.bind(backend);

    backend.spawnAgent = (config) => {
      const agentId = config.agentId;
      if (agentId === formatAgentId('beta', teamName)) {
        // Create the handle synchronously, but defer resolution so we
        // control when B continues past its await.
        void originalSpawnAgent(config);
        return deferredB.promise;
      }
      return originalSpawnAgent(config);
    };

    // A succeeds; its success write lands before we arm the spy.
    await h.teamManager.spawnTeammate({ name: 'alpha', cwd: h.tmpDir });

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
  });
});
