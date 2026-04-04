/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Distributed task system for agent teams.
 *
 * Each task is a separate JSON file at
 * `~/.qwen/tasks/{teamName}/{id}.json`.
 * Concurrency is handled via `proper-lockfile` (30 retries,
 * 5–100ms exponential backoff).
 *
 * Provides CRUD operations, task claiming, blocking, and
 * in-process pub/sub for UI updates.
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { isNodeError } from '../../utils/errors.js';
import { getTasksDir } from './teamHelpers.js';
import type { SwarmTask, SwarmTaskStatus } from './types.js';

// ─── Lock options ───────────────────────────────────────────

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
  },
  stale: 5000,
  onCompromised: () => {},
};

// ─── Path helpers ───────────────────────────────────────────

/** Path to a single task file. */
export function getTaskPath(teamName: string, taskId: string): string {
  return path.join(getTasksDir(teamName), `${taskId}.json`);
}

// ─── In-process pub/sub ─────────────────────────────────────

type TaskUpdateListener = (teamName: string) => void;
const listeners = new Set<TaskUpdateListener>();

/**
 * Register a listener for task updates (any create/update/delete).
 * Returns an unsubscribe function.
 */
export function onTasksUpdated(listener: TaskUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify all listeners that tasks have changed. */
export function notifyTasksUpdated(teamName: string): void {
  for (const listener of listeners) {
    listener(teamName);
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/**
 * Create a new task. Auto-increments the ID based on existing
 * task files (high water mark + 1).
 */
export async function createTask(
  teamName: string,
  opts: {
    subject: string;
    description: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<SwarmTask> {
  const dir = getTasksDir(teamName);
  await fs.mkdir(dir, { recursive: true });

  // Use O_CREAT|O_EXCL to atomically claim the ID — if two
  // concurrent callers pick the same ID, the later write fails
  // and we retry with the next ID.
  // Must exceed MAX_TEAMMATES (10) since all teammates could
  // race on task_create simultaneously.
  const MAX_RETRIES = 15;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const nextId = await getNextTaskId(dir);
    const task: SwarmTask = {
      id: nextId,
      subject: opts.subject,
      description: opts.description,
      activeForm: opts.activeForm,
      owner: opts.owner,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: opts.metadata,
    };

    const taskPath = path.join(dir, `${nextId}.json`);
    try {
      const handle = await fs.open(
        taskPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      );
      await handle.writeFile(JSON.stringify(task, null, 2) + '\n', 'utf-8');
      await handle.close();
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        continue; // ID was taken — retry with next
      }
      throw err;
    }

    notifyTasksUpdated(teamName);
    return task;
  }

  throw new Error(
    `Failed to create task after ${MAX_RETRIES} attempts (ID contention).`,
  );
}

/**
 * Read a single task by ID.
 * Returns undefined if the task doesn't exist.
 */
export async function getTask(
  teamName: string,
  taskId: string,
): Promise<SwarmTask | undefined> {
  const taskPath = getTaskPath(teamName, taskId);
  try {
    const raw = await fs.readFile(taskPath, 'utf-8');
    return JSON.parse(raw) as SwarmTask;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Update fields on an existing task.
 * Uses file locking for safe concurrent updates.
 * Returns the updated task, or undefined if not found.
 */
export async function updateTask(
  teamName: string,
  taskId: string,
  updates: {
    status?: SwarmTaskStatus;
    owner?: string | null;
    subject?: string;
    description?: string;
    activeForm?: string | null;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  },
): Promise<SwarmTask | undefined> {
  const taskPath = getTaskPath(teamName, taskId);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(taskPath, LOCK_OPTIONS);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const raw = await fs.readFile(taskPath, 'utf-8');
    const task = JSON.parse(raw) as SwarmTask;

    if (updates.status !== undefined) {
      task.status = updates.status;

      // When a task completes, unblock any tasks that depend on it.
      if (updates.status === 'completed' && task.blocks.length > 0) {
        await unblockDependents(teamName, taskId, task.blocks);
      }
    }
    if (updates.owner !== undefined) {
      task.owner = updates.owner ?? undefined;
    }
    if (updates.subject !== undefined) {
      task.subject = updates.subject;
    }
    if (updates.description !== undefined) {
      task.description = updates.description;
    }
    if (updates.activeForm !== undefined) {
      task.activeForm = updates.activeForm ?? undefined;
    }
    if (updates.metadata !== undefined) {
      task.metadata = task.metadata ?? {};
      for (const [key, value] of Object.entries(updates.metadata)) {
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
      if (Object.keys(task.metadata).length === 0) {
        task.metadata = undefined;
      }
    }
    if (updates.addBlocks?.length) {
      const blockSet = new Set(task.blocks);
      for (const id of updates.addBlocks) blockSet.add(id);
      task.blocks = Array.from(blockSet);
    }
    if (updates.addBlockedBy?.length) {
      const blockedBySet = new Set(task.blockedBy);
      for (const id of updates.addBlockedBy) blockedBySet.add(id);
      task.blockedBy = Array.from(blockedBySet);
    }

    // Auto-assign owner when marking in_progress with no owner.
    if (
      updates.status === 'in_progress' &&
      !task.owner &&
      updates.owner === undefined
    ) {
      // Caller should set owner explicitly; this is a safety net.
    }

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + '\n', 'utf-8');

    notifyTasksUpdated(teamName);
    return task;
  } finally {
    await release?.();
  }
}

/**
 * Delete a task file.
 */
export async function deleteTask(
  teamName: string,
  taskId: string,
): Promise<boolean> {
  const taskPath = getTaskPath(teamName, taskId);
  try {
    await fs.unlink(taskPath);
    notifyTasksUpdated(teamName);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * List all tasks for a team, optionally filtered.
 */
export async function listTasks(
  teamName: string,
  filters?: {
    status?: SwarmTaskStatus;
    owner?: string;
    blockedBy?: string;
  },
): Promise<SwarmTask[]> {
  const dir = getTasksDir(teamName);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const tasks: SwarmTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
      const task = JSON.parse(raw) as SwarmTask;
      tasks.push(task);
    } catch {
      // Skip corrupt/unreadable files.
    }
  }

  // Sort by ID (numeric ascending).
  tasks.sort((a, b) => Number(a.id) - Number(b.id));

  if (!filters) return tasks;

  return tasks.filter((t) => {
    if (filters.status !== undefined && t.status !== filters.status) {
      return false;
    }
    if (filters.owner !== undefined && t.owner !== filters.owner) {
      return false;
    }
    if (
      filters.blockedBy !== undefined &&
      !t.blockedBy.includes(filters.blockedBy)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Delete all tasks for a team (reset the task list).
 */
export async function resetTaskList(teamName: string): Promise<void> {
  const dir = getTasksDir(teamName);
  await fs.rm(dir, { recursive: true, force: true });
  notifyTasksUpdated(teamName);
}

// ─── Task relationships ─────────────────────────────────────

/**
 * Remove a completed task ID from the blockedBy arrays of its
 * dependents. Called automatically when a task completes.
 */
async function unblockDependents(
  teamName: string,
  completedId: string,
  dependentIds: string[],
): Promise<void> {
  await Promise.all(
    dependentIds.map(async (depId) => {
      const depPath = getTaskPath(teamName, depId);
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(depPath, LOCK_OPTIONS);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') return;
        throw err;
      }
      try {
        const raw = await fs.readFile(depPath, 'utf-8');
        const task = JSON.parse(raw) as SwarmTask;
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        await fs.writeFile(
          depPath,
          JSON.stringify(task, null, 2) + '\n',
          'utf-8',
        );
      } finally {
        await release?.();
      }
    }),
  );
  notifyTasksUpdated(teamName);
}

/**
 * Add a blocking relationship: `fromId` blocks `toId`.
 * Updates both task files.
 */
export async function blockTask(
  teamName: string,
  fromId: string,
  toId: string,
): Promise<void> {
  await Promise.all([
    updateTask(teamName, fromId, { addBlocks: [toId] }),
    updateTask(teamName, toId, { addBlockedBy: [fromId] }),
  ]);
}

// ─── Claiming ───────────────────────────────────────────────

/**
 * Claim a pending task for an agent.
 * Sets owner and transitions to in_progress.
 * Returns the claimed task, or undefined if already claimed
 * or not found.
 */
export async function claimTask(
  teamName: string,
  taskId: string,
  agentId: string,
  opts?: { checkAgentBusy?: boolean; ownerName?: string },
): Promise<SwarmTask | undefined> {
  if (opts?.checkAgentBusy) {
    const busy = await isAgentBusy(teamName, agentId);
    if (busy) return undefined;
  }

  const taskPath = getTaskPath(teamName, taskId);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(taskPath, LOCK_OPTIONS);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const raw = await fs.readFile(taskPath, 'utf-8');
    const task = JSON.parse(raw) as SwarmTask;

    // Only claim pending tasks.
    if (task.status !== 'pending') return undefined;
    // Don't claim if already owned.
    if (task.owner) return undefined;

    // Store the human-readable name as owner for consistency
    // with manual assignment via task_update (which uses bare
    // teammate names, not agentId "name@team" format).
    task.owner = opts?.ownerName ?? agentId;
    task.status = 'in_progress';

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + '\n', 'utf-8');

    notifyTasksUpdated(teamName);
    return task;
  } finally {
    await release?.();
  }
}

/**
 * Check if an agent already owns an in_progress task.
 * Matches both by agentId ("name@team") and bare name
 * for consistency with manual and auto-claimed ownership.
 */
async function isAgentBusy(
  teamName: string,
  agentId: string,
): Promise<boolean> {
  const inProgress = await listTasks(teamName, {
    status: 'in_progress',
  });
  // Extract bare name from "name@team" format.
  const bareName = agentId.split('@')[0]!;
  return inProgress.some((t) => t.owner === agentId || t.owner === bareName);
}

// ─── Agent-level operations ─────────────────────────────────

/**
 * Unassign all tasks owned by an agent (set back to pending).
 * Used when an agent crashes or is shut down.
 */
export async function unassignTeammateTasks(
  teamName: string,
  agentId: string,
): Promise<number> {
  // Match both "name@team" agentId format and bare name,
  // since auto-claim stores bare names while manual
  // assignment may use either format.
  const bareName = agentId.split('@')[0]!;
  const inProgress = await listTasks(teamName, {
    status: 'in_progress',
  });
  let count = 0;
  for (const task of inProgress) {
    if (task.owner === agentId || task.owner === bareName) {
      await updateTask(teamName, task.id, {
        status: 'pending',
        owner: null,
      });
      count++;
    }
  }
  return count;
}

/**
 * Get a summary of each agent's task status.
 */
export async function getAgentStatuses(
  teamName: string,
): Promise<Map<string, { inProgress: number; completed: number }>> {
  const tasks = await listTasks(teamName);
  const statuses = new Map<string, { inProgress: number; completed: number }>();

  for (const task of tasks) {
    if (!task.owner) continue;
    const entry = statuses.get(task.owner) ?? {
      inProgress: 0,
      completed: 0,
    };
    if (task.status === 'in_progress') {
      entry.inProgress++;
    } else if (task.status === 'completed') {
      entry.completed++;
    }
    statuses.set(task.owner, entry);
  }

  return statuses;
}

// ─── Helpers ────────────────────────────────────────────────

/** Get the next task ID by scanning existing files. */
async function getNextTaskId(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return '1';
  }

  let maxId = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const num = parseInt(entry.replace('.json', ''), 10);
    if (!isNaN(num) && num > maxId) {
      maxId = num;
    }
  }
  return String(maxId + 1);
}
