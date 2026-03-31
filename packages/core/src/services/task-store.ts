/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: TaskPriority;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  output?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  parentTaskId?: string | null; // null = root tasks only
  createdBy?: string;
}

export class TaskStore {
  private tasks: Map<string, Task> = new Map();
  private persistPath: string;

  constructor(runtimeDir: string, sessionId: string) {
    this.persistPath = path.join(runtimeDir, 'tasks', `${sessionId}.json`);
    this.load();
  }

  create(params: {
    title: string;
    description?: string;
    parentTaskId?: string;
    priority?: TaskPriority;
    createdBy?: string;
  }): Task {
    const task: Task = {
      id: randomUUID().slice(0, 8),
      parentTaskId: params.parentTaskId,
      title: params.title,
      description: params.description,
      status: 'pending',
      priority: params.priority,
      createdBy: params.createdBy ?? 'agent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: TaskFilter): Task[] {
    let tasks = Array.from(this.tasks.values());
    if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }
    if (filter?.parentTaskId !== undefined) {
      tasks = tasks.filter((t) =>
        filter.parentTaskId === null
          ? !t.parentTaskId
          : t.parentTaskId === filter.parentTaskId,
      );
    }
    if (filter?.createdBy) {
      tasks = tasks.filter((t) => t.createdBy === filter.createdBy);
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  update(
    id: string,
    updates: Partial<
      Pick<Task, 'status' | 'title' | 'description' | 'priority'>
    >,
  ): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: Date.now() });
    if (updates.status === 'completed') task.completedAt = Date.now();
    this.save();
    return task;
  }

  stop(id: string, reason?: string): Task[] {
    const stopped: Task[] = [];
    const task = this.tasks.get(id);
    if (!task) return stopped;
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    if (reason) task.output = reason;
    stopped.push(task);
    // Cascade to subtasks
    for (const child of this.list({ parentTaskId: id })) {
      if (child.status !== 'completed' && child.status !== 'cancelled') {
        stopped.push(...this.stop(child.id, `Parent task ${id} cancelled`));
      }
    }
    this.save();
    return stopped;
  }

  setOutput(id: string, output: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.output = output;
    task.updatedAt = Date.now();
    this.save();
    return task;
  }

  getSubtaskCount(id: string): number {
    return this.list({ parentTaskId: id }).length;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
        for (const task of data) this.tasks.set(task.id, task);
      }
    } catch {
      /* fresh start */
    }
  }

  private save(): void {
    const dir = path.dirname(this.persistPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.persistPath,
      JSON.stringify(Array.from(this.tasks.values()), null, 2),
    );
  }
}
