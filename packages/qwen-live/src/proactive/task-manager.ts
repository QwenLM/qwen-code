/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ProactiveMonitorMode } from './monitor-protocol.js';

export type ProactiveTaskStatus =
  | 'provisioning'
  | 'running'
  | 'delivering'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ProactiveTaskType = 'perception_monitor' | 'time_reminder';
export type ProactiveModality = 'vision' | 'audio';

interface ProactiveTaskBase {
  taskId: string;
  title: string;
  taskType: ProactiveTaskType;
  status: ProactiveTaskStatus;
  monitorMode: ProactiveMonitorMode;
  repeat: boolean;
  generation: number;
  createdAt: number;
  updatedAt: number;
  triggerCount: number;
  failureCount: number;
  lastSummary?: string;
  error?: string;
  pendingDeliveryCount?: number;
}

export interface PerceptionTask extends ProactiveTaskBase {
  taskType: 'perception_monitor';
  modalities: ProactiveModality[];
  taskDescription: string;
  interventionText: string;
}

export interface TimerTask extends ProactiveTaskBase {
  taskType: 'time_reminder';
  monitorMode: 'event';
  repeat: false;
  durationSec: number;
  reminderText: string;
  remainingSec?: number;
}

export type ProactiveTask = PerceptionTask | TimerTask;

export interface CreateMonitorInput {
  title: unknown;
  modalities: unknown;
  condition: unknown;
  triggerResponse: unknown;
  repeat: unknown;
}

export interface CreateNarrationInput {
  title: unknown;
  modalities: unknown;
  narrationFocus: unknown;
  narrationStyle: unknown;
}

export interface CreateTimerInput {
  title: unknown;
  durationSec: unknown;
  reminderText: unknown;
}

export interface TaskSelector {
  targetTitle?: unknown;
  targetTitleContains?: unknown;
  all?: unknown;
}

export interface UpdateTaskInput extends TaskSelector {
  title?: unknown;
  modalities?: unknown;
  condition?: unknown;
  triggerResponse?: unknown;
  narrationFocus?: unknown;
  narrationStyle?: unknown;
  repeat?: unknown;
  durationSec?: unknown;
  reminderText?: unknown;
}

const TERMINAL_STATUSES = new Set<ProactiveTaskStatus>([
  'completed',
  'cancelled',
  'failed',
]);

const MODALITY_ALIASES = new Map<string, ProactiveModality>([
  ['vision', 'vision'],
  ['video', 'vision'],
  ['camera', 'vision'],
  ['image', 'vision'],
  ['visual', 'vision'],
  ['摄像头', 'vision'],
  ['视频', 'vision'],
  ['图像', 'vision'],
  ['视觉', 'vision'],
  ['audio', 'audio'],
  ['microphone', 'audio'],
  ['mic', 'audio'],
  ['sound', 'audio'],
  ['voice', 'audio'],
  ['auditory', 'audio'],
  ['麦克风', 'audio'],
  ['声音', 'audio'],
  ['音频', 'audio'],
  ['语音', 'audio'],
]);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return value;
}

function modalities(value: unknown): ProactiveModality[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('modalities must be a non-empty array.');
  }
  const result: ProactiveModality[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new Error('modalities must contain strings only.');
    }
    const key = raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/gu, ' ');
    const normalized = MODALITY_ALIASES.get(key);
    if (!normalized) {
      throw new Error(`Unsupported Proactive modality: ${raw}.`);
    }
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function copyTask<T extends ProactiveTask>(task: T): T {
  return {
    ...task,
    ...(task.taskType === 'perception_monitor'
      ? { modalities: [...task.modalities] }
      : {}),
  } as T;
}

export class ProactiveTaskManager {
  private readonly tasks = new Map<string, ProactiveTask>();

  constructor(
    private readonly maxConcurrentPerceptionTasks: number,
    private readonly onChange?: (task: ProactiveTask) => void,
  ) {}

  createMonitor(input: CreateMonitorInput): PerceptionTask {
    if (typeof input.repeat !== 'boolean') {
      throw new Error('repeat must be a boolean.');
    }
    return this.createPerception({
      title: text(input.title, 'title'),
      modalities: modalities(input.modalities),
      taskDescription: text(input.condition, 'condition'),
      interventionText: text(input.triggerResponse, 'trigger_response'),
      repeat: input.repeat,
      monitorMode: 'event',
    });
  }

  createNarration(input: CreateNarrationInput): PerceptionTask {
    return this.createPerception({
      title: text(input.title, 'title'),
      modalities: modalities(input.modalities),
      taskDescription: text(input.narrationFocus, 'narration_focus'),
      interventionText: text(input.narrationStyle, 'narration_style'),
      repeat: true,
      monitorMode: 'always',
    });
  }

