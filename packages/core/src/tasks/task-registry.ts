/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type {
  AgentUnifiedTask,
  BashUnifiedTask,
  InternalAgentUnifiedTask,
  UnifiedTask,
  VideoGenUnifiedTask,
  WorkflowUnifiedTask,
} from './unified-task.js';
import {
  isAgentTask,
  isActiveStatus,
  isInternalAgentTask,
  isTerminalStatus,
} from './unified-task.js';
import type { SubagentProgress } from '../agents/types.js';
import type {
  WorkflowProgressItem,
  WorkflowTerminationReason,
} from '../workflows/workflow-types.js';
import type { Message } from '../protocol/transcript/message.js';

const EVICT_GRACE_MS = 30_000;
const PROGRESS_THROTTLE_MS = 100;
export const MAX_BASH_OUTPUT_SIZE = 10_000_000;
export const BASH_OUTPUT_TRUNCATION_BUFFER = 1_000_000;

export function truncateBashOutput(
  output: string,
  maxSize = MAX_BASH_OUTPUT_SIZE,
  bufferSize = BASH_OUTPUT_TRUNCATION_BUFFER,
): string {
  if (output.length <= maxSize + bufferSize) {
    return output;
  }

  return output.slice(-maxSize);
}

export interface TaskRegistryEvents {
  task_registered: [task: UnifiedTask];
  task_updated: [taskId: string, task: UnifiedTask];
  task_removed: [taskId: string];
}

type UnifiedTaskPatch =
  | Partial<BashUnifiedTask>
  | Partial<AgentUnifiedTask>
  | Partial<WorkflowUnifiedTask>
  | Partial<InternalAgentUnifiedTask>
  | Partial<VideoGenUnifiedTask>;

type AgentSlotWaiter = {
  maxConcurrent: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};

export class TaskRegistry extends EventEmitter {
  private readonly tasks = new Map<string, UnifiedTask>();
  private concurrentAgentSlots = 0;
  private readonly agentSlotWaiters: AgentSlotWaiter[] = [];
  private readonly progressThrottles = new Map<string, number>();
  private readonly progressFlushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly messageThrottles = new Map<string, number>();
  private readonly messageFlushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly transcriptViewerCounts = new Map<string, number>();

