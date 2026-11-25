/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MonitorEventPipeline } from './monitorEventPipeline.js';

function createPipeline(now: () => number) {
  const emitEvent = vi.fn();
  const emitHousekeeping = vi.fn();
  const stopForOverload = vi.fn();
  const pipeline = new MonitorEventPipeline({
    emitEvent,
    emitHousekeeping,
    stopForOverload,
    now,
    schedule: () => () => {},
  });
  return { pipeline, emitEvent, emitHousekeeping, stopForOverload };
}

describe('MonitorEventPipeline', () => {
  it('emits only complete stdout lines until the monitor closes', () => {
    const { pipeline, emitEvent } = createPipeline(() => 0);

    pipeline.onData(' first\nsecond');
    pipeline.flush(false);
    expect(emitEvent).toHaveBeenCalledWith('first');

    pipeline.onData(' line\nthird');
    pipeline.flush(false);
    expect(emitEvent).toHaveBeenLastCalledWith('second line');

    pipeline.close();
    expect(emitEvent).toHaveBeenLastCalledWith('third');
  });

  it('disposes scheduled and buffered output without delivering it', () => {
    const emitEvent = vi.fn();
    const cancelScheduledFlush = vi.fn();
    let scheduledFlush: (() => void) | undefined;
    const pipeline = new MonitorEventPipeline({
      emitEvent,
      emitHousekeeping: vi.fn(),
      stopForOverload: vi.fn(),
      now: () => 0,
      schedule: (callback) => {
        scheduledFlush = callback;
        return cancelScheduledFlush;
      },
    });

    pipeline.onData('complete\npartial');
    pipeline.dispose();
    scheduledFlush?.();
    pipeline.close();

    expect(cancelScheduledFlush).toHaveBeenCalledOnce();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('bounds individual lines and batched events', () => {
    const { pipeline, emitEvent } = createPipeline(() => 0);

    pipeline.onData(`${'a'.repeat(501)}\n`);
    pipeline.flush(false);
    expect(emitEvent).toHaveBeenLastCalledWith(
      `${'a'.repeat(500)}...(truncated)`,
    );

    pipeline.onData(`${'b'.repeat(500)}\n`.repeat(7));
    pipeline.flush(false);
    const event = emitEvent.mock.calls.at(-1)?.[0] as string;
    expect(event).toHaveLength(3_015);
    expect(event).toBe(`${event.slice(0, 3_000)}\n...(truncated)`);
  });

  it('reports suppressed events before delivering the next available event', () => {
    let currentTime = 0;
    const { pipeline, emitEvent, emitHousekeeping } = createPipeline(
      () => currentTime,
    );

    for (let index = 0; index < 11; index++) {
      pipeline.onData(`event-${index}\n`);
      pipeline.flush(false);
    }
    expect(emitEvent).toHaveBeenCalledTimes(10);
    expect(emitHousekeeping).not.toHaveBeenCalled();

    currentTime = 2_000;
    pipeline.onData('event-11\n');
    pipeline.flush(false);

    expect(emitHousekeeping).toHaveBeenCalledWith(
      '[1 events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]',
    );
    expect(emitEvent).toHaveBeenLastCalledWith('event-11');
  });

  it('stops after more than 30 seconds of continuous overload', () => {
    let currentTime = 0;
    const { pipeline, emitHousekeeping, stopForOverload } = createPipeline(
      () => currentTime,
    );

    for (let second = 0; second <= 40; second++) {
      currentTime = second * 1_000;
      for (let index = 0; index < 3; index++) {
        pipeline.onData(`${second}-${index}\n`);
        pipeline.flush(false);
      }
    }

    expect(stopForOverload).toHaveBeenCalledOnce();
    expect(emitHousekeeping).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /^\[Monitor stopped — your script produced too much output \(\d+ events suppressed over \d+s\)\./,
      ),
    );
  });
});