  createTimer(input: CreateTimerInput): TimerTask {
    const now = Date.now();
    const title = text(input.title, 'title');
    this.assertUniqueTitle(title);
    const task: TimerTask = {
      taskId: this.newTaskId(),
      title,
      taskType: 'time_reminder',
      status: 'provisioning',
      monitorMode: 'event',
      repeat: false,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      triggerCount: 0,
      failureCount: 0,
      durationSec: positiveNumber(input.durationSec, 'duration_sec'),
      reminderText: text(input.reminderText, 'reminder_text'),
    };
    this.tasks.set(task.taskId, task);
    this.onChange?.(copyTask(task));
    return copyTask(task);
  }

  update(input: UpdateTaskInput): ProactiveTask {
    const existing = this.resolveOne(input);
    if (
      existing.status === 'provisioning' ||
      existing.status === 'delivering'
    ) {
      throw new Error(
        `Task is busy (${existing.status}); retry after it settles.`,
      );
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new Error('Only active Proactive tasks can be updated.');
    }
    const patchKeys = Object.keys(input).filter(
      (key) =>
        key !== 'targetTitle' && key !== 'targetTitleContains' && key !== 'all',
    );
    if (patchKeys.length === 0) {
      throw new Error(
        'update_proactive_task needs at least one changed field.',
      );
    }
    const task = copyTask(existing);
    if (input.title !== undefined) {
      const title = text(input.title, 'title');
      this.assertUniqueTitle(title, task.taskId);
      task.title = title;
    }
    if (task.taskType === 'time_reminder') {
      this.rejectPresent(input, [
        'modalities',
        'condition',
        'triggerResponse',
        'narrationFocus',
        'narrationStyle',
        'repeat',
      ]);
      if (input.durationSec !== undefined) {
        task.durationSec = positiveNumber(input.durationSec, 'duration_sec');
      }
      if (input.reminderText !== undefined) {
        task.reminderText = text(input.reminderText, 'reminder_text');
      }
    } else if (task.monitorMode === 'event') {
      this.rejectPresent(input, [
        'narrationFocus',
        'narrationStyle',
        'durationSec',
        'reminderText',
      ]);
      if (input.modalities !== undefined) {
        task.modalities = modalities(input.modalities);
      }
      if (input.condition !== undefined) {
        task.taskDescription = text(input.condition, 'condition');
      }
      if (input.triggerResponse !== undefined) {
        task.interventionText = text(input.triggerResponse, 'trigger_response');
      }
      if (input.repeat !== undefined) {
        if (typeof input.repeat !== 'boolean') {
          throw new Error('repeat must be a boolean.');
        }
        task.repeat = input.repeat;
      }
    } else {
      this.rejectPresent(input, [
        'condition',
        'triggerResponse',
        'repeat',
        'durationSec',
        'reminderText',
      ]);
      if (input.modalities !== undefined) {
        task.modalities = modalities(input.modalities);
      }
      if (input.narrationFocus !== undefined) {
        task.taskDescription = text(input.narrationFocus, 'narration_focus');
      }
      if (input.narrationStyle !== undefined) {
        task.interventionText = text(input.narrationStyle, 'narration_style');
      }
    }
    task.generation += 1;
    task.updatedAt = Date.now();
    task.failureCount = 0;
    task.error = undefined;
    this.tasks.set(task.taskId, task);
    this.onChange?.(copyTask(task));
    return copyTask(task);
  }

  cancel(selector: TaskSelector): ProactiveTask[] {
    if (selector.all === true) {
      if (
        selector.targetTitle !== undefined ||
        selector.targetTitleContains !== undefined
      ) {
        throw new Error('all=true cannot be combined with a title selector.');
      }
      const cancelled: ProactiveTask[] = [];
      for (const task of this.tasks.values()) {
        if (TERMINAL_STATUSES.has(task.status)) continue;
        task.status = 'cancelled';
        task.updatedAt = Date.now();
        task.generation += 1;
        this.onChange?.(copyTask(task));
        cancelled.push(copyTask(task));
      }
      return cancelled;
    }
    if (selector.all !== undefined && selector.all !== false) {
      throw new Error('all must be a boolean.');
    }
    const task = this.resolveOne(selector);
    if (!TERMINAL_STATUSES.has(task.status)) {
      task.status = 'cancelled';
      task.updatedAt = Date.now();
      task.generation += 1;
      this.onChange?.(copyTask(task));
    }
    return [copyTask(task)];
  }

  listActive(): ProactiveTask[] {
    return [...this.tasks.values()]
      .filter((task) => !TERMINAL_STATUSES.has(task.status))
      .map((task) => copyTask(task));
  }

