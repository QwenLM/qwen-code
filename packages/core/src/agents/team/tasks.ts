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
import { createDebugLogger } from '../../utils/debugLogger.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { getTasksDir } from './teamHelpers.js';
import type { SwarmTask, SwarmTaskStatus } from './types.js';

const debug = createDebugLogger('AGENTS_TEAM_TASKS');

// ─── Size limits ────────────────────────────────────────────

/**
 * Server-side cap on `metadata` payload size, applied in
 * `createTask` / `updateTask`. JSON Schema can't easily express a
 * byte-size limit on arbitrary objects, and an unbounded metadata
 * field is the easiest OOM vector left in the task model: every
 * `listTasks` reads every task file in parallel.
 */
const MAX_METADATA_BYTES = 32_768;

function assertMetadataWithinLimit(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  const size = Buffer.byteLength(JSON.stringify(metadata), 'utf-8');
  if (size > MAX_METADATA_BYTES) {
    throw new Error(
      `Task metadata is too large (${size} bytes; max ${MAX_METADATA_BYTES}). ` +
        `Trim the payload or store the bulk content elsewhere.`,
    );
  }
}

// ─── Lock options ───────────────────────────────────────────

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
  },
  stale: 5000,
  onCompromised: (err) => {
    debug.warn('task lock compromised:', err?.message ?? err);
  },
};

// ─── Path helpers ───────────────────────────────────────────

/**
 * Validate a task ID. Task IDs are auto-generated as positive
 * integers by `createTask`; rejecting anything else prevents
 * model-supplied IDs from escaping the tasks directory via
 * `../` segments or absolute paths.
 */
export function assertValidTaskId(taskId: string): void {
  if (!/^[1-9]\d*$/.test(taskId)) {
    throw new Error(
      `Invalid task ID "${taskId}". Task IDs must be positive integers.`,
    );
  }
}

