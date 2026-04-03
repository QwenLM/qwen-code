/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loop Persistence — multi-task file format with v1→v2 migration.
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { MIN_INTERVAL_MS, MAX_INTERVAL_MS } from './loopManager.js';
import type { PersistedLoopState, PersistedLoopFile } from './loopManager.js';

const LOOP_STATE_FILENAME = 'loop-state.json';

/** Skip writes if one is already in flight and was started within this window. */
const WRITE_DEBOUNCE_MS = 5_000;

let lastWriteAt = 0;
let pendingWrite: Promise<void> | null = null;

function getLoopStatePath(qwenDir: string): string {
  return join(qwenDir, LOOP_STATE_FILENAME);
}

function isValidTask(t: unknown): t is PersistedLoopState {
  if (t === null || typeof t !== 'object') return false;
  const p = t as Record<string, unknown>;
  if (typeof p['id'] !== 'string') return false;
  if (
    typeof p['iteration'] !== 'number' ||
    !Number.isFinite(p['iteration'] as number) ||
    !Number.isInteger(p['iteration'] as number) ||
    (p['iteration'] as number) < 0
  )
    return false;
  if (
    typeof p['startedAt'] !== 'number' ||
    !Number.isFinite(p['startedAt'] as number)
  )
    return false;
  if (
    typeof p['createdAt'] !== 'number' ||
    !Number.isFinite(p['createdAt'] as number)
  )
    return false;
  // nextFireAt must be number (finite) or null
  if (
    p['nextFireAt'] !== null &&
    (typeof p['nextFireAt'] !== 'number' ||
      !Number.isFinite(p['nextFireAt'] as number))
  )
    return false;

  const cfg = p['config'];
  if (cfg === null || typeof cfg !== 'object') return false;
  const c = cfg as Record<string, unknown>;
  if (typeof c['prompt'] !== 'string' || (c['prompt'] as string).length === 0)
    return false;
  if (
    typeof c['intervalMs'] !== 'number' ||
    !Number.isFinite(c['intervalMs'] as number)
  )
    return false;
  if (
    (c['intervalMs'] as number) < MIN_INTERVAL_MS ||
    (c['intervalMs'] as number) > MAX_INTERVAL_MS
  )
    return false;
  if (
    typeof c['maxIterations'] !== 'number' ||
    !Number.isFinite(c['maxIterations'] as number) ||
    !Number.isInteger(c['maxIterations'] as number) ||
    (c['maxIterations'] as number) < 0
  )
    return false;

  return true;
}

/**
 * Migrate a v1 single-task file to v2 format.
 */
function migrateV1(raw: Record<string, unknown>): PersistedLoopFile | null {
  // v1 format: { config: {...}, iteration, startedAt }
  if (
    typeof raw['config'] === 'object' &&
    raw['config'] !== null &&
    typeof raw['iteration'] === 'number' &&
    typeof raw['startedAt'] === 'number' &&
    !('version' in raw)
  ) {
    const task: Record<string, unknown> = {
      id: 'migrated-v1',
      config: raw['config'],
      iteration: raw['iteration'],
      startedAt: raw['startedAt'],
      createdAt: raw['startedAt'],
      nextFireAt: null,
    };
    if (isValidTask(task)) {
      return {
        version: 2,
        tasks: [task as PersistedLoopState],
        lastUpdatedAt: Date.now(),
      };
    }
  }
  return null;
}

/**
 * Persist all loop states to the project's .qwen/ directory.
 * Writes are debounced to avoid contention from rapid completions.
 */
export async function persistLoopStates(
  states: PersistedLoopState[],
  qwenDir: string,
): Promise<void> {
  if (states.length === 0) {
    // Wait for any in-flight write to finish before clearing,
    // so it doesn't recreate the file after unlink.
    if (pendingWrite) await pendingWrite;
    await clearPersistedLoopState(qwenDir);
    return;
  }

  const now = Date.now();
  if (now - lastWriteAt < WRITE_DEBOUNCE_MS && pendingWrite) {
    // Debounce: skip this write, a recent one is sufficient
    return;
  }

  lastWriteAt = now;
  const file: PersistedLoopFile = {
    version: 2,
    tasks: states,
    lastUpdatedAt: now,
  };

  pendingWrite = (async () => {
    try {
      const filePath = getLoopStatePath(qwenDir);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(file, null, 2));
    } catch {
      // Best-effort
    } finally {
      pendingWrite = null;
    }
  })();

  await pendingWrite;
}

/** Backward-compatible single-state persistence. */
export async function persistLoopState(
  state: PersistedLoopState,
  qwenDir: string,
): Promise<void> {
  await persistLoopStates([state], qwenDir);
}

/**
 * Load persisted loop states. Handles v1→v2 migration transparently.
 */
export async function loadPersistedLoopStates(
  qwenDir: string,
): Promise<PersistedLoopFile | null> {
  try {
    const filePath = getLoopStatePath(qwenDir);
    const data = await readFile(filePath, 'utf-8');
    const raw = JSON.parse(data);

    // v2 format
    if (raw && raw.version === 2 && Array.isArray(raw.tasks)) {
      const validTasks = raw.tasks.filter(isValidTask);
      if (validTasks.length === 0) return null;
      return {
        version: 2,
        tasks: validTasks,
        lastUpdatedAt: raw.lastUpdatedAt ?? Date.now(),
      };
    }

    // v1 migration
    return migrateV1(raw);
  } catch {
    return null;
  }
}

/** Backward-compatible single-state loader. */
export async function loadPersistedLoopState(
  qwenDir: string,
): Promise<PersistedLoopState | null> {
  const file = await loadPersistedLoopStates(qwenDir);
  return file && file.tasks.length > 0 ? file.tasks[0] : null;
}

/**
 * Remove persisted loop state file.
 */
export async function clearPersistedLoopState(qwenDir: string): Promise<void> {
  try {
    await unlink(getLoopStatePath(qwenDir));
  } catch {
    // Ignore ENOENT
  }
}
