/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live.
 */

import { randomUUID } from 'node:crypto';
import type { ProactiveConfig } from '../config.js';
import {
  QWEN_REALTIME_INPUT_SAMPLE_RATE,
  QWEN_REALTIME_LIMITS,
} from '../realtime/realtime-session.js';
import {
  DashScopeRealtimeMonitor,
  type DashScopeRealtimeMonitorCallbacks,
  type DashScopeRealtimeMonitorOptions,
  type ProactiveRealtimeMonitor,
} from './realtime-monitor.js';
import {
  buildMonitorInstruction,
  formatProactiveEvent,
  type MonitorEvaluationResult,
} from './monitor-protocol.js';
import {
  ProactiveTaskManager,
  type CreateMonitorInput,
  type CreateNarrationInput,
  type CreateTimerInput,
  type PerceptionTask,
  type ProactiveTask,
  type TaskSelector,
  type UpdateTaskInput,
} from './task-manager.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

interface MediaEvidence {
  vision: number[];
  visionStartedAt?: number;
  audio: Array<{ capturedAt: number; bytes: number }>;
}

interface RepeatState {
  cooldownUntil: number;
  awaitingFalse: boolean;
}

interface TimerRecord {
  generation: number;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ProactiveDelivery {
  taskId: string;
  taskGeneration: number;
  deliveryId: string;
  event: string;
}

interface DeliveryRecord {
  delivery: ProactiveDelivery;
  status: 'queued' | 'announcing';
}

export interface ProactiveSchedulerRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
}

export interface ProactiveSchedulerOptions {
  config: ProactiveConfig;
  realtime: ProactiveSchedulerRealtimeConfig;
  onEvent: (delivery: ProactiveDelivery) => boolean;
  onDeliveryInvalidated?: (delivery: ProactiveDelivery) => void;
  /** Called exactly once when a task first enters the failed state. */
  onTaskFailed?: (task: ProactiveTask, error: string) => void;
  onTaskChanged?: (
    task: ProactiveTask,
    notification?: 'queued' | 'speaking' | 'delivered',
  ) => void;
  captureVision?: () => Promise<string | undefined>;
  createMonitor?: (
    options: DashScopeRealtimeMonitorOptions,
    callbacks: DashScopeRealtimeMonitorCallbacks,
  ) => ProactiveRealtimeMonitor;
  now?: () => number;
  debug?: (event: string, details: Record<string, unknown>) => void;
}

/** The call-scoped surface consumed by LiveSession and its tests. */
export interface ProactiveSchedulerControl {
  createPerceptionMonitor(input: CreateMonitorInput): ProactiveTask;
  createLiveNarration(input: CreateNarrationInput): ProactiveTask;
  createTimer(input: CreateTimerInput): ProactiveTask;
  updateTask(input: UpdateTaskInput): ProactiveTask;
  cancelTasks(selector: TaskSelector): ProactiveTask[];
  listTasks(): ProactiveTask[];
  feedAudio(pcm16: Uint8Array): void;
  feedImage(jpegBase64: string): void;
  resetVisualSource(): void;
  announcementStarted(delivery: ProactiveDelivery): void;
  deferDelivery(delivery: ProactiveDelivery): boolean;
  acknowledgeDelivery(delivery: ProactiveDelivery): void;
  failDelivery(delivery: ProactiveDelivery, error: string): void;
  dispose(): void;
}

export class ProactiveScheduler implements ProactiveSchedulerControl {
  private readonly manager: ProactiveTaskManager;
  private readonly monitors = new Map<string, ProactiveRealtimeMonitor>();
  private readonly evidence = new Map<string, MediaEvidence>();
  private readonly visualCaptureFailures = new Map<string, number>();
  private readonly repeats = new Map<string, RepeatState>();
  private readonly timers = new Map<string, TimerRecord>();
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private readonly deliveryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly createMonitor: NonNullable<
    ProactiveSchedulerOptions['createMonitor']
  >;
  private readonly now: () => number;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private visionTimer: ReturnType<typeof setInterval> | undefined;
  private visionCaptureInFlight = false;
  private lastVisionAt = 0;
  private disposed = false;
  private readonly diagnosticStates = new Map<string, string>();