  override emit<K extends keyof TaskRegistryEvents>(
    event: K,
    ...args: TaskRegistryEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof TaskRegistryEvents>(
    event: K,
    listener: (...args: TaskRegistryEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof TaskRegistryEvents>(
    event: K,
    listener: (...args: TaskRegistryEvents[K]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  register(task: UnifiedTask): void {
    if (task.type === 'local_bash') {
      task.output = truncateBashOutput(task.output);
    }

    const existing = this.tasks.get(task.id);
    if (existing) {
      this.update(task.id, task);
      return;
    }
    this.tasks.set(task.id, task);
    this.emit('task_registered', task);
  }

  /**
   * Atomically reserves one Agent-tool concurrency slot. The returned release
   * callback is idempotent and must be held until the underlying agent run
   * settles, including when the tool call itself has already backgrounded.
   */
  tryAcquireAgentSlot(maxConcurrent: number): (() => void) | undefined {
    if (this.concurrentAgentSlots >= maxConcurrent) return undefined;
    return this.reserveAgentSlot();
  }

  /**
   * Wait for an Agent-tool concurrency slot without changing the configured
   * limit. Used by UltraCode; ordinary Agent calls retain fail-fast behavior.
   */
  acquireAgentSlot(
    maxConcurrent: number,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const immediate = this.tryAcquireAgentSlot(maxConcurrent);
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) {
      return Promise.reject(agentSlotAbortError(signal));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: AgentSlotWaiter = {
        maxConcurrent,
        signal,
        resolve,
        reject,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.agentSlotWaiters.indexOf(waiter);
          if (index >= 0) this.agentSlotWaiters.splice(index, 1);
          reject(agentSlotAbortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.agentSlotWaiters.push(waiter);
    });
  }

  private reserveAgentSlot(): () => void {
    this.concurrentAgentSlots++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.concurrentAgentSlots = Math.max(0, this.concurrentAgentSlots - 1);
      this.drainAgentSlotWaiters();
    };
  }

  private drainAgentSlotWaiters(): void {
    while (this.agentSlotWaiters.length > 0) {
      const waiter = this.agentSlotWaiters[0];
      if (waiter.signal?.aborted) {
        this.agentSlotWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort!);
        waiter.reject(agentSlotAbortError(waiter.signal));
        continue;
      }
      if (this.concurrentAgentSlots >= waiter.maxConcurrent) return;
      this.agentSlotWaiters.shift();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(this.reserveAgentSlot());
    }
  }

  getConcurrentAgentSlotCount(): number {
    return this.concurrentAgentSlots;
  }

  update(taskId: string, patch: UnifiedTaskPatch): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;

    let updated = { ...existing, ...patch } as UnifiedTask;
    if (updated.type === 'local_bash') {
      updated.output = truncateBashOutput(updated.output);
    }

    if (isTerminalStatus(updated.status) && !updated.endTime) {
      updated.endTime = Date.now();
    }
    if (isTerminalStatus(updated.status)) {
      this.clearProgressFlush(taskId);
      this.clearMessageFlush(taskId);
      if (isAgentTask(updated) && updated.liveMessages?.length) {
        this.emitMessages(taskId, updated, Date.now());
        updated = {
          ...updated,
          inProgressToolUseIds: undefined,
        };
      }
    }

    if (
      isAgentTask(updated) &&
      existing.type !== 'local_bash' &&
      isAgentTask(existing) &&
      existing.retainReason === 'agent-session-view' &&
      updated.retainReason !== 'agent-session-view' &&
      (this.transcriptViewerCounts.get(taskId) ?? 0) === 0 &&
      updated.liveMessages &&
      updated.liveMessages.length > 1
    ) {
      updated = {
        ...updated,
        liveMessages: updated.liveMessages.slice(-1),
      };
    }

    this.tasks.set(taskId, updated);
    this.emit('task_updated', taskId, updated);
  }

  /**
   * Update agent progress with throttling to avoid excessive re-renders.
   * The progress object is stored by reference (not cloned) for efficiency.
   */
  updateProgress(taskId: string, progress: SubagentProgress): void {
    const existing = this.tasks.get(taskId);
    if (!existing || !isAgentTask(existing)) return;

    const now = Date.now();
    const lastUpdate = this.progressThrottles.get(taskId);
    if (lastUpdate !== undefined && now - lastUpdate < PROGRESS_THROTTLE_MS) {
      Object.assign(existing, { progress });
      this.scheduleProgressFlush(taskId, PROGRESS_THROTTLE_MS - (now - lastUpdate));
      return;
    }

    this.clearProgressFlush(taskId);
    this.emitProgress(taskId, { ...existing, progress }, now);
  }

  updateWorkflowProgress(taskId: string, items: WorkflowProgressItem[]): void {
    const existing = this.tasks.get(taskId);
    if (
      !existing ||
      existing.type !== 'local_workflow' ||
      existing.status !== 'running'
    ) {
      return;
    }

    const merged = mergeWorkflowProgress(existing.progress, items);
    const logs = merged
      .filter((item): item is Extract<WorkflowProgressItem, { type: 'workflow_log' }> =>
        item.type === 'workflow_log',
      )
      .map((item) => item.message);
    const usage = computeWorkflowUsage(merged);
    this.update(taskId, {
      progress: merged,
      logs: logs.length > 1000 ? logs.slice(-500) : logs,
      agentCount: usage.agentCount,
      totalTokens: usage.totalTokens,
      totalToolCalls: usage.totalToolCalls,
    } as UnifiedTaskPatch);
  }

  setWorkflowAgentController(
    taskId: string,
    agentKey: string,
    controller: AbortController | undefined,
  ): void {
    const existing = this.tasks.get(taskId);
    if (
      !existing ||
      existing.type !== 'local_workflow' ||
      existing.status !== 'running'
    ) {
      return;
    }

    const agentControllers = { ...existing.agentControllers };
    if (controller) {
      agentControllers[agentKey] = controller;
    } else {
      delete agentControllers[agentKey];
    }
    this.update(taskId, { agentControllers });
  }

  skipWorkflowAgent(taskId: string, agentKey: string): boolean {
    return this.abortWorkflowAgent(taskId, agentKey, 'user-skip');
  }

  retryWorkflowAgent(taskId: string, agentKey: string): boolean {
    return this.abortWorkflowAgent(taskId, agentKey, 'user-retry');
  }

  pauseWorkflow(taskId: string): boolean {
    const existing = this.tasks.get(taskId);
    if (!existing || existing.type !== 'local_workflow') return false;
    if (existing.status !== 'running' || !existing.abortController) return false;

    existing.abortController.abort('workflow-pause');
    this.update(taskId, {
      status: 'paused',
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
      agentControllers: undefined,
    } as UnifiedTaskPatch);
    return true;
  }

  private abortWorkflowAgent(
    taskId: string,
    agentKey: string,
    reason: 'user-skip' | 'user-retry',
  ): boolean {
    const existing = this.tasks.get(taskId);
    if (!existing || existing.type !== 'local_workflow') return false;

    if (existing.status !== 'running') return false;
    const controller = existing.agentControllers?.[agentKey];
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  private scheduleProgressFlush(taskId: string, delay: number): void {
    if (this.progressFlushTimers.has(taskId)) return;

    const timer = setTimeout(() => {
      this.progressFlushTimers.delete(taskId);
      const latest = this.tasks.get(taskId);
      if (!latest || !isAgentTask(latest)) return;
      this.emitProgress(taskId, { ...latest }, Date.now());
    }, Math.max(0, delay));

    const maybeUnref = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    maybeUnref.unref?.();
    this.progressFlushTimers.set(taskId, timer);
  }

  private emitProgress(
    taskId: string,
    task: AgentUnifiedTask,
    timestamp: number,
  ): void {
    this.progressThrottles.set(taskId, timestamp);
    this.tasks.set(taskId, task);
    this.emit('task_updated', taskId, task);
  }

  private clearProgressFlush(taskId: string): void {
    const timer = this.progressFlushTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.progressFlushTimers.delete(taskId);
  }

  /**
   * Retain the live suffix for a transcript viewer while it loads a disk
   * snapshot. The returned release callback is idempotent. Viewers are counted
   * per agent task so multiple mounted views cannot release each other's data.
   */
  acquireTranscriptViewer(taskId: string): () => void {
    const task = this.tasks.get(taskId);
    if (!task || !isAgentTask(task)) return () => {};

    this.transcriptViewerCounts.set(
      taskId,
      (this.transcriptViewerCounts.get(taskId) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = (this.transcriptViewerCounts.get(taskId) ?? 1) - 1;
      if (nextCount > 0) {
        this.transcriptViewerCounts.set(taskId, nextCount);
        return;
      }
      this.transcriptViewerCounts.delete(taskId);
      const latest = this.tasks.get(taskId);
      if (
        latest &&
        isAgentTask(latest) &&
        latest.retainReason !== 'agent-session-view' &&
        latest.outputPath &&
        latest.liveMessages &&
        latest.liveMessages.length > 1
      ) {
        const updated = {
          ...latest,
          liveMessages: latest.liveMessages.slice(-1),
        };
        this.tasks.set(taskId, updated);
        this.emit('task_updated', taskId, updated);
      }
    };
  }

  /**
   * Append one live agent transcript event with throttling. Normally only the
   * newest event is retained to cover the interval before its transcript write
   * commits. An actively viewed independent transcript keeps the suffix that
   * arrived since its disk snapshot; leaving that view collapses it to one.
   * The viewed suffix is intentionally mutated in place to avoid repeatedly
   * copying a growing transcript; `transcriptVersion` is its change signal.
   */
  appendMessage(
    taskId: string,
    message: Message,
    inProgressIds: string[],
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing || !isAgentTask(existing)) return;

    const currentMessages = existing.liveMessages ?? [];
    const retainViewedSuffix =
      existing.retainReason === 'agent-session-view' ||
      (this.transcriptViewerCounts.get(taskId) ?? 0) > 0 ||
      !existing.outputPath;
    let liveMessages: Message[];
    if (retainViewedSuffix) {
      liveMessages = currentMessages;
      const lastIndex = liveMessages.length - 1;
      if (lastIndex >= 0 && liveMessages[lastIndex].uuid === message.uuid) {
        liveMessages[lastIndex] = message;
      } else {
        liveMessages.push(message);
      }
    } else {
      liveMessages = [message];
    }
    const updated: AgentUnifiedTask = {
      ...existing,
      liveMessages,
      inProgressToolUseIds: [...inProgressIds],
      transcriptVersion: (existing.transcriptVersion ?? 0) + 1,
    };

    const now = Date.now();
    const lastUpdate = this.messageThrottles.get(taskId);
    if (lastUpdate !== undefined && now - lastUpdate < PROGRESS_THROTTLE_MS) {
      this.tasks.set(taskId, updated);
      this.scheduleMessageFlush(taskId, PROGRESS_THROTTLE_MS - (now - lastUpdate));
      return;
    }

    this.clearMessageFlush(taskId);
    this.emitMessages(taskId, updated, now);
  }

  private scheduleMessageFlush(taskId: string, delay: number): void {
    if (this.messageFlushTimers.has(taskId)) return;

    const timer = setTimeout(() => {
      this.messageFlushTimers.delete(taskId);
      const latest = this.tasks.get(taskId);
      if (!latest || !isAgentTask(latest)) return;
      this.emitMessages(taskId, { ...latest }, Date.now());
    }, Math.max(0, delay));

    const maybeUnref = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    maybeUnref.unref?.();
    this.messageFlushTimers.set(taskId, timer);
  }

  private emitMessages(
    taskId: string,
    task: AgentUnifiedTask,
    timestamp: number,
  ): void {
    this.messageThrottles.set(taskId, timestamp);
    this.tasks.set(taskId, task);
    this.emit('task_updated', taskId, task);
  }

  flushMessages(taskId: string): void {
    this.clearMessageFlush(taskId);
    const latest = this.tasks.get(taskId);
    if (!latest || !isAgentTask(latest)) return;
    this.emitMessages(taskId, { ...latest }, Date.now());
  }

  private clearMessageFlush(taskId: string): void {
    const timer = this.messageFlushTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.messageFlushTimers.delete(taskId);
  }

  /**
   * Mutate bash task output in place for performance (avoids cloning large strings).
   * Only emits event if `notify` is true (e.g. when the panel is visible).
   */
  updateBashOutput(taskId: string, output: string, notify: boolean): void {
    const existing = this.tasks.get(taskId);
    if (!existing || existing.type !== 'local_bash') return;

    existing.output = truncateBashOutput(output);
    if (notify) {
      this.emit('task_updated', taskId, existing);
    }
  }

  /**
   * Append a bash output delta and keep only a bounded tail in memory.
   * Only emits event if `notify` is true (e.g. when the panel is visible).
   */
  appendBashOutput(taskId: string, chunk: string, notify: boolean): void {
    if (chunk.length === 0) return;
    const existing = this.tasks.get(taskId);
    if (!existing || existing.type !== 'local_bash') return;

    existing.output = truncateBashOutput(existing.output + chunk);
    if (notify) {
      this.emit('task_updated', taskId, existing);
    }
  }

  remove(taskId: string): void {
    if (!this.tasks.has(taskId)) return;
    this.tasks.delete(taskId);
    this.progressThrottles.delete(taskId);
    this.messageThrottles.delete(taskId);
    this.transcriptViewerCounts.delete(taskId);
    this.clearProgressFlush(taskId);
    this.clearMessageFlush(taskId);
    this.emit('task_removed', taskId);
  }

  get(taskId: string): UnifiedTask | undefined {
    return this.tasks.get(taskId);
  }

  getByPublicId(publicId: string): UnifiedTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.publicId === publicId) return task;
    }
    return undefined;
  }

