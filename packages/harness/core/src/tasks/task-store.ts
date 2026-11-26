/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { ZodError } from 'zod';
import { isNodeError } from '../utils/errors.js';
import { sanitizeTaskPathSegment } from './task-list-id.js';
import {
  TaskListItemSchema,
  type CreateTaskInput,
  type TaskListChange,
  type TaskListItem,
  type UpdateTaskInput,
} from './task-list-types.js';

const storesChanged = new EventEmitter();
storesChanged.setMaxListeners(100);

/** True for a persisted task file (`<id>.json`), excluding dotfiles. */
function isTaskFileEntry(entry: Dirent): boolean {
  return (
    entry.isFile() &&
    entry.name.endsWith('.json') &&
    !entry.name.startsWith('.')
  );
}

function parseDecimalTaskId(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function compareLockPaths(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface TaskMutationContext {
  getTask(): Promise<TaskListItem | null>;
  updateTask(updates: UpdateTaskInput): Promise<TaskListItem | null>;
  deleteTask(): Promise<boolean>;
}

export class TaskStore {
  readonly taskListDir: string;
  private readonly lockPath: string;
  private readonly taskLocksDir: string;
  private readonly highWatermarkPath: string;

  constructor(
    tasksRootDir: string,
    readonly taskListId: string,
  ) {
    this.taskListDir = path.join(tasksRootDir, taskListId);
    this.lockPath = path.join(this.taskListDir, '.lock');
    this.taskLocksDir = path.join(this.taskListDir, '.task-locks');
    this.highWatermarkPath = path.join(this.taskListDir, '.highwatermark');
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.taskListDir, { recursive: true, mode: 0o700 });
  }

  private taskPath(taskId: string): string {
    return path.join(this.taskListDir, `${sanitizeTaskPathSegment(taskId)}.json`);
  }

  private taskLockPath(taskId: string): string {
    return path.join(
      this.taskLocksDir,
      `${sanitizeTaskPathSegment(taskId)}.lease`,
    );
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await this.ensureDirectory();
    await fs.writeFile(this.lockPath, '', { flag: 'a', mode: 0o600 });
    return lock(this.lockPath, {
      retries: {
        retries: 30,
        minTimeout: 5,
        maxTimeout: 100,
      },
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireTaskLock(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    await fs.mkdir(this.taskLocksDir, { recursive: true, mode: 0o700 });
    const lockPath = this.taskLockPath(taskId);
    await fs.writeFile(lockPath, '', { flag: 'a', mode: 0o600 });

    for (;;) {
      signal?.throwIfAborted();
      try {
        return await lock(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ELOCKED') throw error;
      }
      await delay(25, undefined, signal ? { signal } : undefined);
    }
  }

  private async releaseTaskLocks(
    releases: Array<() => Promise<void>>,
  ): Promise<void> {
    const releaseErrors: unknown[] = [];
    for (const release of releases.reverse()) {
      try {
        await release();
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    if (releaseErrors.length > 0) throw releaseErrors[0];
  }

  private async withTaskLocks<T>(
    taskIds: readonly string[],
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const orderedLocks = [
      ...new Map(
        taskIds.map((taskId) => [this.taskLockPath(taskId), taskId]),
      ).entries(),
    ].sort(compareLockPaths);
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const [, taskId] of orderedLocks) {
        releases.push(await this.acquireTaskLock(taskId, signal));
      }
      return await operation();
    } finally {
      await this.releaseTaskLocks(releases);
    }
  }

  async withTaskMutation<T>(
    taskId: string,
    operation: (context: TaskMutationContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withTaskLocks(
      [taskId],
      () =>
        operation({
          getTask: () => this.getTask(taskId),
          updateTask: (updates) =>
            this.updateTaskWithinMutation(taskId, updates),
          deleteTask: () => this.deleteTaskWithinMutation(taskId),
        }),
      signal,
    );
  }

  private async writeFileAtomic(
    filePath: string,
    content: string,
  ): Promise<void> {
    await this.ensureDirectory();
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  private async writeTask(task: TaskListItem): Promise<void> {
    const validated = TaskListItemSchema.parse(task);
    await this.writeFileAtomic(
      this.taskPath(validated.id),
      `${JSON.stringify(validated, null, 2)}\n`,
    );
  }

  private emitChange(change: Omit<TaskListChange, 'taskListId'>): void {
    storesChanged.emit(this.taskListDir, {
      ...change,
      taskListId: this.taskListId,
    } satisfies TaskListChange);
  }

  onDidChange(listener: (change: TaskListChange) => void): () => void {
    storesChanged.on(this.taskListDir, listener);
    return () => storesChanged.off(this.taskListDir, listener);
  }

  async watch(onChange: () => void): Promise<() => void> {
    await this.ensureDirectory();
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(this.taskListDir, { persistent: false }, () => {
        onChange();
      });
    } catch {
      return () => {};
    }
    return () => watcher?.close();
  }

  async getTask(taskId: string): Promise<TaskListItem | null> {
    try {
      const content = await fs.readFile(this.taskPath(taskId), 'utf8');
      return TaskListItemSchema.parse(JSON.parse(content));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError || error instanceof ZodError) return null;
      throw error;
    }
  }

  async listTasks(): Promise<TaskListItem[]> {
    await this.ensureDirectory();
    const entries = await fs.readdir(this.taskListDir, { withFileTypes: true });
    const ids = entries
      .filter(isTaskFileEntry)
      .map((entry) => entry.name.slice(0, -5))
      .sort((left, right) => Number(left) - Number(right));
    const tasks = await Promise.all(ids.map((id) => this.getTask(id)));
    return tasks.filter((task): task is TaskListItem => task !== null);
  }

  private async observeHighestAllocatedId(): Promise<number> {
    const entries = await fs.readdir(this.taskListDir, {
      withFileTypes: true,
    });
    return entries.reduce((maximum, entry) => {
      if (!isTaskFileEntry(entry)) return maximum;
      const observed = parseDecimalTaskId(entry.name.slice(0, -5));
      return observed === undefined ? maximum : Math.max(maximum, observed);
    }, 0);
  }

  private async allocateId(): Promise<string> {
    const persisted = await fs
      .readFile(this.highWatermarkPath, 'utf8')
      .then((value) => Number.parseInt(value.trim(), 10))
      .catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') return 0;
        throw error;
      });
    const observed = await this.observeHighestAllocatedId();
    const nextId =
      Math.max(Number.isFinite(persisted) ? persisted : 0, observed) + 1;
    await this.writeFileAtomic(this.highWatermarkPath, `${nextId}\n`);
    return String(nextId);
  }

  async createTask(input: CreateTaskInput): Promise<TaskListItem> {
    const task = await this.withLock(async () => {
      const id = await this.allocateId();
      const created: TaskListItem = {
        id,
        ...(input.businessInfo
          ? { businessInfo: { ...input.businessInfo } }
          : {}),
        subject: input.subject,
        description: input.description,
        ...(input.activeForm !== undefined
          ? { activeForm: input.activeForm }
          : {}),
        status: 'pending',
        blocks: [],
        blockedBy: [],
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      await this.writeTask(created);
      return created;
    });
    this.emitChange({ operation: 'create', taskId: task.id });
    return task;
  }

  private mergeMetadata(
    current: Record<string, unknown> | undefined,
    updates: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...current };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  async updateTask(
    taskId: string,
    updates: UpdateTaskInput,
  ): Promise<TaskListItem | null> {
    return this.withTaskMutation(taskId, (mutation) =>
      mutation.updateTask(updates),
    );
  }

  private async updateTaskWithinMutation(
    taskId: string,
    updates: UpdateTaskInput,
  ): Promise<TaskListItem | null> {
    const updated = await this.withLock(async () => {
      const current = await this.getTask(taskId);
      if (!current) throw new Error(`Task ${taskId} not found`);
      if (updates.status === 'deleted') {
        await this.deleteTaskLocked(current);
        return null;
      }

      const next: TaskListItem = {
        ...current,
        ...(updates.businessInfo
          ? { businessInfo: { ...updates.businessInfo } }
          : {}),
        ...(updates.subject !== undefined ? { subject: updates.subject } : {}),
        ...(updates.description !== undefined
          ? { description: updates.description }
          : {}),
        ...(updates.activeForm !== undefined
          ? { activeForm: updates.activeForm }
          : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.owner !== undefined && updates.owner !== null
          ? { owner: updates.owner }
          : {}),
        ...(updates.metadata !== undefined
          ? { metadata: this.mergeMetadata(current.metadata, updates.metadata) }
          : {}),
      };
      if (updates.owner === null) {
        delete next.owner;
      }

      const addBlocks = [...new Set(updates.addBlocks ?? [])];
      const addBlockedBy = [...new Set(updates.addBlockedBy ?? [])];
      const relatedIds = [...new Set([...addBlocks, ...addBlockedBy])];
      const related = new Map<string, TaskListItem>();
      for (const relatedId of relatedIds) {
        const relatedTask = await this.getTask(relatedId);
        if (relatedTask) related.set(relatedId, relatedTask);
      }

      next.blocks = [
        ...new Set([
          ...next.blocks,
          ...addBlocks.filter((id) => related.has(id)),
        ]),
      ];
      next.blockedBy = [
        ...new Set([
          ...next.blockedBy,
          ...addBlockedBy.filter((id) => related.has(id)),
        ]),
      ];
      await this.writeTask(next);

      for (const blockedId of addBlocks) {
        const blocked = related.get(blockedId);
        if (!blocked) continue;
        blocked.blockedBy = [...new Set([...blocked.blockedBy, taskId])];
        await this.writeTask(blocked);
      }
      for (const blockerId of addBlockedBy) {
        const blocker = related.get(blockerId);
        if (!blocker) continue;
        blocker.blocks = [...new Set([...blocker.blocks, taskId])];
        await this.writeTask(blocker);
      }
      return TaskListItemSchema.parse(next);
    });
    this.emitChange({
      operation: updated ? 'update' : 'delete',
      taskId,
    });
    return updated;
  }

  private async deleteTaskLocked(task: TaskListItem): Promise<void> {
    const relatedIds = [...new Set([...task.blocks, ...task.blockedBy])];
    for (const relatedId of relatedIds) {
      const related = await this.getTask(relatedId);
      if (!related) continue;
      related.blocks = related.blocks.filter((id) => id !== task.id);
      related.blockedBy = related.blockedBy.filter((id) => id !== task.id);
      await this.writeTask(related);
    }
    await fs.unlink(this.taskPath(task.id));
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.withTaskMutation(taskId, (mutation) => mutation.deleteTask());
  }

  private async deleteTaskWithinMutation(taskId: string): Promise<boolean> {
    const deleted = await this.withLock(async () => {
      const task = await this.getTask(taskId);
      if (!task) return false;
      await this.deleteTaskLocked(task);
      return true;
    });
    if (deleted) this.emitChange({ operation: 'delete', taskId });
    return deleted;
  }

  async clearCompletedTasks(): Promise<number> {
    const candidates = await this.listTasks();
    if (
      candidates.length === 0 ||
      candidates.some((task) => task.status !== 'completed')
    ) {
      return 0;
    }
    const candidateIds = new Set(candidates.map((task) => task.id));
    const deletedIds = await this.withTaskLocks(
      [...candidateIds],
      () =>
        this.withLock(async () => {
          const tasks = await this.listTasks();
          if (
            tasks.length !== candidateIds.size ||
            tasks.some(
              (task) =>
                task.status !== 'completed' || !candidateIds.has(task.id),
            )
          ) {
            return [];
          }
          for (const task of tasks) await this.deleteTaskLocked(task);
          return tasks.map((task) => task.id);
        }),
    );
    if (deletedIds.length > 0) this.emitChange({ operation: 'clear' });
    return deletedIds.length;
  }
}