  constructor(private readonly options: ProactiveSchedulerOptions) {
    this.manager = new ProactiveTaskManager(
      options.config.scheduler.maxConcurrentTasks,
      (task) => this.notifyTask(task),
    );
    this.createMonitor =
      options.createMonitor ??
      ((monitorOptions, callbacks) =>
        new DashScopeRealtimeMonitor(monitorOptions, callbacks));
    this.now = options.now ?? Date.now;
    this.startLoops();
  }

  createPerceptionMonitor(input: CreateMonitorInput): ProactiveTask {
    this.ensureActive();
    const task = this.manager.createMonitor(input);
    this.installMonitor(task);
    return this.manager.get(task.taskId) ?? task;
  }

  createLiveNarration(input: CreateNarrationInput): ProactiveTask {
    this.ensureActive();
    const task = this.manager.createNarration(input);
    this.installMonitor(task);
    return this.manager.get(task.taskId) ?? task;
  }

  createTimer(input: CreateTimerInput): ProactiveTask {
    this.ensureActive();
    const task = this.manager.createTimer(input);
    const running = this.manager.mutate(
      task.taskId,
      task.generation,
      (current) => {
        if (current.status !== 'provisioning') return false;
        current.status = 'running';
        return true;
      },
    );
    if (!running) {
      throw new Error('Timer left provisioning before it could be activated.');
    }
    this.armTimer(task);
    this.notifyTask(this.manager.get(task.taskId)!);
    return this.manager.get(task.taskId) ?? running;
  }

  updateTask(input: UpdateTaskInput): ProactiveTask {
    this.ensureActive();
    const before = this.manager.listActive();
    const updated = this.manager.update(input);
    const previous = before.find((task) => task.taskId === updated.taskId);
    this.invalidateDeliveries(new Set([updated.taskId]));
    if (updated.taskType === 'time_reminder') {
      const record = this.timers.get(updated.taskId);
      if (
        record &&
        previous?.taskType === 'time_reminder' &&
        previous.durationSec === updated.durationSec
      ) {
        record.generation = updated.generation;
      } else {
        this.clearTimer(updated.taskId);
        this.armTimer(updated);
      }
      return this.manager.get(updated.taskId) ?? updated;
    }
    this.closeMonitor(updated.taskId);
    this.visualCaptureFailures.delete(updated.taskId);
    this.repeats.delete(updated.taskId);
    const current = this.manager.mutate(
      updated.taskId,
      updated.generation,
      (candidate) => {
        if (candidate.status !== 'running') return false;
        candidate.status = 'provisioning';
        return true;
      },
    );
    if (!current || current.taskType !== 'perception_monitor') {
      this.failTask(
        updated.taskId,
        updated.generation,
        'Updated monitor could not enter provisioning.',
      );
      throw new Error('Updated monitor could not enter provisioning.');
    }
    this.installMonitor(current);
    return this.manager.get(updated.taskId) ?? current;
  }

  cancelTasks(selector: TaskSelector): ProactiveTask[] {
    this.ensureActive();
    const cancelled = this.manager.cancel(selector);
    for (const task of cancelled) {
      this.cleanupTask(task.taskId);
    }
    this.invalidateDeliveries(new Set(cancelled.map((task) => task.taskId)));
    return cancelled;
  }

  listTasks(): ProactiveTask[] {
    const pendingCounts = new Map<string, number>();
    for (const { delivery } of this.deliveries.values()) {
      pendingCounts.set(
        delivery.taskId,
        (pendingCounts.get(delivery.taskId) ?? 0) + 1,
      );
    }
    return this.manager.listActive().map((task) => {
      const timer =
        task.taskType === 'time_reminder'
          ? this.timers.get(task.taskId)
          : undefined;
      return {
        ...task,
        pendingDeliveryCount: pendingCounts.get(task.taskId) ?? 0,
        ...(timer
          ? { remainingSec: Math.max(0, (timer.deadline - this.now()) / 1_000) }
          : {}),
      } as ProactiveTask;
    });
  }

