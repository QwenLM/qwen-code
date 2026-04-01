/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
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
  /** Agent ID that has claimed this task. Null = unclaimed. */
  assignee?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  output?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  parentTaskId?: string | null; // null = root tasks only
  createdBy?: string;
  assignee?: string | null; // null = unclaimed only
}

// Maps between our TaskStatus and beads_rust status values.
const STATUS_TO_BR: Record<TaskStatus, string> = {
  pending: 'open',
  in_progress: 'in_progress',
  completed: 'closed',
  blocked: 'deferred',
  cancelled: 'closed',
};

const BR_TO_STATUS: Record<string, TaskStatus> = {
  open: 'pending',
  in_progress: 'in_progress',
  closed: 'completed',
  deferred: 'blocked',
};

// Maps between our TaskPriority and beads_rust numeric priority (0=critical..4=low).
const PRIORITY_TO_BR: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const BR_PRIORITY_TO_OURS: Record<number, TaskPriority> = {
  0: 'critical',
  1: 'high',
  2: 'medium',
  3: 'low',
  4: 'low',
};

interface BrIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  labels?: string[];
  description?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
}

/**
 * TaskStore backed by beads_rust (`br` CLI).
 *
 * Each call shells out to `br` with `--json`. The `.beads/` directory lives
 * inside the project working directory so tasks are per-project and persist
 * across sessions. Falls back to the original in-memory implementation if
 * `br` is not installed.
 */
export class TaskStore {
  private readonly cwd: string;
  private readonly brAvailable: boolean;
  // Fallback in-memory store when br is not installed.
  private fallbackTasks: Map<string, Task> | null = null;
  private fallbackPath: string;

  constructor(runtimeDir: string, _sessionId: string, cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.fallbackPath = path.join(runtimeDir, 'tasks', `${_sessionId}.json`);
    this.brAvailable = this.detectBr();

    if (this.brAvailable) {
      this.ensureInit();
    } else {
      this.fallbackTasks = new Map();
      this.loadFallback();
    }
  }

  private detectBr(): boolean {
    try {
      execFileSync('br', ['version'], {
        stdio: 'pipe',
        timeout: 3000,
        cwd: this.cwd,
      });
      return true;
    } catch {
      return false;
    }
  }

  private ensureInit(): void {
    const beadsDir = path.join(this.cwd, '.beads');
    if (!fs.existsSync(beadsDir)) {
      try {
        this.br(['init']);
      } catch {
        // init may fail if already initialized elsewhere
      }
    }
  }

  /**
   * Execute `br` with given args plus `--json`, return parsed JSON.
   */
  private br(args: string[]): unknown {
    const result = execFileSync('br', [...args, '--json'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      encoding: 'utf8',
      env: { ...process.env, RUST_LOG: 'error', NO_COLOR: '1' },
    });
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  /**
   * Execute `br` without --json for commands that don't support it.
   */
  private brRaw(args: string[]): string {
    return execFileSync('br', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      encoding: 'utf8',
      env: { ...process.env, RUST_LOG: 'error', NO_COLOR: '1' },
    });
  }

  private brIssueToTask(issue: BrIssue): Task {
    return {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      status: BR_TO_STATUS[issue.status] ?? 'pending',
      priority: BR_PRIORITY_TO_OURS[issue.priority] ?? 'medium',
      createdBy: issue.assignee ?? 'agent',
      // Assignee encoded as label: "assignee:<agentId>"
      assignee: issue.labels?.find((l) => l.startsWith('assignee:'))?.slice(9),
      createdAt: issue.created_at
        ? new Date(issue.created_at).getTime()
        : Date.now(),
      updatedAt: issue.updated_at
        ? new Date(issue.updated_at).getTime()
        : Date.now(),
      completedAt: issue.closed_at
        ? new Date(issue.closed_at).getTime()
        : undefined,
      // Labels encode parent task relationship: "parent:<id>"
      parentTaskId: issue.labels
        ?.find((l) => l.startsWith('parent:'))
        ?.slice(7),
    };
  }

