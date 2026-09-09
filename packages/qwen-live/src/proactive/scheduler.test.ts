/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROACTIVE_CONFIG, type ProactiveConfig } from '../config.js';
import { Injector } from '../orchestrator/injector.js';
import { QWEN_REALTIME_LIMITS } from '../realtime/realtime-session.js';
import {
  formatProactiveEvent,
  parseMonitorAction,
} from './monitor-protocol.js';
import type {
  DashScopeRealtimeMonitorCallbacks,
  DashScopeRealtimeMonitorOptions,
  ProactiveRealtimeMonitor,
} from './realtime-monitor.js';
import { ProactiveScheduler, type ProactiveDelivery } from './scheduler.js';
import type { ProactiveTask } from './task-manager.js';

class FakeMonitor implements ProactiveRealtimeMonitor {
  audioFrames = 0;
  imageFrames = 0;
  evaluations = 0;
  resets = 0;
  closed = false;
  acceptsEvaluation = true;

  constructor(
    readonly options: DashScopeRealtimeMonitorOptions,
    private readonly callbacks: DashScopeRealtimeMonitorCallbacks,
    private readonly autoReady = true,
    private readonly startFailure?: 'throw' | 'reject',
  ) {}

  start(): Promise<void> {
    if (this.startFailure === 'throw') {
      throw new Error('monitor start threw');
    }
    if (this.startFailure === 'reject') {
      return Promise.reject(new Error('monitor start rejected'));
    }
    if (this.autoReady) {
      this.callbacks.onReady?.(this.options.taskGeneration);
    }
    return Promise.resolve();
  }

  feedAudio(): boolean {
    if (this.closed) return false;
    this.audioFrames += 1;
    return true;
  }

  feedImage(): boolean {
    if (this.closed) return false;
    this.imageFrames += 1;
    return true;
  }

  requestEvaluation(): boolean {
    if (this.closed || !this.acceptsEvaluation) return false;
    this.evaluations += 1;
    return true;
  }

  resetPendingCapture(): void {
    this.resets += 1;
  }

  close(): void {
    this.closed = true;
  }

  result(triggered: boolean, summary = 'condition matched'): void {
    this.callbacks.onResult(
      {
        triggered,
        summary: triggered ? summary : '',
        currentState: triggered ? summary : '',
      },
      this.options.taskGeneration,
    );
  }

  resultError(message: string): void {
    this.callbacks.onResult(
      {
        triggered: false,
        summary: '',
        currentState: '',
        error: message,
      },
      this.options.taskGeneration,
    );
  }

  action(raw: string): void {
    this.callbacks.onResult(
      parseMonitorAction(raw, this.options.monitorMode),
      this.options.taskGeneration,
    );
  }

  lifecycleError(message: string): void {
    this.callbacks.onLifecycleError?.(
      new Error(message),
      this.options.taskGeneration,
    );
  }
}

interface SchedulerHarness {
  scheduler: ProactiveScheduler;
  monitors: FakeMonitor[];
  deliveries: ProactiveDelivery[];
  invalidated: ProactiveDelivery[];
  failures: Array<{ task: ProactiveTask; error: string }>;
}

const activeSchedulers: ProactiveScheduler[] = [];

function config(): ProactiveConfig {
  return structuredClone(DEFAULT_PROACTIVE_CONFIG);
}

function createHarness(
  proactive = config(),
  harnessOptions: {
    autoReady?: boolean;
    acceptDelivery?: boolean;
    captureVision?: () => Promise<string | undefined>;
    createMonitorError?: Error;
    startFailure?: 'throw' | 'reject';
    onEvent?: (delivery: ProactiveDelivery) => boolean;
    onDeliveryInvalidated?: (delivery: ProactiveDelivery) => void;
    onTaskFailed?: (task: ProactiveTask, error: string) => void;
    onTaskChanged?: (
      task: ProactiveTask,
      notification?: 'queued' | 'speaking' | 'delivered',
    ) => void;
    debug?: (event: string, details: Record<string, unknown>) => void;
  } = {},
): SchedulerHarness {
  const monitors: FakeMonitor[] = [];
  const deliveries: ProactiveDelivery[] = [];
  const invalidated: ProactiveDelivery[] = [];
  const failures: Array<{ task: ProactiveTask; error: string }> = [];
  const scheduler = new ProactiveScheduler({
    config: proactive,
    realtime: {
      endpoint: 'https://dashscope.example.test',
      model: 'qwen3.5-omni-plus-realtime',
    },
    onEvent: (delivery) => {
      deliveries.push(delivery);
      return (
        harnessOptions.onEvent?.(delivery) ??
        harnessOptions.acceptDelivery ??
        true
      );
    },
    onDeliveryInvalidated: (delivery) => {
      invalidated.push(delivery);
      harnessOptions.onDeliveryInvalidated?.(delivery);
    },
    onTaskFailed: (task, error) => {
      failures.push({ task, error });
      harnessOptions.onTaskFailed?.(task, error);
    },
    onTaskChanged: harnessOptions.onTaskChanged,
    debug: harnessOptions.debug,
    ...(harnessOptions.captureVision
      ? { captureVision: harnessOptions.captureVision }
      : {}),
    createMonitor: (options, callbacks) => {
      if (harnessOptions.createMonitorError) {
        throw harnessOptions.createMonitorError;
      }
      const monitor = new FakeMonitor(
        options,
        callbacks,
        harnessOptions.autoReady ?? true,
        harnessOptions.startFailure,
      );
      monitors.push(monitor);
      return monitor;
    },
    now: Date.now,
  });
  activeSchedulers.push(scheduler);
  return { scheduler, monitors, deliveries, invalidated, failures };
}

function remainingSec(scheduler: ProactiveScheduler): number | undefined {
  const task = scheduler.listTasks()[0];
  return task?.taskType === 'time_reminder' ? task.remainingSec : undefined;
}

