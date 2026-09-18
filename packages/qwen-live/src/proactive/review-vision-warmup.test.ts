/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROACTIVE_CONFIG } from '../config.js';
import { ProactiveScheduler } from './scheduler.js';

afterEach(() => vi.useRealTimers());

async function slowCaptureArm(fps: number, minEvalDurationSec: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  const config = structuredClone(DEFAULT_PROACTIVE_CONFIG);
  config.vision = { fps, minEvalDurationSec, windowSizeSec: 2 };
  const captures: number[] = [];
  const requestEvaluation = vi.fn(() => true);
  const onTaskFailed = vi.fn();
  const gates: Array<Record<string, unknown>> = [];
  const scheduler = new ProactiveScheduler({
    config,
    realtime: { endpoint: 'https://review.example.test', model: 'test' },
    onEvent: () => true,
    onTaskFailed,
    captureVision: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      captures.push(Date.now());
      return '/9j/2Q==';
    },
    createMonitor: (options, callbacks) => ({
      start: async () => {
        callbacks.onReady?.(options.taskGeneration);
      },
      feedAudio: () => true,
      feedImage: () => true,
      requestEvaluation,
      resetPendingCapture: () => {},
      close: () => {},
    }),
    now: Date.now,
    debug: (event, details) => {
      if (event === 'proactive.evaluation_gate') gates.push(details);
    },
  });
  try {
    scheduler.createPerceptionMonitor({
      title: 'Synthetic slow successful capture',
      modalities: ['vision'],
      condition: 'The synthetic shape changes.',
      triggerResponse: 'Report the change.',
      repeat: false,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const retained = captures.filter((at) => at >= Date.now() - 2_000);
    return {
      fps,
      minEvalDurationSec,
      captures: captures.length,
      evaluations: requestEvaluation.mock.calls.length,
      failures: onTaskFailed.mock.calls.length,
      task: scheduler.listTasks()[0],
      gates,
      retainedFrames: retained.length,
      retainedSpanSec:
        retained.length > 0 ? (retained.at(-1)! - retained[0]!) / 1_000 : 0,
    };
  } finally {
    scheduler.dispose();
    vi.useRealTimers();
  }
}

describe('PR #11369 vision warm-up review reproduction', () => {
  it('R1-28: eventually evaluates slow successful captures with an allowed positive warm-up', async () => {
    const observed = await slowCaptureArm(5, 2);
    const noWarmup = await slowCaptureArm(5, 0);
    const achievableRate = await slowCaptureArm(1, 2);
    expect(observed.captures).toBeGreaterThan(20);
    expect(observed.retainedFrames).toBeLessThan(
      Math.ceil(observed.fps * observed.minEvalDurationSec),
    );
    expect(observed.retainedSpanSec).toBeLessThan(observed.minEvalDurationSec);
    expect(
      observed.gates.some((gate) => gate['reason'] === 'evaluation_requested'),
    ).toBe(true);
    expect(observed.failures).toBe(0);
    expect(observed.task).toMatchObject({ status: 'running', failureCount: 0 });
    expect(noWarmup.evaluations).toBeGreaterThan(0);
    expect(achievableRate.evaluations).toBeGreaterThan(0);
    expect(observed.evaluations).toBeGreaterThan(0);
  });
});