  create(params: {
    title: string;
    description?: string;
    parentTaskId?: string;
    priority?: TaskPriority;
    createdBy?: string;
  }): Task {
    if (!this.brAvailable) return this.createFallback(params);

    const args = ['create', '--title', params.title, '--type', 'task'];
    if (params.description) {
      args.push('--description', params.description);
    }
    if (params.priority) {
      args.push('--priority', String(PRIORITY_TO_BR[params.priority]));
    }

    // br create --json returns a flat issue object: {id, title, status, ...}
    const result = this.br(args) as BrIssue;
    const id = result.id;

    if (!id) {
      throw new Error('Failed to create task: no ID returned');
    }

    // Encode parent relationship as a label
    if (params.parentTaskId) {
      try {
        this.brRaw(['label', 'add', id, `parent:${params.parentTaskId}`]);
      } catch {
        /* non-critical */
      }
    }

    // Fetch the created issue to return a full Task
    return (
      this.get(id) ?? {
        id,
        title: params.title,
        description: params.description,
        status: 'pending',
        priority: params.priority,
        createdBy: params.createdBy ?? 'agent',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTaskId: params.parentTaskId,
      }
    );
  }

  get(id: string): Task | undefined {
    if (!this.brAvailable) return this.fallbackTasks?.get(id);

    try {
      // br show --json returns an array of issues
      const result = this.br(['show', id]) as BrIssue[];
      const issue = Array.isArray(result) ? result[0] : result;
      if (!issue) return undefined;
      return this.brIssueToTask(issue);
    } catch {
      return undefined;
    }
  }

  list(filter?: TaskFilter): Task[] {
    if (!this.brAvailable) return this.listFallback(filter);

    try {
      const args = ['list'];

      // Map status filter to br status
      if (filter?.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        const brStatus = statuses.map((s) => STATUS_TO_BR[s]).join(',');
        args.push('--status', brStatus);
      }

      // br list --json returns an array of issues directly
      const result = this.br(args) as BrIssue[];
      const issues = Array.isArray(result) ? result : [];
      let tasks = issues.map((i) => this.brIssueToTask(i));

      // Filter by parent (br doesn't have native parent filtering)
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

      if (filter?.assignee !== undefined) {
        tasks = tasks.filter((t) =>
          filter.assignee === null
            ? !t.assignee
            : t.assignee === filter.assignee,
        );
      }

      return tasks.sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  }

  update(
    id: string,
    updates: Partial<
      Pick<Task, 'status' | 'title' | 'description' | 'priority'>
    >,
  ): Task | undefined {
    if (!this.brAvailable) return this.updateFallback(id, updates);

    try {
      // Handle status transitions that need special br commands
      if (updates.status === 'completed' || updates.status === 'cancelled') {
        const reason = updates.status === 'cancelled' ? 'cancelled' : 'done';
        try {
          this.br(['close', id, '--reason', reason]);
        } catch {
          /* already closed */
        }
      } else if (updates.status === 'pending') {
        try {
          this.br(['reopen', id]);
        } catch {
          /* already open */
        }
      }

      // Apply non-status updates via br update
      const args = ['update', id];
      if (updates.title) args.push('--title', updates.title);
      if (updates.description) args.push('--description', updates.description);
      if (updates.priority) {
        args.push('--priority', String(PRIORITY_TO_BR[updates.priority]));
      }
      if (
        updates.status &&
        updates.status !== 'completed' &&
        updates.status !== 'cancelled' &&
        updates.status !== 'pending'
      ) {
        args.push('--status', STATUS_TO_BR[updates.status]);
      }

      if (args.length > 2) {
        this.br(args);
      }

      return this.get(id);
    } catch {
      return undefined;
    }
  }

  stop(id: string, reason?: string): Task[] {
    if (!this.brAvailable) return this.stopFallback(id, reason);

    const stopped: Task[] = [];
    const task = this.get(id);
    if (!task) return stopped;

    try {
      const closeArgs = ['close', id];
      if (reason) closeArgs.push('--reason', reason);
      this.br(closeArgs);
    } catch {
      /* already closed */
    }

    stopped.push({ ...task, status: 'cancelled' });

    // Cascade to subtasks
    const children = this.list({ parentTaskId: id });
    for (const child of children) {
      if (child.status !== 'completed' && child.status !== 'cancelled') {
        stopped.push(...this.stop(child.id, `Parent task ${id} cancelled`));
      }
    }

    return stopped;
  }

  setOutput(id: string, output: string): Task | undefined {
    if (!this.brAvailable) return this.setOutputFallback(id, output);

    const task = this.get(id);
    if (!task) return undefined;

    try {
      this.brRaw(['comments', 'add', id, output]);
    } catch {
      /* non-critical */
    }

    return { ...task, output };
  }

  /**
   * Claim a task for a specific agent. Sets the assignee and moves to
   * in_progress. Returns the updated task, or undefined if already claimed
   * by another agent or not found.
   */
  claimTask(id: string, agentId: string): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;

    // Already claimed by another agent
    if (task.assignee && task.assignee !== agentId) return undefined;

    if (this.brAvailable) {
      try {
        // Set assignee label
        this.brRaw(['label', 'add', id, `assignee:${agentId}`]);
        // Move to in_progress
        this.br(['update', id, '--status', STATUS_TO_BR.in_progress]);
      } catch {
        /* non-critical */
      }
      return this.get(id);
    }

    // Fallback
    const fallbackTask = this.fallbackTasks!.get(id);
    if (!fallbackTask) return undefined;
    fallbackTask.assignee = agentId;
    fallbackTask.status = 'in_progress';
    fallbackTask.updatedAt = Date.now();
    this.saveFallback();
    return fallbackTask;
  }

