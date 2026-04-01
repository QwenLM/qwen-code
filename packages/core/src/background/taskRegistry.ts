/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface BackgroundTaskState {
  id: string;
  taskType: string;
  title: string;
  projectRoot: string;
  sessionId?: string;
  status: BackgroundTaskStatus;
  createdAt: string;
  updatedAt: string;
  progressText?: string;
  error?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterBackgroundTaskParams {
  id?: string;
  taskType: string;
  title: string;
  projectRoot: string;
  sessionId?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export type BackgroundTaskListener = (task: BackgroundTaskState) => void;

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskState>();
  private readonly listeners = new Set<BackgroundTaskListener>();

  register(params: RegisterBackgroundTaskParams): BackgroundTaskState {
    const now = new Date().toISOString();
    const task: BackgroundTaskState = {
      id: params.id ?? randomUUID(),
      taskType: params.taskType,
      title: params.title,
      projectRoot: params.projectRoot,
      sessionId: params.sessionId,
      dedupeKey: params.dedupeKey,
      metadata: params.metadata,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    return task;
  }

  get(taskId: string): BackgroundTaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  list(projectRoot?: string): BackgroundTaskState[] {
    return [...this.tasks.values()]
      .filter((task) => !projectRoot || task.projectRoot === projectRoot)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((task) => ({ ...task }));
  }

  update(
    taskId: string,
    patch: Partial<Omit<BackgroundTaskState, 'id' | 'createdAt'>>,
  ): BackgroundTaskState {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new Error(`Unknown background task: ${taskId}`);
    }

    const next: BackgroundTaskState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
      metadata:
        patch.metadata === undefined
          ? current.metadata
          : { ...(current.metadata ?? {}), ...patch.metadata },
    };
    this.tasks.set(taskId, next);
    this.emit(next);
    return { ...next };
  }

  subscribe(listener: BackgroundTaskListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(task: BackgroundTaskState): void {
    for (const listener of this.listeners) {
      listener({ ...task });
    }
  }
}
