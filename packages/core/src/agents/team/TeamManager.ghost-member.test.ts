/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Regression test for #10208 — failed concurrent spawn
 * can persist a ghost member in config.json.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TeamManager } from './TeamManager.js';
import type { TeamFile } from './types.js';
import { formatAgentId, readTeamFile } from './teamHelpers.js';
import { FakeBackend } from './test-utils/fake-backend.js';
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
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('does not persist a failed concurrent spawn in config.json', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-member-'));
    setMockDir(tmpDir);

    const teamName = 'test-team';
    const teamDir = path.join(tmpDir, 'teams', teamName);
    await fs.mkdir(teamDir, { recursive: true });

    const teamFile: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: 'leader@test-team',
      members: [],
    };

    const backend = new FakeBackend();
    await backend.init();

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

    const manager = new TeamManager(backend, teamFile);

    // Start two concurrent spawns.
    const spawnA = manager.spawnTeammate({ name: 'alpha', cwd: tmpDir });
    const spawnB = manager.spawnTeammate({ name: 'beta', cwd: tmpDir });

    // Let both spawnAgent calls start (agents created in backend map).
    await new Promise((r) => setTimeout(r, 50));

    // A succeeds → continues to writeTeamFile (serializes both A and B).
    deferredA.resolve();
    await spawnA;

    // B fails → rollback removes B from memory, no writeTeamFile.
    deferredB.reject(new Error('spawn failed'));
    await expect(spawnB).rejects.toThrow('spawn failed');

    // Read persisted config.json.
    const persisted = await readTeamFile(teamName);
    expect(persisted).toBeDefined();

    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    // Bug: B should NOT be in the persisted file after failed spawn.
    expect(persistedNames).not.toContain('beta');

    await manager.cleanup();
  });

  it('preserves both members when concurrent spawns both succeed', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-member-'));
    setMockDir(tmpDir);

    const teamName = 'test-team';
    const teamDir = path.join(tmpDir, 'teams', teamName);
    await fs.mkdir(teamDir, { recursive: true });

    const teamFile: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: 'leader@test-team',
      members: [],
    };

    const backend = new FakeBackend();
    await backend.init();

    const manager = new TeamManager(backend, teamFile);

    // Both spawns succeed concurrently.
    await Promise.all([
      manager.spawnTeammate({ name: 'alpha', cwd: tmpDir }),
      manager.spawnTeammate({ name: 'beta', cwd: tmpDir }),
    ]);

    const persisted = await readTeamFile(teamName);
    expect(persisted).toBeDefined();
    const persistedNames = persisted!.members.map((m) => m.name);
    expect(persistedNames).toContain('alpha');
    expect(persistedNames).toContain('beta');
    expect(persisted!.members).toHaveLength(2);

    await manager.cleanup();
  });
});
