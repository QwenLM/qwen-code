/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  persistLoopStates,
  loadPersistedLoopStates,
  loadPersistedLoopState,
  clearPersistedLoopState,
} from './loopPersistence.js';
import type { PersistedLoopState } from './loopManager.js';

describe('loopPersistence', () => {
  let qwenDir: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'loop-test-'));
    qwenDir = join(base, '.qwen');
  });

  afterEach(async () => {
    // Clean up temp directory (parent of .qwen)
    await rm(join(qwenDir, '..'), { recursive: true, force: true });
  });

  const makeTask = (
    overrides: Partial<PersistedLoopState> = {},
  ): PersistedLoopState => ({
    id: 'test-loop',
    config: { prompt: 'check CI', intervalMs: 60_000, maxIterations: 0 },
    iteration: 3,
    startedAt: Date.now(),
    createdAt: Date.now(),
    nextFireAt: Date.now() + 60_000,
    ...overrides,
  });

  // -- persistLoopStates + loadPersistedLoopStates --------------------------

  it('writes and reads v2 format', async () => {
    const task = makeTask();
    await persistLoopStates([task], qwenDir);

    const loaded = await loadPersistedLoopStates(qwenDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(2);
    expect(loaded!.tasks).toHaveLength(1);
    expect(loaded!.tasks[0].id).toBe('test-loop');
    expect(loaded!.tasks[0].config.prompt).toBe('check CI');
  });

  it('persists multiple tasks', async () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    await persistLoopStates(tasks, qwenDir);

    const loaded = await loadPersistedLoopStates(qwenDir);
    expect(loaded!.tasks).toHaveLength(2);
    expect(loaded!.tasks.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('deletes file when persisting empty array', async () => {
    await persistLoopStates([makeTask()], qwenDir);
    await persistLoopStates([], qwenDir);

    const loaded = await loadPersistedLoopStates(qwenDir);
    expect(loaded).toBeNull();
  });

  // -- clearPersistedLoopState ----------------------------------------------

  it('clears persisted state', async () => {
    await persistLoopStates([makeTask()], qwenDir);
    await clearPersistedLoopState(qwenDir);
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });

  it('clear does not throw when file is missing', async () => {
    await expect(clearPersistedLoopState(qwenDir)).resolves.not.toThrow();
  });

  // -- loadPersistedLoopState (backward compat) -----------------------------

  it('loadPersistedLoopState returns first task', async () => {
    await persistLoopStates(
      [makeTask({ id: 'first' }), makeTask({ id: 'second' })],
      qwenDir,
    );
    const single = await loadPersistedLoopState(qwenDir);
    expect(single?.id).toBe('first');
  });

  it('loadPersistedLoopState returns null when empty', async () => {
    expect(await loadPersistedLoopState(qwenDir)).toBeNull();
  });

  // -- Validation -----------------------------------------------------------

  it('rejects task with empty prompt', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'x',
            config: { prompt: '', intervalMs: 60_000, maxIterations: 0 },
            iteration: 1,
            startedAt: 0,
            createdAt: 0,
            nextFireAt: null,
          },
        ],
        lastUpdatedAt: 0,
      }),
    );
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });

  it('rejects task with intervalMs below minimum', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'x',
            config: { prompt: 'a', intervalMs: 100, maxIterations: 0 },
            iteration: 1,
            startedAt: 0,
            createdAt: 0,
            nextFireAt: null,
          },
        ],
        lastUpdatedAt: 0,
      }),
    );
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });

  it('rejects task with negative maxIterations', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'x',
            config: { prompt: 'a', intervalMs: 60_000, maxIterations: -1 },
            iteration: 1,
            startedAt: 0,
            createdAt: 0,
            nextFireAt: null,
          },
        ],
        lastUpdatedAt: 0,
      }),
    );
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });

  it('handles corrupted JSON gracefully', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(join(qwenDir, 'loop-state.json'), '{broken json');
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });

  it('filters out invalid tasks but keeps valid ones', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'bad',
            config: { prompt: '', intervalMs: 60_000, maxIterations: 0 },
            iteration: 1,
            startedAt: 0,
            createdAt: 0,
            nextFireAt: null,
          },
          {
            id: 'good',
            config: { prompt: 'ok', intervalMs: 60_000, maxIterations: 0 },
            iteration: 1,
            startedAt: 0,
            createdAt: 0,
            nextFireAt: null,
          },
        ],
        lastUpdatedAt: 0,
      }),
    );
    const loaded = await loadPersistedLoopStates(qwenDir);
    expect(loaded!.tasks).toHaveLength(1);
    expect(loaded!.tasks[0].id).toBe('good');
  });

  // -- v1 migration ---------------------------------------------------------

  it('migrates v1 format to v2', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        config: { prompt: 'old check', intervalMs: 300_000, maxIterations: 0 },
        iteration: 5,
        startedAt: 1000,
      }),
    );
    const loaded = await loadPersistedLoopStates(qwenDir);
    expect(loaded!.version).toBe(2);
    expect(loaded!.tasks).toHaveLength(1);
    expect(loaded!.tasks[0].id).toBe('migrated-v1');
    expect(loaded!.tasks[0].config.prompt).toBe('old check');
    expect(loaded!.tasks[0].createdAt).toBe(1000);
  });

  it('rejects invalid v1 format', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-state.json'),
      JSON.stringify({
        config: { prompt: '', intervalMs: 0 },
        iteration: 0,
        startedAt: 0,
      }),
    );
    expect(await loadPersistedLoopStates(qwenDir)).toBeNull();
  });
});