  feedAudio(pcm16: Uint8Array): void {
    if (this.disposed || pcm16.byteLength === 0) return;
    const capturedAt = this.now();
    for (const task of this.manager.activePerceptionTasks()) {
      if (
        !task.modalities.includes('audio') ||
        !this.resumeRepeatForMedia(task, capturedAt)
      ) {
        continue;
      }
      const monitor = this.monitors.get(task.taskId);
      if (!monitor?.feedAudio(pcm16)) continue;
      const state = this.evidenceFor(task.taskId);
      state.audio.push({ capturedAt, bytes: pcm16.byteLength });
      this.pruneEvidence(state, capturedAt);
    }
  }

  feedImage(jpegBase64: string): void {
    if (this.disposed || !jpegBase64) return;
    const capturedAt = this.now();
    const minimumGap = 1_000 / this.options.config.vision.fps;
    if (capturedAt - this.lastVisionAt < minimumGap) return;
    const tasks = this.manager
      .activePerceptionTasks()
      .filter(
        (task) =>
          task.modalities.includes('vision') &&
          this.resumeRepeatForMedia(task, capturedAt),
      );
    if (tasks.length === 0) return;
    this.lastVisionAt = capturedAt;
    for (const task of tasks) {
      const monitor = this.monitors.get(task.taskId);
      if (!monitor?.feedImage(jpegBase64)) continue;
      const state = this.evidenceFor(task.taskId);
      this.pruneEvidence(state, capturedAt);
      state.visionStartedAt ??= capturedAt;
      state.vision.push(capturedAt);
    }
  }

  resetVisualSource(): void {
    if (this.disposed) return;
    this.lastVisionAt = 0;
    for (const task of this.manager.activePerceptionTasks()) {
      if (!task.modalities.includes('vision')) continue;
      this.visualCaptureFailures.delete(task.taskId);
      if (!this.monitors.has(task.taskId)) continue;
      this.closeMonitor(task.taskId);
      this.clearTaskEvidence(task.taskId);
      this.installMonitor(task);
    }
  }