  getByExecutionId(executionId: number): UnifiedTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.executionId === executionId) return task;
    }
    return undefined;
  }

  all(): UnifiedTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Count of running background tasks. Foreground agents
   * (isBackgrounded === false) are excluded so the status bar
   * only reflects genuinely backgrounded work.
   */
  runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        isActiveStatus(task.status) &&
        (!('isBackgrounded' in task) || task.isBackgrounded)
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Evict a terminal-status task after its grace period has elapsed.
   * Returns true if the task was removed.
   */
  evictTerminal(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (!isTerminalStatus(task.status)) return false;
    if (!task.notified) return false;
    if (task.retainReason) return false;
    if ((this.transcriptViewerCounts.get(taskId) ?? 0) > 0) return false;
    // Without a durable transcript this task is the only lossless source for
    // Ctrl+O. Keep it for the session instead of silently degrading history.
    if (isAgentTask(task) && !task.outputPath && task.liveMessages?.length) {
      return false;
    }

    const evictAfter = (task.endTime ?? task.startTime) + EVICT_GRACE_MS;
    if (Date.now() < evictAfter) return false;

    this.remove(taskId);
    return true;
  }

  /**
   * Evict all terminal tasks whose grace period has elapsed.
   */
  evictAllTerminal(): void {
    for (const taskId of [...this.tasks.keys()]) {
      this.evictTerminal(taskId);
    }
  }

  /** Mark a task once its completion notification has been queued. */
  markNotified(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.notified) return;
    this.update(taskId, { notified: true });
  }

  /** Kill a task by claiming its status before aborting it with the first reason. */
  kill(taskId: string, reason: WorkflowTerminationReason = 'unknown'): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalStatus(task.status)) return;
    if (isInternalAgentTask(task) && task.killable === false) return;
    if (task.type === 'local_workflow') {
      const abortController = task.abortController;
      const agentControllers = Object.values(task.agentControllers ?? {});
      this.update(taskId, {
        status: 'killed',
        endTime: Date.now(),
        abortController: undefined,
        agentControllers: undefined,
      });
      abortController?.abort(reason);
      for (const controller of agentControllers) {
        controller.abort(reason);
      }
      return;
    }
    this.update(taskId, { status: 'killed', endTime: Date.now() });
  }

  size(): number {
    return this.tasks.size;
  }

  clear(): void {
    for (const timer of this.progressFlushTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.messageFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.tasks.clear();
    this.concurrentAgentSlots = 0;
    for (const waiter of this.agentSlotWaiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(
        new DOMException('Agent slot wait cancelled', 'AbortError'),
      );
    }
    this.progressThrottles.clear();
    this.progressFlushTimers.clear();
    this.messageThrottles.clear();
    this.messageFlushTimers.clear();
    this.transcriptViewerCounts.clear();
  }
}

function agentSlotAbortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Agent slot wait aborted', 'AbortError');
}

function mergeWorkflowProgress(
  existing: WorkflowProgressItem[],
  incoming: WorkflowProgressItem[],
): WorkflowProgressItem[] {
  const merged: WorkflowProgressItem[] = [];
  const indexes = new Map<string, number>();

  const keyFor = (item: WorkflowProgressItem): string | undefined => {
    if (item.type === 'workflow_log') return undefined;
    return `${item.type}:${item.index}`;
  };

  for (const item of existing) {
    const key = keyFor(item);
    if (key) indexes.set(key, merged.length);
    merged.push(item);
  }

  for (const item of incoming) {
    const key = keyFor(item);
    if (!key) {
      merged.push(item);
      continue;
    }
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(item);
    } else {
      merged[index] = mergeWorkflowProgressItem(merged[index], item);
    }
  }

  const logIndexes = merged
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'workflow_log')
    .map(({ index }) => index);
  if (logIndexes.length <= 1000) return merged;

  const keepLogs = new Set(logIndexes.slice(-500));
  return merged.filter(
    (item, index) => item.type !== 'workflow_log' || keepLogs.has(index),
  );
}

function mergeWorkflowProgressItem(
  previous: WorkflowProgressItem,
  next: WorkflowProgressItem,
): WorkflowProgressItem {
  if (previous.type !== next.type || previous.type === 'workflow_log') {
    return next;
  }
  const definedNextEntries = Object.entries(next).filter(
    ([, value]) => value !== undefined,
  );
  return {
    ...previous,
    ...Object.fromEntries(definedNextEntries),
  } as WorkflowProgressItem;
}

function computeWorkflowUsage(items: WorkflowProgressItem[]): {
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
} {
  const agents = new Set<number>();
  let totalTokens = 0;
  let totalToolCalls = 0;
  for (const item of items) {
    if (item.type !== 'workflow_agent') continue;
    agents.add(item.index);
    totalTokens += item.tokens ?? 0;
    totalToolCalls += item.toolCalls ?? 0;
  }
  return { agentCount: agents.size, totalTokens, totalToolCalls };
}