describe('Proactive event admission size', () => {
  it.each([
    'summary',
    'combined',
    'escaped',
    'title',
    'guidance',
    'timer',
  ] as const)(
    'fails an oversized %s event before FIFO admission and still delivers the following small event',
    (source) => {
      const limit = QWEN_REALTIME_LIMITS.maxFunctionOutputChars;
      const requested: string[] = [];
      const injector = new Injector({
        sink: {
          injectContext: () => true,
          injectSpeech: () => true,
          injectProactive: (event) => {
            if (event.length > limit) return false;
            requested.push(event);
            return true;
          },
        },
      });
      const harness = createHarness(config(), {
        onEvent: (delivery) =>
          injector.enqueue({
            kind: 'proactive',
            context: delivery.event,
            deliveryId: delivery.deliveryId,
          }),
      });
      try {
        const title = source === 'title' ? 't'.repeat(limit) : 'Oversized';
        if (source === 'timer') {
          harness.scheduler.createTimer({
            title,
            durationSec: 1,
            reminderText: 'r'.repeat(limit),
          });
          vi.advanceTimersByTime(1000);
        } else {
          const guidance =
            source === 'guidance'
              ? 'g'.repeat(limit)
              : source === 'combined'
                ? 'g'.repeat(20_000)
                : 'Tell me';
          harness.scheduler.createPerceptionMonitor({
            title,
            modalities: ['audio'],
            condition: 'A change occurs',
            triggerResponse: guidance,
            repeat: true,
          });
          const summary =
            source === 'summary'
              ? 's'.repeat(limit)
              : source === 'combined'
                ? 's'.repeat(50_000)
                : source === 'escaped'
                  ? '\\'.repeat(40_000)
                  : 'A short observation';
          harness.monitors[0]!.result(true, summary);
        }
        expect(harness.deliveries).toHaveLength(0);
        expect(harness.failures).toEqual([
          {
            task: expect.objectContaining({ status: 'failed' }),
            error: 'Proactive event exceeds the foreground response limit.',
          },
        ]);
        expect(injector.pendingCount).toBe(0);
        harness.scheduler.createTimer({
          title: 'Small reminder',
          durationSec: 1,
          reminderText: 'Take a break.',
        });
        vi.advanceTimersByTime(1000);
        expect(harness.deliveries).toHaveLength(1);
        expect(requested).toHaveLength(1);
        expect(requested[0]).toContain('Take a break.');
        expect(injector.pendingCount).toBe(0);
      } finally {
        injector.dispose();
      }
    },
  );

  it('admits the exact foreground event limit without truncating it', () => {
    const limit = QWEN_REALTIME_LIMITS.maxFunctionOutputChars;
    const { scheduler, monitors, deliveries, failures } = createHarness();
    const task = scheduler.createPerceptionMonitor({
      title: 'Boundary',
      modalities: ['audio'],
      condition: 'A change occurs',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    const wrapper = formatProactiveEvent({
      taskId: task.taskId,
      deliveryId: `delivery_${'0'.repeat(32)}`,
      title: task.title,
      taskType: task.taskType,
      summary: '',
      sourceModalities: ['audio'],
      interventionText: 'Tell me',
      monitorMode: 'event',
    });
    monitors[0]!.result(true, 's'.repeat(limit - wrapper.length));
    expect(failures).toEqual([]);
    expect(deliveries[0]?.event.length).toBe(limit);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
});

afterEach(() => {
  for (const scheduler of activeSchedulers.splice(0)) scheduler.dispose();
  vi.useRealTimers();
});

describe('ProactiveScheduler', () => {
  it('diagnoses ignored function calls without triggering or failing a task', () => {
    const debug = vi.fn();
    const { scheduler, monitors, deliveries, failures } = createHarness(
      config(),
      { debug },
    );
    const task = scheduler.createPerceptionMonitor({
      title: 'Watch',
      modalities: ['vision'],
      condition: 'A change occurs',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    for (let index = 0; index < 4; index += 1) {
      monitors[0]!.action(
        'Func_call:private acknowledgment\n{"name":"private-tool","intent":"private-intent"}',
      );
    }
    expect(debug).toHaveBeenCalledWith('proactive.evaluation_result', {
      taskId: task.taskId,
      generation: 1,
      triggered: false,
      failed: false,
      summaryChars: 0,
      ignoredAction: 'function_call',
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    expect(deliveries).toEqual([]);
    expect(failures).toEqual([]);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      failureCount: 0,
      triggerCount: 0,
    });
  });

  it('logs actual media and busy gates without repeating an unchanged poll state or exposing content', () => {
    const debug = vi.fn();
    const { scheduler, monitors } = createHarness(config(), { debug });
    const task = scheduler.createPerceptionMonitor({
      title: 'private-title',
      modalities: ['audio'],
      condition: 'private-condition',
      triggerResponse: 'private-guidance',
      repeat: true,
    });
    vi.advanceTimersByTime(4_000);
    expect(
      debug.mock.calls.filter(
        ([event]) => event === 'proactive.evaluation_gate',
      ),
    ).toEqual([
      [
        'proactive.evaluation_gate',
        {
          taskId: task.taskId,
          generation: 1,
          reason: 'waiting_for_media',
          visionFrames: 0,
          audioSeconds: 0,
          modalities: ['audio'],
        },
      ],
    ]);
    scheduler.feedAudio(new Uint8Array(32_000));
    monitors[0]!.acceptsEvaluation = false;
    vi.advanceTimersByTime(4_000);
    expect(debug).toHaveBeenCalledWith('proactive.evaluation_gate', {
      taskId: task.taskId,
      generation: 1,
      reason: 'evaluation_busy',
      visionFrames: 0,
      audioSeconds: 1,
      modalities: ['audio'],
    });
    expect(monitors[0]!.evaluations).toBe(0);
    monitors[0]!.acceptsEvaluation = true;
    vi.advanceTimersByTime(2_000);
    expect(debug).toHaveBeenCalledWith('proactive.evaluation_gate', {
      taskId: task.taskId,
      generation: 1,
      reason: 'evaluation_requested',
      visionFrames: 0,
      audioSeconds: 1,
      modalities: ['audio'],
    });
    expect(monitors[0]!.evaluations).toBe(1);
    for (const secret of [
      'private-title',
      'private-condition',
      'private-guidance',
    ]) {
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    }
  });

  it('logs trigger and real queued, speaking, deferred and delivered states without altering repeat delivery', () => {
    const debug = vi.fn();
    const onTaskChanged = vi.fn();
    const { scheduler, monitors, deliveries, failures } = createHarness(
      config(),
      { debug, onTaskChanged },
    );
    const task = scheduler.createPerceptionMonitor({
      title: 'Private monitor title',
      modalities: ['audio'],
      condition: 'Private monitor condition',
      triggerResponse: 'Private speech guidance',
      repeat: true,
    });
    monitors[0]!.result(true, 'Private observed summary');
    const delivery = deliveries[0]!;
    expect(debug).toHaveBeenCalledWith('proactive.evaluation_result', {
      taskId: task.taskId,
      generation: 1,
      triggered: true,
      failed: false,
      summaryChars: 'Private observed summary'.length,
    });
    expect(debug).toHaveBeenCalledWith('proactive.event_queued', {
      taskId: task.taskId,
      deliveryId: delivery.deliveryId,
      generation: 1,
    });
    scheduler.announcementStarted(delivery);
    vi.advanceTimersByTime(15);
    expect(scheduler.deferDelivery(delivery)).toBe(true);
    vi.advanceTimersByTime(31_000);
    expect(failures).toEqual([]);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      pendingDeliveryCount: 1,
    });
    scheduler.announcementStarted(delivery);
    scheduler.acknowledgeDelivery(delivery);
    const stateLogs = debug.mock.calls
      .filter(([event]) => event === 'proactive.task_state')
      .map(([, details]) => details as Record<string, unknown>);
    expect(
      stateLogs.map((details) => [
        details['notification'],
        details['pendingDeliveryCount'],
      ]),
    ).toEqual([
      ['none', 0],
      ['none', 0],
      ['none', 0],
      ['queued', 1],
      ['speaking', 1],
      ['queued', 1],
      ['speaking', 1],
      ['delivered', 0],
    ]);
    expect(onTaskChanged.mock.calls.at(-1)?.[1]).toBe('delivered');
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      triggerCount: 1,
      pendingDeliveryCount: 0,
    });
    for (const secret of [
      'Private monitor title',
      'Private monitor condition',
      'Private speech guidance',
      'Private observed summary',
    ]) {
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    }
  });

  it('records evaluation failure and rejected admission as safe metadata and clears diagnostics for terminal tasks', () => {
    const debug = vi.fn();
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 1;
    const { scheduler, monitors, failures } = createHarness(proactive, {
      debug,
      onEvent: () => {
        throw new Error('private-admission-payload');
      },
    });
    const monitor = scheduler.createPerceptionMonitor({
      title: 'Secret failure title',
      modalities: ['audio'],
      condition: 'Secret condition',
      triggerResponse: 'Secret trigger',
      repeat: true,
    });
    vi.advanceTimersByTime(2_000);
    monitors[0]!.resultError('private-provider-error');
    expect(debug).toHaveBeenCalledWith('proactive.evaluation_result', {
      taskId: monitor.taskId,
      generation: 1,
      triggered: false,
      failed: true,
      summaryChars: 0,
    });
    expect(debug).toHaveBeenCalledWith('proactive.task_state', {
      taskId: monitor.taskId,
      generation: 1,
      status: 'failed',
      taskType: 'perception_monitor',
      triggerCount: 0,
      failureCount: 1,
      pendingDeliveryCount: 0,
      notification: 'none',
    });
    const timer = scheduler.createTimer({
      title: 'Secret timer',
      durationSec: 1,
      reminderText: 'Secret reminder',
    });
    vi.advanceTimersByTime(1_000);
    expect(debug).toHaveBeenCalledWith('proactive.event_delivery_failed', {
      taskId: timer.taskId,
      deliveryId: expect.any(String),
      reason: 'admission_callback_failed',
    });
    expect(failures).toHaveLength(2);
    const diagnosticStates = Reflect.get(scheduler, 'diagnosticStates') as Map<
      string,
      string
    >;
    expect(diagnosticStates.size).toBe(0);
    expect(
      debug.mock.calls.filter(([event]) => event === 'proactive.event_queued'),
    ).toEqual([]);
    for (const secret of [
      'private-admission-payload',
      'private-provider-error',
      'Secret failure title',
      'Secret condition',
      'Secret trigger',
      'Secret timer',
      'Secret reminder',
    ]) {
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    }
  });

  it('bounds diagnostic state across updates, cancellation, completion and disposal', () => {
    const debug = vi.fn();
    const { scheduler, deliveries } = createHarness(config(), { debug });
    const diagnosticStates = Reflect.get(scheduler, 'diagnosticStates') as Map<
      string,
      string
    >;
    for (let index = 0; index < 20; index += 1) {
      const task = scheduler.createPerceptionMonitor({
        title: `Task ${index}`,
        modalities: ['audio'],
        condition: 'A bell rings',
        triggerResponse: 'Notify',
        repeat: true,
      });
      vi.advanceTimersByTime(2_000);
      expect(diagnosticStates.size).toBe(2);
      scheduler.updateTask({
        targetTitle: task.title,
        condition: 'A second bell rings',
      });
      vi.advanceTimersByTime(2_000);
      expect(debug).toHaveBeenCalledWith(
        'proactive.evaluation_gate',
        expect.objectContaining({
          taskId: task.taskId,
          generation: 2,
          reason: 'waiting_for_media',
        }),
      );
      expect(diagnosticStates.size).toBe(2);
      scheduler.cancelTasks({ targetTitle: task.title });
      expect(diagnosticStates.size).toBe(0);
    }
    scheduler.createTimer({
      title: 'One-shot',
      durationSec: 1,
      reminderText: 'Ready',
    });
    vi.advanceTimersByTime(1_000);
    scheduler.acknowledgeDelivery(deliveries[0]!);
    expect(diagnosticStates.size).toBe(0);
    scheduler.createTimer({
      title: 'Disposed timer',
      durationSec: 100,
      reminderText: 'Ready',
    });
    expect(diagnosticStates.size).toBe(1);
    scheduler.dispose();
    expect(diagnosticStates.size).toBe(0);
  });

  it('does not let a throwing debug observer change timer or monitor delivery', () => {
    const { scheduler, monitors, deliveries, failures } = createHarness(
      config(),
      {
        debug: () => {
          throw new Error('diagnostic sink unavailable');
        },
      },
    );
    scheduler.createPerceptionMonitor({
      title: 'Monitor',
      modalities: ['audio'],
      condition: 'A bell rings',
      triggerResponse: 'Notify',
      repeat: true,
    });
    scheduler.feedAudio(new Uint8Array(32_000));
    vi.advanceTimersByTime(2_000);
    monitors[0]!.result(true);
    scheduler.acknowledgeDelivery(deliveries[0]!);
    scheduler.createTimer({
      title: 'Timer',
      durationSec: 1,
      reminderText: 'Ready',
    });
    vi.advanceTimersByTime(1_000);
    scheduler.acknowledgeDelivery(deliveries[1]!);
    expect(deliveries).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(scheduler.listTasks()[0]?.status).toBe('running');
  });

  it('does not retain a gate when evaluation fails synchronously during request admission', () => {
    const debug = vi.fn();
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 1;
    const { scheduler, monitors, failures } = createHarness(proactive, {
      debug,
    });
    scheduler.createPerceptionMonitor({
      title: 'Synchronous failure',
      modalities: ['audio'],
      condition: 'Bell',
      triggerResponse: 'Notify',
      repeat: true,
    });
    scheduler.feedAudio(new Uint8Array(32_000));
    vi.spyOn(monitors[0]!, 'requestEvaluation').mockImplementation(() => {
      monitors[0]!.resultError('private-synchronous-error');
      return true;
    });
    vi.advanceTimersByTime(2_000);
    expect(failures).toHaveLength(1);
    expect(scheduler.listTasks()).toEqual([]);
    const diagnosticStates = Reflect.get(scheduler, 'diagnosticStates') as Map<
      string,
      string
    >;
    expect(diagnosticStates.size).toBe(0);
    expect(
      debug.mock.calls.some(
        ([event, details]) =>
          event === 'proactive.evaluation_gate' &&
          details.reason === 'evaluation_requested',
      ),
    ).toBe(false);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'private-synchronous-error',
    );
  });

  it('omits capture and failure-callback exception text from diagnostics', async () => {
    const debug = vi.fn();
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 1;
    const { scheduler, failures } = createHarness(proactive, {
      debug,
      captureVision: async () => {
        throw new Error('private-capture-payload');
      },
      onTaskFailed: () => {
        throw new Error('private-callback-payload');
      },
    });
    const task = scheduler.createPerceptionMonitor({
      title: 'Private capture task',
      modalities: ['vision'],
      condition: 'Private condition',
      triggerResponse: 'Private response',
      repeat: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toHaveLength(1);
    expect(debug).toHaveBeenCalledWith('proactive.visual_capture_failed', {
      taskIds: [task.taskId],
      reason: 'capture_rejected',
    });
    expect(debug).toHaveBeenCalledWith(
      'proactive.task_failure_callback_failed',
      { taskId: task.taskId, reason: 'failure_callback_failed' },
    );
    for (const value of [
      'private-capture-payload',
      'private-callback-payload',
      'Private capture task',
      'Private condition',
      'Private response',
    ]) {
      expect(JSON.stringify(debug.mock.calls)).not.toContain(value);
    }
  });

  it('keeps diagnostic state empty when no debug observer is configured', () => {
    const { scheduler } = createHarness();
    scheduler.createPerceptionMonitor({
      title: 'No debug',
      modalities: ['audio'],
      condition: 'Bell',
      triggerResponse: 'Notify',
      repeat: true,
    });
    vi.advanceTimersByTime(4_000);
    const diagnosticStates = Reflect.get(scheduler, 'diagnosticStates') as Map<
      string,
      string
    >;
    expect(diagnosticStates.size).toBe(0);
  });

  it('observes stable tasks, repeat notifications and final history without exposing evaluation cycles as tasks', () => {
    const observed: Array<{ task: ProactiveTask; notification?: string }> = [];
    const { scheduler, monitors, deliveries } = createHarness(config(), {
      onTaskChanged: (task, notification) =>
        observed.push({ task, notification }),
    });
    const task = scheduler.createPerceptionMonitor({
      title: 'Watch cat',
      modalities: ['vision'],
      condition: 'A cat appears',
      triggerResponse: 'Tell me',
      repeat: true,
    });
    monitors[0]!.result(true, 'A cat appeared');
    const delivery = deliveries[0]!;
    scheduler.announcementStarted(delivery);
    expect(observed.at(-1)?.notification).toBe('speaking');
    scheduler.acknowledgeDelivery(delivery);
    expect(observed.at(-1)).toMatchObject({
      notification: 'delivered',
      task: {
        taskId: task.taskId,
        status: 'running',
        triggerCount: 1,
        pendingDeliveryCount: 0,
      },
    });
    const timer = scheduler.createTimer({
      title: 'Reminder',
      durationSec: 1,
      reminderText: 'Time is up',
    });
    vi.advanceTimersByTime(1000);
    scheduler.acknowledgeDelivery(deliveries[1]!);
    expect(observed.at(-1)).toMatchObject({
      notification: 'delivered',
      task: { taskId: timer.taskId, status: 'completed' },
    });
    scheduler.dispose();
    expect(observed.at(-1)?.task).toMatchObject({
      taskId: task.taskId,
      status: 'cancelled',
      pendingDeliveryCount: 0,
    });
    expect(new Set(observed.map((event) => event.task.taskId)).size).toBe(2);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('warms audio beyond the shorter vision window for a multimodal task', () => {
    const proactive = config();
    proactive.vision.windowSizeSec = 10;
    proactive.audio.windowSizeSec = 60;
    proactive.audio.minEvalDurationSec = 20;
    const { scheduler, monitors } = createHarness(proactive);
    scheduler.createPerceptionMonitor({
      title: 'Multimodal watch',
      modalities: ['vision', 'audio'],
      condition: 'The visible kettle whistles',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    for (let second = 0; second < 20; second += 1) {
      scheduler.feedImage(`frame-${second}`);
      scheduler.feedAudio(new Uint8Array(32_000));
      expect(monitors[0]?.evaluations).toBe(0);
      vi.advanceTimersByTime(1_000);
    }

    expect(monitors[0]?.evaluations).toBe(1);
    expect(monitors[0]?.options.contextWindowSec).toEqual({
      audio: 60,
      vision: 10,
    });
  });

  it('does not warm a single frame by waiting or carry warm-up across a capture gap', () => {
    const proactive = config();
    proactive.vision = { fps: 5, windowSizeSec: 2, minEvalDurationSec: 2 };
    const { scheduler, monitors } = createHarness(proactive);
    scheduler.createPerceptionMonitor({
      title: 'Watch',
      modalities: ['vision'],
      condition: 'A change occurs',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    scheduler.feedImage('first');
    vi.advanceTimersByTime(2_001);
    expect(monitors[0]!.evaluations).toBe(0);

    for (let index = 0; index < 6; index += 1) {
      scheduler.feedImage(`slow-${index}`);
      if (index < 5) vi.advanceTimersByTime(450);
    }
    vi.advanceTimersByTime(1_749);
    expect(monitors[0]!.evaluations).toBe(1);

    // The previous capture is still retained at the last poll; this gap
    // expires it before the next frame, without an intervening empty poll.
    vi.advanceTimersByTime(252);
    scheduler.feedImage('after-gap');
    vi.advanceTimersByTime(1_748);
    expect(monitors[0]!.evaluations).toBe(1);
  });

  it('requires fresh warm-up after resetting the visual source', () => {
    const proactive = config();
    proactive.vision = { fps: 5, windowSizeSec: 2, minEvalDurationSec: 2 };
    const { scheduler, monitors } = createHarness(proactive);
    scheduler.createPerceptionMonitor({
      title: 'Watch',
      modalities: ['vision'],
      condition: 'A change occurs',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    for (let index = 0; index < 6; index += 1) {
      scheduler.feedImage(`slow-${index}`);
      if (index < 5) vi.advanceTimersByTime(450);
    }
    vi.advanceTimersByTime(1_750);
    expect(monitors[0]!.evaluations).toBe(1);
    scheduler.resetVisualSource();
    scheduler.feedImage('new-source');
    vi.advanceTimersByTime(2_000);
    expect(monitors[1]!.evaluations).toBe(0);
  });

  it('expires audio independently when vision has the longer window', () => {
    const proactive = config();
    proactive.vision.windowSizeSec = 60;
    proactive.vision.minEvalDurationSec = 20;
    proactive.audio.windowSizeSec = 10;
    const { scheduler, monitors } = createHarness(proactive);
    scheduler.createPerceptionMonitor({
      title: 'Multimodal watch',
      modalities: ['vision', 'audio'],
      condition: 'The visible kettle whistles',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    scheduler.feedAudio(new Uint8Array(32_000));
    for (let second = 0; second < 20; second += 1) {
      scheduler.feedImage(`frame-${second}`);
      vi.advanceTimersByTime(1_000);
    }
    expect(monitors[0]?.evaluations).toBe(0);
    scheduler.feedAudio(new Uint8Array(32_000));
    vi.advanceTimersByTime(2_000);
    expect(monitors[0]?.evaluations).toBe(1);
  });

  it('delivers a timer that expires while it is being armed', () => {
    let now = 0;
    const onEvent = vi.fn(() => true);
    const scheduler = new ProactiveScheduler({
      config: config(),
      realtime: { endpoint: 'https://example.test', model: 'test' },
      now: () => now++,
      onEvent,
    });
    activeSchedulers.push(scheduler);
    const task = scheduler.createTimer({
      title: 'Immediate timer',
      durationSec: 0.001,
      reminderText: 'Ready',
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(task.status).toBe('delivering');
    expect(scheduler.listTasks()[0]?.pendingDeliveryCount).toBe(1);
  });

  it('preserves a timer deadline when only metadata changes', () => {
    const { scheduler, deliveries } = createHarness();
    scheduler.createTimer({
      title: 'Tea',
      durationSec: 10,
      reminderText: 'First reminder',
    });

    vi.advanceTimersByTime(4_000);
    scheduler.updateTask({
      targetTitle: 'Tea',
      title: 'Tea renamed',
      reminderText: 'Updated reminder',
    });
    expect(remainingSec(scheduler)).toBe(6);

    vi.advanceTimersByTime(5_999);
    expect(deliveries).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.event).toContain('Updated reminder');
    expect(scheduler.listTasks()[0]?.status).toBe('delivering');

    scheduler.announcementStarted(deliveries[0]!);
    expect(scheduler.listTasks()[0]?.status).toBe('delivering');
    scheduler.acknowledgeDelivery(deliveries[0]!);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('reschedules a timer only when its duration changes', () => {
    const { scheduler, deliveries } = createHarness();
    scheduler.createTimer({
      title: 'Tea',
      durationSec: 10,
      reminderText: 'Done',
    });

    vi.advanceTimersByTime(4_000);
    scheduler.updateTask({ targetTitle: 'Tea', durationSec: 20 });
    expect(remainingSec(scheduler)).toBe(20);

    vi.advanceTimersByTime(6_000);
    expect(deliveries).toHaveLength(0);
    vi.advanceTimersByTime(13_999);
    expect(deliveries).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(deliveries).toHaveLength(1);
  });

  it('fires a 30-day timer only at its absolute deadline', () => {
    const maxTimeoutMs = 2_147_483_647;
    const durationMs = 30 * 24 * 60 * 60 * 1_000;
    const fakeSetTimeout = globalThis.setTimeout;
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay) =>
        fakeSetTimeout(
          callback,
          delay !== undefined && delay > maxTimeoutMs ? 1 : delay,
        ),
      );

    try {
      const { scheduler, deliveries } = createHarness();
      scheduler.createTimer({
        title: 'Monthly reminder',
        durationSec: durationMs / 1_000,
        reminderText: 'Thirty days have passed',
      });

      vi.advanceTimersByTime(maxTimeoutMs);
      expect(deliveries).toHaveLength(0);
      expect(remainingSec(scheduler)).toBe((durationMs - maxTimeoutMs) / 1_000);

      vi.advanceTimersByTime(durationMs - maxTimeoutMs - 1);
      expect(deliveries).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.event).toContain('Thirty days have passed');
    } finally {
      timeoutSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });

  it('keeps announcementStarted idempotent without extending its delivery timeout', () => {
    const { scheduler, monitors, deliveries, invalidated, failures } =
      createHarness();
    scheduler.createPerceptionMonitor({
      title: 'Tea',
      modalities: ['audio'],
      condition: 'The kettle whistles',
      triggerResponse: 'Tell me to turn it off',
      repeat: false,
    });
    monitors[0]!.result(true, 'The kettle is whistling.');
    const delivery = deliveries[0]!;

    vi.advanceTimersByTime(60_000);
    expect(invalidated).toHaveLength(0);
    expect(scheduler.listTasks()[0]?.status).toBe('delivering');

    scheduler.announcementStarted(delivery);
    vi.advanceTimersByTime(20_000);
    scheduler.announcementStarted(delivery);
    vi.advanceTimersByTime(9_999);
    expect(invalidated).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(invalidated).toEqual([delivery]);
    expect(failures).toEqual([
      {
        task: expect.objectContaining({ title: 'Tea', status: 'failed' }),
        error: 'Proactive announcement playback acknowledgement timed out.',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);

    scheduler.failDelivery(delivery, 'late duplicate failure');
    expect(failures).toHaveLength(1);
  });

  it('clears the playback timeout while an interrupted delivery is deferred', () => {
    const { scheduler, monitors, deliveries, invalidated } = createHarness();
    scheduler.createPerceptionMonitor({
      title: 'Tea',
      modalities: ['audio'],
      condition: 'The kettle whistles',
      triggerResponse: 'Tell me to turn it off',
      repeat: false,
    });
    monitors[0]!.result(true, 'The kettle is whistling.');
    const delivery = deliveries[0]!;

    scheduler.announcementStarted(delivery);
    vi.advanceTimersByTime(20_000);
    expect(scheduler.deferDelivery(delivery)).toBe(true);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'delivering',
      pendingDeliveryCount: 1,
    });

    vi.advanceTimersByTime(30_000);
    expect(invalidated).toEqual([]);
    scheduler.announcementStarted(delivery);
    scheduler.acknowledgeDelivery(delivery);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('requires cooldown and a later false edge before a repeat event rearms', () => {
    const { scheduler, monitors, deliveries } = createHarness();
    scheduler.createPerceptionMonitor({
      title: 'Posture',
      modalities: ['audio'],
      condition: 'The posture warning condition is present',
      triggerResponse: 'Remind me to correct it',
      repeat: true,
    });
    const monitor = monitors[0]!;
    scheduler.feedAudio(new Uint8Array(3_200));
    vi.advanceTimersByTime(2_000);
    expect(monitor.evaluations).toBe(1);

    monitor.result(true, 'Posture needs correction.');
    expect(deliveries).toHaveLength(1);
    scheduler.acknowledgeDelivery(deliveries[0]!);
    expect(scheduler.listTasks()[0]?.status).toBe('running');

    scheduler.feedAudio(new Uint8Array(3_200));
    monitor.result(false);
    expect(monitor.audioFrames).toBe(1);
    vi.advanceTimersByTime(3_000);
    scheduler.feedAudio(new Uint8Array(3_200));
    expect(monitor.audioFrames).toBe(2);
    expect(monitor.resets).toBe(2);

    monitor.result(true, 'The condition is still continuously true.');
    expect(deliveries).toHaveLength(1);
    monitor.result(false);
    monitor.result(true, 'A distinct occurrence happened.');
    expect(deliveries).toHaveLength(2);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      pendingDeliveryCount: 1,
    });
    scheduler.acknowledgeDelivery(deliveries[1]!);
    expect(scheduler.listTasks()[0]?.status).toBe('running');
  });

  it('lets live narration emit a new change after cooldown without a false edge', () => {
    const { scheduler, monitors, deliveries } = createHarness();
    scheduler.createLiveNarration({
      title: 'Narration',
      modalities: ['audio'],
      narrationFocus: 'Describe meaningful changes',
      narrationStyle: 'Brief English',
    });
    const monitor = monitors[0]!;

    monitor.result(true, 'A person entered.');
    scheduler.acknowledgeDelivery(deliveries[0]!);
    vi.advanceTimersByTime(3_000);
    scheduler.feedAudio(new Uint8Array(3_200));
    monitor.result(true, 'The person sat down.');

    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]?.event).toContain('The person sat down.');
  });

  it('continues observing and queues distinct occurrences while a prior event is held', () => {
    const { scheduler, monitors, deliveries } = createHarness();
    scheduler.createPerceptionMonitor({
      title: 'Door watch',
      modalities: ['vision'],
      condition: 'The door opens',
      triggerResponse: 'Tell me',
      repeat: true,
    });
    const monitor = monitors[0]!;
    scheduler.feedImage('first-frame');
    vi.advanceTimersByTime(2_000);
    monitor.result(true, 'The door opened for the first visitor.');

    vi.advanceTimersByTime(3_000);
    scheduler.feedImage('door-still-open');
    vi.advanceTimersByTime(1_000);
    monitor.result(true, 'The door is still open.');
    expect(deliveries).toHaveLength(1);
    monitor.result(false);

    vi.advanceTimersByTime(2_000);
    scheduler.feedImage('second-visitor');
    monitor.result(true, 'The door opened for the second visitor.');

    expect(monitor.imageFrames).toBe(3);
    expect(monitor.evaluations).toBeGreaterThan(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.deliveryId).not.toBe(deliveries[1]?.deliveryId);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      triggerCount: 2,
      pendingDeliveryCount: 2,
    });
  });

  it('delivers multiple narration events in FIFO behind foreground and Host playback', () => {
    const submitted: string[] = [];
    const injector = new Injector({
      now: Date.now,
      quietGapMs: 0,
      sink: {
        injectContext: () => true,
        injectSpeech: () => true,
        injectProactive: (event) => {
          submitted.push(event);
          return true;
        },
        onInjected: (item) => {
          const delivery = deliveries.find(
            (candidate) => candidate.deliveryId === item.deliveryId,
          );
          if (delivery) scheduler.announcementStarted(delivery);
        },
      },
    });
    const { scheduler, monitors, deliveries } = createHarness(config(), {
      onEvent: (delivery) =>
        injector.enqueue({
          kind: 'proactive',
          context: delivery.event,
          deliveryId: delivery.deliveryId,
        }),
    });
    scheduler.createLiveNarration({
      title: 'Narration',
      modalities: ['audio'],
      narrationFocus: 'Describe meaningful changes',
      narrationStyle: 'Brief English',
    });
    const monitor = monitors[0]!;
    injector.noteResponseCreated('direct');
    injector.notePlaybackStarted();
    for (const summary of ['A person entered.', 'They sat down.']) {
      scheduler.feedAudio(new Uint8Array(3_200));
      vi.advanceTimersByTime(2_000);
      monitor.result(true, summary);
      vi.advanceTimersByTime(3_000);
    }
    expect(submitted).toEqual([]);
    injector.noteResponseDone('direct');
    expect(submitted).toEqual([]);
    injector.notePlaybackCompleted();
    expect(submitted).toEqual([deliveries[0]!.event]);
    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();

    scheduler.feedAudio(new Uint8Array(3_200));
    vi.advanceTimersByTime(2_000);
    monitor.result(true, 'They opened a book.');
    expect(monitor.evaluations).toBeGreaterThanOrEqual(3);
    expect(monitor.audioFrames).toBe(3);
    expect(scheduler.listTasks()[0]?.pendingDeliveryCount).toBe(3);

    for (const [index, delivery] of deliveries.entries()) {
      injector.noteResponseDone('proactive');
      expect(submitted).toHaveLength(index + 1);
      scheduler.acknowledgeDelivery(delivery);
      injector.notePlaybackCompleted();
      if (index < deliveries.length - 1) {
        injector.noteResponseCreated('proactive');
        injector.notePlaybackStarted();
      }
    }
    expect(submitted).toEqual(deliveries.map((delivery) => delivery.event));
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      pendingDeliveryCount: 0,
    });
    expect(monitor.closed).toBe(false);
    injector.dispose();
  });

  it.each(['cancel', 'cancel-all', 'update', 'failure', 'dispose'] as const)(
    'invalidates every pending event before releasing the active item on %s',
    (operation) => {
      const submitted: string[] = [];
      const injector = new Injector({
        now: Date.now,
        quietGapMs: 0,
        sink: {
          injectContext: () => true,
          injectSpeech: () => true,
          injectProactive: (event) => {
            submitted.push(event);
            return true;
          },
        },
      });
      const { scheduler, monitors, deliveries, invalidated } = createHarness(
        config(),
        {
          onEvent: (delivery) =>
            injector.enqueue({
              kind: 'proactive',
              context: delivery.event,
              deliveryId: delivery.deliveryId,
            }),
          onDeliveryInvalidated: (delivery) => {
            expect(
              scheduler
                .listTasks()
                .every((task) => task.pendingDeliveryCount === 0),
            ).toBe(true);
            if (!injector.retractProactive(delivery.deliveryId)) {
              injector.abortProactive(delivery.deliveryId);
            }
          },
        },
      );
      scheduler.createLiveNarration({
        title: 'Narration',
        modalities: ['audio'],
        narrationFocus: 'Describe meaningful changes',
        narrationStyle: 'Brief English',
      });
      const monitor = monitors[0]!;
      for (const summary of ['First change', 'Second change', 'Third change']) {
        scheduler.feedAudio(new Uint8Array(3_200));
        vi.advanceTimersByTime(2_000);
        monitor.result(true, summary);
        vi.advanceTimersByTime(3_000);
      }
      scheduler.announcementStarted(deliveries[0]!);
      if (operation === 'cancel-all') {
        scheduler.createTimer({
          title: 'Timer',
          durationSec: 1,
          reminderText: 'Timer finished',
        });
        vi.advanceTimersByTime(1_000);
      }
      expect(submitted).toHaveLength(1);

      switch (operation) {
        case 'cancel':
          scheduler.cancelTasks({ targetTitle: 'Narration' });
          break;
        case 'cancel-all':
          scheduler.cancelTasks({ all: true });
          break;
        case 'update':
          scheduler.updateTask({
            targetTitle: 'Narration',
            narrationFocus: 'Only describe the door',
          });
          break;
        case 'failure':
          scheduler.failDelivery(deliveries[0]!, 'Playback failed');
          break;
        case 'dispose':
          scheduler.dispose();
          break;
        default:
          throw new Error('Unexpected cleanup operation');
      }

      expect(invalidated).toEqual([...deliveries].reverse());
      expect(submitted).toHaveLength(1);
      expect(injector.pendingCount).toBe(0);
      expect(monitor.closed).toBe(true);
      scheduler.acknowledgeDelivery(deliveries[0]!);
      expect(scheduler.deferDelivery(deliveries[0]!)).toBe(false);
      scheduler.failDelivery(deliveries[0]!, 'Stale failure');
      const updatedTask = expect.objectContaining({
        status: 'running',
        generation: 2,
        pendingDeliveryCount: 0,
      });
      expect(scheduler.listTasks()).toEqual(
        operation === 'update' ? [updatedTask] : [],
      );
      if (operation === 'update') {
        monitors[1]!.result(true, 'A fresh event from the new task generation');
      }
      expect(deliveries.at(-1)?.taskGeneration).toBe(
        operation === 'update' ? 2 : 1,
      );
      injector.dispose();
    },
  );

  it('fails only vision tasks without evidence after capture errors', async () => {
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 2;
    const captureVision = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValue(new Error('capture unavailable'));
    const { scheduler, failures } = createHarness(proactive, {
      captureVision,
    });
    const bufferedVision = scheduler.createPerceptionMonitor({
      title: 'Buffered vision',
      modalities: ['vision'],
      condition: 'A person appears',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    scheduler.feedImage('existing-frame');
    const emptyVision = scheduler.createPerceptionMonitor({
      title: 'Empty vision',
      modalities: ['vision'],
      condition: 'A package appears',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    const audioOnly = scheduler.createPerceptionMonitor({
      title: 'Audio only',
      modalities: ['audio'],
      condition: 'A bell rings',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          taskId: emptyVision.taskId,
          status: 'failed',
        }),
        error: 'Maximum visual capture failures exceeded.',
      },
    ]);
    expect(scheduler.listTasks().map((task) => task.taskId)).toEqual([
      bufferedVision.taskId,
      audioOnly.taskId,
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(captureVision).toHaveBeenCalledTimes(3);
    expect(failures).toHaveLength(1);
  });

  it('clears consecutive capture failures after a successful frame', async () => {
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 2;
    proactive.vision.windowSizeSec = 0.5;
    const captureVision = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error('temporary capture error'))
      .mockResolvedValueOnce('recovered-frame')
      .mockRejectedValue(new Error('capture unavailable'));
    const { scheduler, monitors, failures } = createHarness(proactive, {
      captureVision,
    });
    const task = scheduler.createPerceptionMonitor({
      title: 'Visual watch',
      modalities: ['vision'],
      condition: 'A person appears',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitors[0]?.imageFrames).toBe(1);
    expect(failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.listTasks()[0]?.taskId).toBe(task.taskId);
    expect(failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          taskId: task.taskId,
          status: 'failed',
        }),
        error: 'Maximum visual capture failures exceeded.',
      },
    ]);
  });

  it('does not treat an unavailable capture path as a capture failure', async () => {
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 1;
    const captureVision = vi.fn(async () => undefined);
    const { scheduler, failures } = createHarness(proactive, { captureVision });
    const task = scheduler.createPerceptionMonitor({
      title: 'Live Feed watch',
      modalities: ['vision'],
      condition: 'A person appears',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(captureVision).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([]);
    expect(scheduler.listTasks()[0]?.taskId).toBe(task.taskId);
  });

  it('replaces the monitor timeline when the selected source changes', () => {
    const { scheduler, monitors } = createHarness();
    scheduler.createPerceptionMonitor({
      title: 'Visual watch',
      modalities: ['vision'],
      condition: 'A new person appears',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    const monitor = monitors[0]!;

    scheduler.feedImage('jpeg-one');
    vi.advanceTimersByTime(2_000);
    expect(monitor.evaluations).toBe(1);
    scheduler.resetVisualSource();
    const replacement = monitors[1]!;
    expect(monitor.closed).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(replacement.evaluations).toBe(0);

    monitor.result(true, 'A late result from the old source.');
    expect(scheduler.listTasks()[0]?.status).toBe('running');

    scheduler.feedImage('jpeg-two');
    vi.advanceTimersByTime(2_000);
    expect(replacement.imageFrames).toBe(1);
    expect(replacement.evaluations).toBe(1);
  });

  it('reports a monitor provisioning failure exactly once', () => {
    const { scheduler, monitors, failures } = createHarness(config(), {
      autoReady: false,
    });
    scheduler.createPerceptionMonitor({
      title: 'Door watch',
      modalities: ['vision'],
      condition: 'The door opens',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    expect(scheduler.listTasks()[0]?.status).toBe('provisioning');

    monitors[0]!.lifecycleError('authentication failed');
    monitors[0]!.lifecycleError('late duplicate failure');

    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          title: 'Door watch',
          status: 'failed',
          error: 'Monitor setup failed: authentication failed',
        }),
        error: 'Monitor setup failed: authentication failed',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('fails and removes the task when monitor construction throws', () => {
    const { scheduler, monitors, failures } = createHarness(config(), {
      createMonitorError: new Error('monitor construction failed'),
    });

    const task = scheduler.createPerceptionMonitor({
      title: 'Door watch',
      modalities: ['vision'],
      condition: 'The door opens',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    expect(task).toMatchObject({
      status: 'failed',
      error: 'Monitor setup failed: monitor construction failed',
    });
    expect(monitors).toEqual([]);
    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          taskId: task.taskId,
          status: 'failed',
        }),
        error: 'Monitor setup failed: monitor construction failed',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('fails, closes, and removes the task when monitor.start throws', () => {
    const { scheduler, monitors, failures } = createHarness(config(), {
      startFailure: 'throw',
    });

    const task = scheduler.createPerceptionMonitor({
      title: 'Door watch',
      modalities: ['vision'],
      condition: 'The door opens',
      triggerResponse: 'Tell me',
      repeat: false,
    });

    expect(task).toMatchObject({
      status: 'failed',
      error: 'Monitor setup failed: monitor start threw',
    });
    expect(monitors[0]?.closed).toBe(true);
    monitors[0]?.lifecycleError('late duplicate failure');
    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          taskId: task.taskId,
          status: 'failed',
        }),
        error: 'Monitor setup failed: monitor start threw',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('fails, closes, and removes the task when monitor.start rejects', async () => {
    const { scheduler, monitors, failures } = createHarness(config(), {
      startFailure: 'reject',
    });

    const task = scheduler.createPerceptionMonitor({
      title: 'Door watch',
      modalities: ['vision'],
      condition: 'The door opens',
      triggerResponse: 'Tell me',
      repeat: false,
    });
    expect(task.status).toBe('provisioning');

    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });
    expect(monitors[0]?.closed).toBe(true);
    monitors[0]?.lifecycleError('late duplicate failure');
    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          taskId: task.taskId,
          status: 'failed',
        }),
        error: 'Monitor setup failed: monitor start rejected',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('reports only the first transition after consecutive monitor failures', () => {
    const proactive = config();
    proactive.scheduler.maxFailuresPerTask = 2;
    const { scheduler, monitors, failures } = createHarness(proactive);
    scheduler.createPerceptionMonitor({
      title: 'Kettle watch',
      modalities: ['audio'],
      condition: 'The kettle whistles',
      triggerResponse: 'Tell me to turn it off',
      repeat: true,
    });
    const monitor = monitors[0]!;

    monitor.resultError('temporary monitor failure');
    expect(failures).toEqual([]);
    expect(scheduler.listTasks()[0]).toMatchObject({
      status: 'running',
      failureCount: 1,
    });

    monitor.resultError('second monitor failure');
    monitor.resultError('late duplicate failure');

    expect(failures).toEqual([
      {
        task: expect.objectContaining({
          title: 'Kettle watch',
          status: 'failed',
          failureCount: 2,
          error: 'Maximum monitor failures exceeded.',
        }),
        error: 'Maximum monitor failures exceeded.',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);
  });

  it('reports a rejected delivery exactly once', () => {
    const { scheduler, deliveries, invalidated, failures } = createHarness(
      config(),
      { acceptDelivery: false },
    );
    scheduler.createTimer({
      title: 'Tea',
      durationSec: 1,
      reminderText: 'Tea is ready',
    });

    vi.advanceTimersByTime(1_000);

    expect(deliveries).toHaveLength(1);
    expect(invalidated).toEqual([deliveries[0]]);
    expect(failures).toEqual([
      {
        task: expect.objectContaining({ title: 'Tea', status: 'failed' }),
        error: 'Proactive event delivery was rejected.',
      },
    ]);
    expect(scheduler.listTasks()).toEqual([]);

    scheduler.failDelivery(deliveries[0]!, 'late duplicate failure');
    expect(failures).toHaveLength(1);
  });
});