  get(taskId: string): ProactiveTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? copyTask(task) : undefined;
  }

  activePerceptionTasks(): PerceptionTask[] {
    return [...this.tasks.values()]
      .filter(
        (task): task is PerceptionTask =>
          task.taskType === 'perception_monitor' &&
          !TERMINAL_STATUSES.has(task.status),
      )
      .map((task) => copyTask(task));
  }

  mutate(
    taskId: string,
    generation: number,
    mutation: (task: ProactiveTask) => boolean,
  ): ProactiveTask | undefined {
    const current = this.tasks.get(taskId);
    if (!current || current.generation !== generation) return undefined;
    const next = copyTask(current);
    if (!mutation(next)) return undefined;
    next.updatedAt = Date.now();
    this.tasks.set(taskId, next);
    this.onChange?.(copyTask(next));
    return copyTask(next);
  }

  beginDelivery(
    taskId: string,
    generation: number,
    summary?: string,
  ): ProactiveTask | undefined {
    return this.mutate(taskId, generation, (task) => {
      if (task.status !== 'running') return false;
      if (!task.repeat) task.status = 'delivering';
      task.triggerCount += 1;
      task.failureCount = 0;
      if (summary !== undefined) task.lastSummary = summary;
      return true;
    });
  }

  completeDelivery(
    taskId: string,
    generation: number,
  ): ProactiveTask | undefined {
    return this.mutate(taskId, generation, (task) => {
      if (task.status !== 'delivering' || task.repeat) return false;
      task.status = 'completed';
      return true;
    });
  }

  fail(
    taskId: string,
    generation: number,
    error: string,
  ): ProactiveTask | undefined {
    return this.mutate(taskId, generation, (task) => {
      if (TERMINAL_STATUSES.has(task.status)) return false;
      task.status = 'failed';
      task.error = error.slice(0, 300);
      return true;
    });
  }

  clear(): ProactiveTask[] {
    const active = this.listActive();
    this.tasks.clear();
    return active;
  }

  private createPerception(input: {
    title: string;
    modalities: ProactiveModality[];
    taskDescription: string;
    interventionText: string;
    repeat: boolean;
    monitorMode: ProactiveMonitorMode;
  }): PerceptionTask {
    const activeCount = this.activePerceptionTasks().length;
    if (activeCount >= this.maxConcurrentPerceptionTasks) {
      throw new Error(
        `Perception task capacity reached (${this.maxConcurrentPerceptionTasks}); cancel an active task first.`,
      );
    }
    this.assertUniqueTitle(input.title);
    const now = Date.now();
    const task: PerceptionTask = {
      taskId: this.newTaskId(),
      title: input.title,
      taskType: 'perception_monitor',
      status: 'provisioning',
      monitorMode: input.monitorMode,
      repeat: input.repeat,
      modalities: input.modalities,
      taskDescription: input.taskDescription,
      interventionText: input.interventionText,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      triggerCount: 0,
      failureCount: 0,
    };
    this.tasks.set(task.taskId, task);
    this.onChange?.(copyTask(task));
    return copyTask(task);
  }

  private resolveOne(selector: TaskSelector): ProactiveTask {
    const exact =
      selector.targetTitle === undefined
        ? undefined
        : text(selector.targetTitle, 'target_title');
    const partial =
      selector.targetTitleContains === undefined
        ? undefined
        : text(selector.targetTitleContains, 'target_title_contains');
    if (exact !== undefined && partial !== undefined) {
      throw new Error('Provide exactly one task title selector.');
    }
    if (selector.all !== undefined && selector.all !== false) {
      throw new Error('all is valid only for cancel_proactive_task.');
    }
    if (exact === undefined && partial === undefined) {
      throw new Error('No task title selector was provided.');
    }
    const needle = (exact ?? partial ?? '').toLocaleLowerCase();
    const matches = [...this.tasks.values()].filter((task) => {
      if (TERMINAL_STATUSES.has(task.status)) return false;
      const title = task.title.toLocaleLowerCase();
      return exact !== undefined ? title === needle : title.includes(needle);
    });
    if (matches.length === 0) throw new Error('No matching active task.');
    if (matches.length > 1) {
      throw new Error('The title selector is ambiguous; use a unique title.');
    }
    return matches[0] as ProactiveTask;
  }

  private assertUniqueTitle(title: string, excludeTaskId?: string): void {
    const normalized = title.toLocaleLowerCase();
    for (const task of this.tasks.values()) {
      if (
        task.taskId !== excludeTaskId &&
        !TERMINAL_STATUSES.has(task.status) &&
        task.title.toLocaleLowerCase() === normalized
      ) {
        throw new Error(`Active task title '${title}' already exists.`);
      }
    }
  }

  private rejectPresent(input: UpdateTaskInput, fields: string[]): void {
    const invalid = fields.filter(
      (field) => input[field as keyof UpdateTaskInput] !== undefined,
    );
    if (invalid.length > 0) {
      throw new Error(
        `Fields do not apply to this task: ${invalid.join(', ')}.`,
      );
    }
  }

  private newTaskId(): string {
    return `task_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  }
}