/** Path to a single task file. */
export function getTaskPath(teamName: string, taskId: string): string {
  assertValidTaskId(taskId);
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
  assertMetadataWithinLimit(opts.metadata);
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
 * Thrown by `updateTask` when a teammate caller's ownership-restricted
 * update would mutate a task already owned by a different teammate.
 *
 * The check is performed inside the per-task lock so two teammates
 * racing to claim the same pending task can't both succeed: the second
 * write sees the first one's owner and rejects rather than silently
 * overwriting it.
 */
export class TaskOwnershipError extends Error {
  constructor(
    readonly taskId: string,
    readonly callerName: string,
    readonly actualOwner: string,
  ) {
    super(
      `Task #${taskId} is owned by "${actualOwner}". ` +
        `Only the leader or the owner can change ` +
        `status / owner / subject / description / blocks.`,
    );
    this.name = 'TaskOwnershipError';
  }
}

/**
 * Update fields on an existing task.
 * Uses file locking for safe concurrent updates.
 * Returns the updated task, or undefined if not found.
 *
 * `opts.callerName`, when set, identifies a teammate caller. The
 * update is then rejected with `TaskOwnershipError` if the task's
 * existing owner is set to a different teammate. The check happens
 * inside the lock — without that, two teammates can both pass a
 * pre-lock guard on an unowned task and have the second writer
 * silently overwrite the first one's claim.
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
  opts?: { callerName?: string },
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

    if (opts?.callerName !== undefined) {
      const restrictsOwnership =
        updates.status !== undefined ||
        updates.owner !== undefined ||
        updates.subject !== undefined ||
        updates.description !== undefined ||
        (updates.addBlocks?.length ?? 0) > 0 ||
        (updates.addBlockedBy?.length ?? 0) > 0;
      if (restrictsOwnership && task.owner && task.owner !== opts.callerName) {
        throw new TaskOwnershipError(taskId, opts.callerName, task.owner);
      }
    }

    // Merge dependency edges first so the completion-unblock below
    // sees the post-update `task.blocks` and clears any dependent that
    // was already recorded as blocked by this task. Note this does NOT
    // cover the freshly-mirrored reciprocal edge for a combined
    //   task_update({taskId:'1', status:'completed', addBlocks:['2']})
    // call: the dependent's `blockedBy` doesn't contain this task yet
    // when unblockDependents runs, so the reciprocal would re-block it.
    // That case is handled in task-update.ts by skipping the addBlocks
    // reciprocal when the same call completes the task.
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

    if (updates.status !== undefined) {
      task.status = updates.status;

      // When a task completes, unblock any tasks that depend on it.
      if (updates.status === 'completed' && task.blocks.length > 0) {
        await unblockDependents(teamName, taskId, task.blocks);
      }
    }
    if (updates.owner !== undefined) {
      // Treat empty string as unassign (per the task_update
      // schema: "Set to empty string to unassign"). The previous
      // `?? undefined` only nullified actual null/undefined and
      // stored "" verbatim, so the model following the schema
      // ended up with `owner: ""` instead of unassigned.
      task.owner = updates.owner ? updates.owner : undefined;
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
        // Skip dangerous keys. JSON.parse exposes `__proto__` as
        // an own property, so without this filter a teammate-
        // controlled `metadata: { "__proto__": {x:1} }` would
        // re-parent task.metadata via the __proto__ setter. Bounded
        // (per-task, doesn't survive JSON.stringify) but blocked
        // for hygiene since metadata is teammate-controlled.
        if (
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype'
        ) {
          continue;
        }
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
      if (Object.keys(task.metadata).length === 0) {
        task.metadata = undefined;
      }
      // Enforce after the merge so the cap reflects the persisted
      // size, not just the incoming delta.
      assertMetadataWithinLimit(task.metadata);
    }

    await atomicWriteJSON(taskPath, task);

    notifyTasksUpdated(teamName);
    return task;
  } finally {
    await release?.();
  }
}

/**
 * Delete a task file.
 *
 * Cleans up reciprocal dependency edges first so dependents don't end
 * up permanently blocked by a phantom id. Without this, deleting a
 * task X that appears in another task's `blockedBy` (or whose own
 * `blocks` list points to other tasks) would leave the deleted id in
 * those neighbors — and `tryAutoClaimTask` skips any task with a
 * non-empty `blockedBy`, so a dependent becomes unclaimable forever.
 *
 * Acquires the same per-task lock that `updateTask` uses so a
 * concurrent read-modify-write cycle can't write back to a path
 * we just unlinked (which would resurrect the task with stale
 * data). Lock-acquisition failures with ENOENT are treated as
 * already-deleted.
 */
export async function deleteTask(
  teamName: string,
  taskId: string,
  opts?: { callerName?: string },
): Promise<boolean> {
  // Read the task's edges first so we can clean up reciprocal references
  // before unlinking the file. This is intentionally outside the file
  // lock to avoid holding multiple per-task locks simultaneously (which
  // would risk deadlock against any concurrent multi-task update).
  const existing = await getTask(teamName, taskId);
  if (existing) {
    // Ownership guard for teammate callers, mirroring `updateTask`. A
    // teammate (callerName set) may only delete its own tasks or unowned
    // ones; the leader (callerName undefined) can delete anything.
    // Without this, `task_update(status:'deleted')` is a hole in the
    // ownership model — the most destructive operation would bypass the
    // guard that every other mutation path enforces.
    if (
      opts?.callerName !== undefined &&
      existing.owner &&
      existing.owner !== opts.callerName
    ) {
      throw new TaskOwnershipError(taskId, opts.callerName, existing.owner);
    }
    const dependentIds = new Set<string>([
      ...existing.blocks,
      ...existing.blockedBy,
    ]);
    dependentIds.delete(taskId);
    await Promise.all(
      Array.from(dependentIds).map((depId) =>
        removeEdgesReferencing(teamName, depId, taskId),
      ),
    );
  }

  const taskPath = getTaskPath(teamName, taskId);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(taskPath, LOCK_OPTIONS);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
  try {
    await fs.unlink(taskPath);
    notifyTasksUpdated(teamName);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  } finally {
    await release();
  }
}

/**
 * Remove `referencedId` from the `blocks` and `blockedBy` arrays of
 * the task at `targetId`. ENOENT (the dependent was deleted in the
 * same window) is ignored.
 */
async function removeEdgesReferencing(
  teamName: string,
  targetId: string,
  referencedId: string,
): Promise<void> {
  const depPath = getTaskPath(teamName, targetId);
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
    const beforeBlocks = task.blocks.length;
    const beforeBlockedBy = task.blockedBy.length;
    task.blocks = task.blocks.filter((id) => id !== referencedId);
    task.blockedBy = task.blockedBy.filter((id) => id !== referencedId);
    if (
      task.blocks.length === beforeBlocks &&
      task.blockedBy.length === beforeBlockedBy
    ) {
      return;
    }
    await atomicWriteJSON(depPath, task);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return;
    throw err;
  } finally {
    await release?.();
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
  } catch (err) {
    // ENOENT is the legitimate "no tasks dir yet" case. Anything
    // else (EACCES, EIO, ENOTDIR, ELOOP, ...) means the disk is
    // unreadable — surface it instead of pretending the board is
    // empty, otherwise the leader sees no tasks while in-flight
    // work is invisible.
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    const errMsg = err instanceof Error ? err.message : String(err);
    debug.warn(`Failed to list tasks dir ${dir}: ${errMsg}`);
    throw err instanceof Error ? err : new Error(errMsg);
  }

  const jsonEntries = entries.filter((e) => e.endsWith('.json'));
  const reads = await Promise.all(
    jsonEntries.map(async (entry) => {
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        if (raw.trim() === '') {
          // A task file that exists but is momentarily empty is a
          // create in flight: `createTask` claims the id with an
          // O_CREAT|O_EXCL open and then writes the content as a
          // second step, so a concurrent readdir+readFile can land in
          // that sub-millisecond window. Skip it WITHOUT quarantining
          // — the next `listTasks` (after the write lands) will see it.
          // Quarantining here would rename the file out from under the
          // in-progress create and lose the task entirely.
          return undefined;
        }
        return JSON.parse(raw) as SwarmTask;
      } catch (err) {
        // ENOENT is fine — the file may have been deleted between
        // the readdir and the readFile (e.g. a concurrent
        // `task_update(status: 'deleted')`). Anything else means
        // the file is corrupt or unreadable; quarantine it so it
        // stops silently disappearing from `task_list` (and so the
        // next `listTasks` call doesn't keep failing on the same
        // file). Renamed out of the `.json` suffix so subsequent
        // scans skip it.
        if (isNodeError(err) && err.code === 'ENOENT') return undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        debug.warn(`Quarantining corrupt task file ${filePath}: ${errMsg}`);
        const quarantined = `${filePath}.corrupt-${Date.now()}`;
        try {
          await fs.rename(filePath, quarantined);
        } catch (renameErr) {
          const renameMsg =
            renameErr instanceof Error ? renameErr.message : String(renameErr);
          debug.warn(`Failed to quarantine ${filePath}: ${renameMsg}`);
        }
        return undefined;
      }
    }),
  );
  const tasks = reads.filter((t): t is SwarmTask => t !== undefined);

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
        const before = task.blockedBy.length;
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        if (task.blockedBy.length === before) return;
        await atomicWriteJSON(depPath, task);
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

    await atomicWriteJSON(taskPath, task);

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
  const owned = inProgress.filter(
    (task) => task.owner === agentId || task.owner === bareName,
  );
  await Promise.all(
    owned.map((task) =>
      updateTask(teamName, task.id, { status: 'pending', owner: null }),
    ),
  );
  return owned.length;
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