  /**
   * Get all pending tasks that have no assignee — available for agents to claim.
   */
  getUnclaimedTasks(): Task[] {
    const pendingTasks = this.list({ status: 'pending' });
    return pendingTasks.filter((t) => !t.assignee);
  }

  getSubtaskCount(id: string): number {
    return this.list({ parentTaskId: id }).length;
  }

  // ── Fallback implementation (when br is not installed) ──────────

  private loadFallback(): void {
    try {
      if (fs.existsSync(this.fallbackPath)) {
        const data = JSON.parse(fs.readFileSync(this.fallbackPath, 'utf8'));
        for (const task of data) this.fallbackTasks!.set(task.id, task);
      }
    } catch {
      /* fresh start */
    }
  }

  private saveFallback(): void {
    const dir = path.dirname(this.fallbackPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.fallbackPath,
      JSON.stringify(Array.from(this.fallbackTasks!.values()), null, 2),
    );
  }

  private createFallback(params: {
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
    this.fallbackTasks!.set(task.id, task);
    this.saveFallback();
    return task;
  }

  private listFallback(filter?: TaskFilter): Task[] {
    let tasks = Array.from(this.fallbackTasks!.values());
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
    if (filter?.assignee !== undefined) {
      tasks = tasks.filter((t) =>
        filter.assignee === null ? !t.assignee : t.assignee === filter.assignee,
      );
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  private updateFallback(
    id: string,
    updates: Partial<
      Pick<Task, 'status' | 'title' | 'description' | 'priority'>
    >,
  ): Task | undefined {
    const task = this.fallbackTasks!.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: Date.now() });
    if (updates.status === 'completed') task.completedAt = Date.now();
    this.saveFallback();
    return task;
  }

  private stopFallback(id: string, reason?: string): Task[] {
    const stopped: Task[] = [];
    const task = this.fallbackTasks!.get(id);
    if (!task) return stopped;
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    if (reason) task.output = reason;
    stopped.push(task);
    for (const child of this.listFallback({ parentTaskId: id })) {
      if (child.status !== 'completed' && child.status !== 'cancelled') {
        stopped.push(
          ...this.stopFallback(child.id, `Parent task ${id} cancelled`),
        );
      }
    }
    this.saveFallback();
    return stopped;
  }

  private setOutputFallback(id: string, output: string): Task | undefined {
    const task = this.fallbackTasks!.get(id);
    if (!task) return undefined;
    task.output = output;
    task.updatedAt = Date.now();
    this.saveFallback();
    return task;
  }
}
