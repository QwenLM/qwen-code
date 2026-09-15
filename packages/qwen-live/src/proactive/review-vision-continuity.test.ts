/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROACTIVE_CONFIG } from '../config.js';
import { ProactiveScheduler } from './scheduler.js';

afterEach(() => vi.useRealTimers());

describe('PR #11369 round 2 vision continuity reproduction', () => {
  it('R2-28 does not certify visual warm-up across a 9.9 second capture hole', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const config = structuredClone(DEFAULT_PROACTIVE_CONFIG);
    config.vision = { fps: 5, windowSizeSec: 10, minEvalDurationSec: 2 };
    config.scheduler.evalIntervalSec = 12;
    const requestEvaluation = vi.fn(() => true);
    const gates: Array<Record<string, unknown>> = [];
    const scheduler = new ProactiveScheduler({
      config,
      realtime: { endpoint: 'https://review.example.test', model: 'test' },
      onEvent: () => true,
      createMonitor: (options, callbacks) => ({
        start: async () => callbacks.onReady?.(options.taskGeneration),
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
        title: 'Synthetic interrupted screen observation',
        modalities: ['vision'],
        condition: 'A synthetic shape changes.',
        triggerResponse: 'Report the shape change.',
        repeat: false,
      });
      scheduler.feedImage('/9j/2Q==');
      await vi.advanceTimersByTimeAsync(9_900);
      scheduler.feedImage('/9j/2Q==');
      await vi.advanceTimersByTimeAsync(2_100);
      expect(gates.at(-1)).toMatchObject({
        reason: 'waiting_for_media',
        visionFrames: 1,
      });
      expect(requestEvaluation).not.toHaveBeenCalled();
    } finally {
      scheduler.dispose();
    }
  });
});