  announcementStarted(delivery: ProactiveDelivery): void {
    const current = this.deliveries.get(delivery.deliveryId);
    if (!current || !this.sameDelivery(current.delivery, delivery)) return;
    if (current.status !== 'queued') return;
    current.status = 'announcing';
    this.notifyTaskId(delivery.taskId);
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(delivery.deliveryId);
      this.failDelivery(
        delivery,
        'Proactive announcement playback acknowledgement timed out.',
      );
    }, this.options.config.scheduler.repeat.maxWaitTtsSec * 1_000);
    timer.unref?.();
    this.deliveryTimers.set(delivery.deliveryId, timer);
  }

  deferDelivery(delivery: ProactiveDelivery): boolean {
    const current = this.deliveries.get(delivery.deliveryId);
    if (!current || !this.sameDelivery(current.delivery, delivery))
      return false;
    current.status = 'queued';
    this.notifyTaskId(delivery.taskId);
    this.clearDeliveryTimer(delivery.deliveryId);
    this.debug('proactive.delivery_deferred', {
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
    });
    return true;
  }

  acknowledgeDelivery(delivery: ProactiveDelivery): void {
    const current = this.deliveries.get(delivery.deliveryId);
    if (!current || !this.sameDelivery(current.delivery, delivery)) return;
    const task = this.manager.get(delivery.taskId);
    if (!task || task.generation !== delivery.taskGeneration) return;
    this.clearDeliveryTimer(delivery.deliveryId);
    this.deliveries.delete(delivery.deliveryId);
    this.debug('proactive.delivery_acknowledged', {
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
    });
    if (!task.repeat) {
      this.manager.completeDelivery(task.taskId, task.generation);
      this.cleanupTask(task.taskId);
    }
    this.notifyTaskId(task.taskId, 'delivered');
  }

  failDelivery(delivery: ProactiveDelivery, error: string): void {
    const current = this.deliveries.get(delivery.deliveryId);
    if (!current || !this.sameDelivery(current.delivery, delivery)) return;
    this.failTask(delivery.taskId, delivery.taskGeneration, error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.visionTimer !== undefined) clearInterval(this.visionTimer);
    this.pollTimer = undefined;
    this.visionTimer = undefined;
    for (const task of this.manager.listActive()) {
      this.notifyTask({ ...task, status: 'cancelled', updatedAt: this.now() });
      this.cleanupTask(task.taskId);
    }
    this.invalidateDeliveries();
    this.manager.clear();
    this.diagnosticStates.clear();
  }

  private startLoops(): void {
    this.pollTimer = setInterval(
      () => this.poll(),
      this.options.config.scheduler.evalIntervalSec * 1_000,
    );
    this.pollTimer.unref?.();
    if (this.options.captureVision) {
      this.visionTimer = setInterval(
        () => void this.captureVision(),
        1_000 / this.options.config.vision.fps,
      );
      this.visionTimer.unref?.();
    }
  }

  private async captureVision(): Promise<void> {
    if (this.disposed || this.visionCaptureInFlight) return;
    const now = this.now();
    const tasks = this.manager
      .activePerceptionTasks()
      .filter(
        (task) =>
          task.modalities.includes('vision') &&
          this.resumeRepeatForMedia(task, now),
      );
    if (tasks.length === 0) return;
    this.visionCaptureInFlight = true;
    try {
      const image = await this.options.captureVision?.();
      if (!image || image.trim().length === 0) return;
      this.feedImage(image);
      this.clearVisualCaptureFailures(tasks);
    } catch {
      this.recordVisualCaptureFailure(tasks);
      this.debug('proactive.visual_capture_failed', {
        taskIds: tasks.map((task) => task.taskId),
        reason: 'capture_rejected',
      });
    } finally {
      this.visionCaptureInFlight = false;
    }
  }

  private recordVisualCaptureFailure(tasks: PerceptionTask[]): void {
    const now = this.now();
    for (const expected of tasks) {
      const task = this.manager.get(expected.taskId);
      if (
        !task ||
        task.taskType !== 'perception_monitor' ||
        task.generation !== expected.generation ||
        (task.status !== 'provisioning' && task.status !== 'running') ||
        !task.modalities.includes('vision')
      ) {
        continue;
      }
      const state = this.evidenceFor(task.taskId);
      this.pruneEvidence(state, now);
      if (state.vision.length > 0) continue;
      const failures = (this.visualCaptureFailures.get(task.taskId) ?? 0) + 1;
      this.visualCaptureFailures.set(task.taskId, failures);
      if (failures >= this.options.config.scheduler.maxFailuresPerTask) {
        this.failTask(
          task.taskId,
          task.generation,
          'Maximum visual capture failures exceeded.',
        );
      }
    }
  }

  private clearVisualCaptureFailures(tasks: PerceptionTask[]): void {
    for (const expected of tasks) {
      const task = this.manager.get(expected.taskId);
      if (task?.generation === expected.generation) {
        this.visualCaptureFailures.delete(task.taskId);
      }
    }
  }

  private installMonitor(task: PerceptionTask): void {
    const generation = task.generation;
    let monitor: ProactiveRealtimeMonitor;
    const isCurrentMonitor = (): boolean =>
      this.monitors.get(task.taskId) === monitor;
    try {
      monitor = this.createMonitor(
        {
          endpoint: this.options.realtime.endpoint,
          ...(this.options.realtime.apiKey
            ? { apiKey: this.options.realtime.apiKey }
            : {}),
          model: this.options.realtime.model,
          taskId: task.taskId,
          taskGeneration: generation,
          instruction: buildMonitorInstruction({
            title: task.title,
            taskDescription: task.taskDescription,
            monitorMode: task.monitorMode,
            ...(task.monitorMode === 'always'
              ? { narrationStyle: task.interventionText }
              : {}),
          }),
          monitorMode: task.monitorMode,
          modalities: task.modalities,
          contextWindowSec: {
            vision: this.options.config.vision.windowSizeSec,
            audio: this.options.config.audio.windowSizeSec,
          },
          sessionRecycleEvals: this.options.config.monitor.sessionRecycleEvals,
        },
        {
          onReady: (taskGeneration) => {
            if (!isCurrentMonitor()) return;
            const current = this.manager.mutate(
              task.taskId,
              taskGeneration,
              (candidate) => {
                if (candidate.status !== 'provisioning') return false;
                candidate.status = 'running';
                return true;
              },
            );
            if (current?.status === 'running') {
              this.debug('proactive.task_running', { taskId: task.taskId });
            }
          },
          onResult: (result, taskGeneration) => {
            if (!isCurrentMonitor()) return;
            this.onMonitorResult(task.taskId, taskGeneration, result);
          },
          onLifecycleError: (error, taskGeneration) => {
            if (!isCurrentMonitor()) return;
            this.onMonitorLifecycleError(task.taskId, taskGeneration, error);
          },
          onDebug: (event, details) => {
            if (isCurrentMonitor()) this.debug(event, details);
          },
        },
      );
    } catch (error) {
      this.failMonitorSetup(task.taskId, generation, error);
      return;
    }
    this.monitors.set(task.taskId, monitor);
    this.evidence.set(task.taskId, { vision: [], audio: [] });
    let opening: Promise<void>;
    try {
      opening = monitor.start();
    } catch (error) {
      if (isCurrentMonitor()) {
        this.failMonitorSetup(task.taskId, generation, error);
      }
      return;
    }
    void opening.catch((error: unknown) => {
      if (!isCurrentMonitor()) return;
      this.failMonitorSetup(task.taskId, generation, error);
    });
  }

  private failMonitorSetup(
    taskId: string,
    generation: number,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failTask(taskId, generation, `Monitor setup failed: ${message}`);
  }

  private armTimer(
    task: Extract<ProactiveTask, { taskType: 'time_reminder' }>,
  ): void {
    const deadline = this.now() + task.durationSec * 1_000;
    const record: TimerRecord = {
      generation: task.generation,
      deadline,
    };
    this.timers.set(task.taskId, record);
    this.scheduleTimerSegment(task.taskId, record);
  }

  private scheduleTimerSegment(taskId: string, record: TimerRecord): void {
    if (this.timers.get(taskId) !== record) return;
    const remainingMs = record.deadline - this.now();
    if (remainingMs <= 0) {
      this.fireTimer(taskId, record);
      return;
    }
    record.timer = setTimeout(
      () => this.scheduleTimerSegment(taskId, record),
      Math.min(remainingMs, MAX_TIMEOUT_MS),
    );
    record.timer.unref?.();
  }

  private fireTimer(taskId: string, record: TimerRecord): void {
    if (this.timers.get(taskId) !== record) return;
    this.timers.delete(taskId);
    const task = this.manager.get(taskId);
    if (
      !task ||
      task.taskType !== 'time_reminder' ||
      task.status !== 'running' ||
      task.generation !== record.generation
    ) {
      return;
    }
    this.trigger(task, task.reminderText, ['text']);
  }

  private poll(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const id of this.timers.keys()) this.notifyTaskId(id);
    for (const task of this.manager.activePerceptionTasks()) {
      if (!this.resumeRepeatForMedia(task, now)) {
        this.debugGate(task, 'cooldown', {});
        continue;
      }
      const state = this.evidenceFor(task.taskId);
      this.pruneEvidence(state, now);
      const audioSeconds = this.audioSeconds(state);
      const media = {
        visionFrames: state.vision.length,
        audioSeconds: Math.round(audioSeconds * 100) / 100,
        modalities: task.modalities,
      };
      if (!this.hasWarmEvidence(task, state)) {
        this.debugGate(task, 'waiting_for_media', media);
        continue;
      }
      const accepted =
        this.monitors.get(task.taskId)?.requestEvaluation() ?? false;
      this.debugGate(
        task,
        accepted ? 'evaluation_requested' : 'evaluation_busy',
        media,
      );
    }
  }

  private hasWarmEvidence(task: PerceptionTask, state: MediaEvidence): boolean {
    if (task.modalities.includes('vision')) {
      if (state.vision.length === 0) return false;
      const minimumFrames = Math.ceil(
        this.options.config.vision.minEvalDurationSec *
          this.options.config.vision.fps,
      );
      // Retain the nominal-rate contract, but let slower successful captures
      // warm by elapsed observation time across a continuously fresh window.
      if (
        state.vision.length < minimumFrames &&
        state.vision.at(-1)! - state.visionStartedAt! <
          this.options.config.vision.minEvalDurationSec * 1_000
      ) {
        return false;
      }
    }
    if (task.modalities.includes('audio')) {
      if (state.audio.length === 0) return false;
      const seconds = this.audioSeconds(state);
      if (seconds < this.options.config.audio.minEvalDurationSec) return false;
    }
    return true;
  }

  private audioSeconds(state: MediaEvidence): number {
    return (
      state.audio.reduce((total, input) => total + input.bytes, 0) /
      (QWEN_REALTIME_INPUT_SAMPLE_RATE * 2)
    );
  }

  private onMonitorResult(
    taskId: string,
    generation: number,
    result: MonitorEvaluationResult,
  ): void {
    const task = this.manager.get(taskId);
    if (
      !task ||
      task.taskType !== 'perception_monitor' ||
      task.generation !== generation ||
      task.status !== 'running'
    ) {
      return;
    }
    this.debug('proactive.evaluation_result', {
      taskId,
      generation,
      triggered: result.triggered,
      failed: Boolean(result.error),
      summaryChars: result.summary.length,
      ...(result.ignoredAction ? { ignoredAction: result.ignoredAction } : {}),
    });
    const repeat = this.repeats.get(taskId);
    if (repeat && repeat.cooldownUntil > 0) {
      this.resumeRepeatForMedia(task, this.now());
      return;
    }
    if (result.error) {
      const failed = this.manager.mutate(taskId, generation, (current) => {
        if (current.status !== 'running') return false;
        current.failureCount += 1;
        return true;
      });
      if (
        failed &&
        failed.failureCount >= this.options.config.scheduler.maxFailuresPerTask
      ) {
        this.failTask(taskId, generation, 'Maximum monitor failures exceeded.');
      }
      return;
    }
    this.manager.mutate(taskId, generation, (current) => {
      if (current.status !== 'running') return false;
      current.failureCount = 0;
      return true;
    });
    if (task.repeat && task.monitorMode === 'event' && repeat?.awaitingFalse) {
      if (!result.triggered) repeat.awaitingFalse = false;
      return;
    }
    if (!result.triggered) return;
    this.trigger(task, result.summary, task.modalities);
  }

  private onMonitorLifecycleError(
    taskId: string,
    generation: number,
    error: Error,
  ): void {
    const task = this.manager.get(taskId);
    if (!task || task.generation !== generation) return;
    if (task.status === 'provisioning') {
      this.failTask(
        taskId,
        generation,
        `Monitor setup failed: ${error.message}`,
      );
      return;
    }
    if (task.status === 'running') {
      this.onMonitorResult(taskId, generation, {
        triggered: false,
        summary: '',
        currentState: '',
        error: error.message,
      });
    }
  }

  private trigger(
    task: ProactiveTask,
    summary: string,
    sourceModalities: readonly string[],
  ): void {
    const delivering = this.manager.beginDelivery(
      task.taskId,
      task.generation,
      summary,
    );
    if (!delivering) return;
    const interventionText =
      delivering.taskType === 'perception_monitor'
        ? delivering.interventionText
        : '';
    const deliveryId = `delivery_${randomUUID().replaceAll('-', '')}`;
    const delivery: ProactiveDelivery = {
      taskId: delivering.taskId,
      taskGeneration: delivering.generation,
      deliveryId,
      event: formatProactiveEvent({
        taskId: delivering.taskId,
        deliveryId,
        title: delivering.title,
        taskType: delivering.taskType,
        summary,
        sourceModalities,
        interventionText,
        monitorMode: delivering.monitorMode,
      }),
    };
    if (delivery.event.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars) {
      this.failTask(
        delivering.taskId,
        delivering.generation,
        'Proactive event exceeds the foreground response limit.',
      );
      return;
    }
    this.deliveries.set(deliveryId, { delivery, status: 'queued' });
    this.notifyTaskId(delivering.taskId);
    if (delivering.repeat) {
      this.repeats.set(delivering.taskId, {
        cooldownUntil:
          this.now() + this.options.config.scheduler.repeat.cooldownSec * 1_000,
        awaitingFalse: delivering.monitorMode === 'event',
      });
      this.clearTaskEvidence(delivering.taskId);
      this.monitors.get(delivering.taskId)?.resetPendingCapture();
    } else if (delivering.taskType === 'perception_monitor') {
      this.closeMonitor(delivering.taskId);
      this.evidence.delete(delivering.taskId);
    }
    let accepted = false;
    try {
      accepted = this.options.onEvent(delivery);
    } catch {
      this.debug('proactive.event_delivery_failed', {
        taskId: delivery.taskId,
        deliveryId,
        reason: 'admission_callback_failed',
      });
    }
    if (!accepted) {
      this.failDelivery(delivery, 'Proactive event delivery was rejected.');
      return;
    }
    this.debug('proactive.event_queued', {
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
      generation: delivery.taskGeneration,
    });
  }

  private resumeRepeatForMedia(task: PerceptionTask, now: number): boolean {
    if (task.status === 'provisioning') return true;
    if (task.status !== 'running') return false;
    const repeat = this.repeats.get(task.taskId);
    if (!repeat || repeat.cooldownUntil === 0) return true;
    if (repeat.cooldownUntil > now) return false;
    repeat.cooldownUntil = 0;
    if (this.options.config.scheduler.repeat.clearBufferOnResume) {
      this.clearTaskEvidence(task.taskId);
      this.monitors.get(task.taskId)?.resetPendingCapture();
    }
    return true;
  }

  private evidenceFor(taskId: string): MediaEvidence {
    let state = this.evidence.get(taskId);
    if (!state) {
      state = { vision: [], audio: [] };
      this.evidence.set(taskId, state);
    }
    return state;
  }

  private pruneEvidence(state: MediaEvidence, now: number): void {
    const visionCutoff = now - this.options.config.vision.windowSizeSec * 1_000;
    const audioCutoff = now - this.options.config.audio.windowSizeSec * 1_000;
    state.vision = state.vision.filter(
      (capturedAt) => capturedAt >= visionCutoff,
    );
    if (state.vision.length === 0) state.visionStartedAt = undefined;
    state.audio = state.audio.filter(
      (input) => input.capturedAt >= audioCutoff,
    );
  }

  private clearTaskEvidence(taskId: string): void {
    this.evidence.set(taskId, { vision: [], audio: [] });
  }

  private failTask(
    taskId: string,
    generation: number,
    error: string,
  ): ProactiveTask | undefined {
    const failed = this.manager.fail(taskId, generation, error);
    if (!failed || failed.status !== 'failed') return undefined;
    this.cleanupTask(taskId);
    this.invalidateDeliveries(new Set([taskId]));
    this.notifyTaskFailed(failed, error);
    return failed;
  }

  private notifyTaskFailed(task: ProactiveTask, error: string): void {
    try {
      this.options.onTaskFailed?.(task, error);
    } catch {
      this.debug('proactive.task_failure_callback_failed', {
        taskId: task.taskId,
        reason: 'failure_callback_failed',
      });
    }
  }

  private notifyTaskId(taskId: string, notification?: 'delivered'): void {
    const task = this.manager.get(taskId);
    if (task) this.notifyTask(task, notification);
  }

  private notifyTask(task: ProactiveTask, notification?: 'delivered'): void {
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    const pending = terminal
      ? []
      : [...this.deliveries.values()].filter(
          (record) => record.delivery.taskId === task.taskId,
        );
    const currentNotification = pending.some(
      (record) => record.status === 'announcing',
    )
      ? 'speaking'
      : pending.length
        ? 'queued'
        : notification;
    if (this.options.debug) {
      const stateKey = JSON.stringify([
        task.generation,
        task.status,
        task.triggerCount,
        task.failureCount,
        pending.length,
        currentNotification,
      ]);
      if (this.diagnosticStates.get(`state:${task.taskId}`) !== stateKey) {
        this.diagnosticStates.set(`state:${task.taskId}`, stateKey);
        this.debug('proactive.task_state', {
          taskId: task.taskId,
          generation: task.generation,
          status: task.status,
          taskType: task.taskType,
          triggerCount: task.triggerCount,
          failureCount: task.failureCount,
          pendingDeliveryCount: pending.length,
          notification: currentNotification ?? 'none',
        });
      }
      if (terminal) {
        this.diagnosticStates.delete(`state:${task.taskId}`);
        this.diagnosticStates.delete(`gate:${task.taskId}`);
      }
    }
    if (!this.options.onTaskChanged) return;
    const timer = this.timers.get(task.taskId);
    try {
      this.options.onTaskChanged(
        {
          ...task,
          pendingDeliveryCount: pending.length,
          ...(timer
            ? {
                remainingSec: Math.max(0, (timer.deadline - this.now()) / 1000),
              }
            : {}),
        },
        currentNotification,
      );
    } catch {
      // A read-only UI observer must never change task delivery semantics.
    }
  }

  private cleanupTask(taskId: string): void {
    this.closeMonitor(taskId);
    this.clearTimer(taskId);
    this.evidence.delete(taskId);
    this.visualCaptureFailures.delete(taskId);
    this.repeats.delete(taskId);
    this.diagnosticStates.delete(`state:${taskId}`);
    this.diagnosticStates.delete(`gate:${taskId}`);
  }

  private invalidateDeliveries(taskIds?: ReadonlySet<string>): void {
    const invalidated: ProactiveDelivery[] = [];
    for (const { delivery } of this.deliveries.values()) {
      if (taskIds && !taskIds.has(delivery.taskId)) continue;
      this.deliveries.delete(delivery.deliveryId);
      this.clearDeliveryTimer(delivery.deliveryId);
      invalidated.push(delivery);
    }
    // Retract queued tails before aborting the active head, which can
    // synchronously reopen the Injector and submit its next item.
    for (const delivery of invalidated.reverse()) {
      this.options.onDeliveryInvalidated?.(delivery);
    }
  }

  private closeMonitor(taskId: string): void {
    const monitor = this.monitors.get(taskId);
    this.monitors.delete(taskId);
    monitor?.close();
  }

  private clearTimer(taskId: string): void {
    const record = this.timers.get(taskId);
    this.timers.delete(taskId);
    if (record?.timer !== undefined) clearTimeout(record.timer);
  }

  private clearDeliveryTimer(deliveryId: string): void {
    const timer = this.deliveryTimers.get(deliveryId);
    this.deliveryTimers.delete(deliveryId);
    if (timer !== undefined) clearTimeout(timer);
  }

  private sameDelivery(
    current: ProactiveDelivery | undefined,
    candidate: ProactiveDelivery,
  ): boolean {
    return (
      current?.deliveryId === candidate.deliveryId &&
      current.taskId === candidate.taskId &&
      current.taskGeneration === candidate.taskGeneration
    );
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('The Proactive scheduler is closed.');
  }

  private debug(event: string, details: Record<string, unknown>): void {
    try {
      this.options.debug?.(event, details);
    } catch {
      // Diagnostics must not change task admission or delivery.
    }
  }

  private debugGate(
    task: PerceptionTask,
    reason: string,
    details: Record<string, unknown>,
  ): void {
    if (!this.options.debug) return;
    if (
      !this.monitors.has(task.taskId) ||
      this.manager.get(task.taskId)?.generation !== task.generation
    )
      return;
    const key = `gate:${task.taskId}`;
    const state = `${task.generation}:${reason}`;
    if (this.diagnosticStates.get(key) === state) return;
    this.diagnosticStates.set(key, state);
    this.debug('proactive.evaluation_gate', {
      taskId: task.taskId,
      generation: task.generation,
      reason,
      ...details,
    });
  }
}
