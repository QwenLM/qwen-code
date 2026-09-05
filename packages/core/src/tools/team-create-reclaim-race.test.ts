/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Regression test for #10209 — concurrent creators
 * reclaiming the same stale team name: a delayed reclaim decision must
 * not delete a newer live team generation.
 *
 * The reported interleaving (cross-session in the wild):
 *   1. A stale team with a dead leader PID exists on disk.
 *   2. Creators A and B both read that stale config and both pass the
 *      liveness check.
 *   3. A deletes the stale dirs and creates a new live team under the
 *      same name.
 *   4. B resumes its previously authorized reclaim, whose
 *      deleteTeamDirs() targets the team name — wiping A's fresh
 *      config.json and task dir while A holds a live TeamManager.
 *
 * The read barrier below makes the interleaving deterministic: B's
 * inspection read of the stale config is captured at call time and its
 * delivery held until A has completed its full reclaim+create cycle,
 * so B resumes its reclaim against a generation that is no longer on
 * disk.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TeamCreateTool } from './team-create.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    QWEN_DIR: '.qwen',
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

/**
 * One-shot read barrier for team config files. While armed, the NEXT
 * read of `teams/<name>/config.json` captures the file content at call
 * time, resolves `arrival`, and holds delivery until `release` resolves
 * — pinning the reader to the generation it inspected even while the
 * file on disk is replaced by another creator.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const barrier = {
    armed: false,
    captured: undefined as string | undefined,
    arrival: null as { promise: Promise<void>; resolve: () => void } | null,
    release: null as { promise: Promise<void>; resolve: () => void } | null,
  };
  return {
    ...actual,
    __readBarrier: barrier,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const filePath = String(args[0]);
      const isTeamConfig =
        (filePath.includes('/teams/') || filePath.includes('\\teams\\')) &&
        filePath.endsWith('config.json');
      if (readBarrier.armed && readBarrier.release && isTeamConfig) {
        readBarrier.armed = false;
        readBarrier.captured = await actual.readFile(args[0], 'utf-8');
        readBarrier.arrival?.resolve();
        await readBarrier.release.promise;
        return readBarrier.captured;
      }
      return actual.readFile(...args);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

interface ReadBarrier {
  armed: boolean;
  captured: string | undefined;
  arrival: { promise: Promise<void>; resolve: () => void } | null;
  release: { promise: Promise<void>; resolve: () => void } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __readBarrier: barrier } = (await import('node:fs/promises')) as any;
const readBarrier = barrier as ReadBarrier;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeConfig(sessionId: string) {
  return {
    getArenaManager: () => null,
    getTeamManager: () => null,
    getSubagentManager: () => null,
    getAgentsSettings: () => ({}),
    getSessionId: () => sessionId,
    setTeamManager: vi.fn(),
    setTeamContext: vi.fn(),
  } as unknown as import('../config/config.js').Config;
}

describe('team_create stale-reclaim race (#10209)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reclaim-race-test-'));
    __setMockGlobalDir(tmpDir);
    readBarrier.armed = false;
    readBarrier.arrival = null;
    readBarrier.release = null;
    readBarrier.captured = undefined;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** PID of a process that has already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    return child.pid!;
  }

  /** Seed a stranded stale team: dead leader PID, leftovers on disk. */
  async function seedStaleTeam(teamName: string): Promise<void> {
    const teamDir = path.join(tmpDir, 'teams', teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          createdAt: 1,
          leadAgentId: `leader@${teamName}`,
          leadSessionId: 'session-stale',
          leadPid: deadPid(),
          members: [],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    const tasksDir = path.join(tmpDir, 'tasks', teamName);
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, 'task-1.json'), '{}', 'utf-8');
  }

  it('a delayed reclaim must not delete a newer live generation', async () => {
    await seedStaleTeam('race');
    const configPath = path.join(tmpDir, 'teams', 'race', 'config.json');
    const signal = new AbortController().signal;

    const creatorA = new TeamCreateTool(makeConfig('session-a'));
    const creatorB = new TeamCreateTool(makeConfig('session-b'));

    // B reaches reclaim first. Its inspection read of the stale config
    // is captured and held at the barrier — B's reclaim decision is now
    // based on a generation snapshot.
    readBarrier.arrival = deferred();
    readBarrier.release = deferred();
    readBarrier.armed = true;
    const bDone = creatorB.build({ team_name: 'race' }).execute(signal);
    await readBarrier.arrival.promise;
    expect(readBarrier.captured).toContain('session-stale');

    // While B is held, A completes the entire reclaim+create cycle and
    // owns the name with a new live generation.
    const aResult = await creatorA.build({ team_name: 'race' }).execute(signal);
    expect(aResult.error).toBeUndefined();
    const aGeneration = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(aGeneration.leadSessionId).toBe('session-a');

    // B resumes its previously authorized reclaim. Whatever it does
    // next must not destroy A's generation.
    readBarrier.release!.resolve();
    const bResult = await bDone;

    expect(bResult.error).toBeDefined();
    expect(bResult.llmContent).toContain('live');
    const survivor = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(survivor.leadSessionId).toBe('session-a');
  });

  it('still reclaims a stale team when no other creator interferes', async () => {
    await seedStaleTeam('quiet');
    const configPath = path.join(tmpDir, 'teams', 'quiet', 'config.json');

    const creator = new TeamCreateTool(makeConfig('session-q'));
    const result = await creator
      .build({ team_name: 'quiet' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(config.leadSessionId).toBe('session-q');
  });
});
