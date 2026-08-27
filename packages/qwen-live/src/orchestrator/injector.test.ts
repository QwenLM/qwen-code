/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from './injector.js';
import type { InjectorItem, InjectorSink } from './injector.js';

const QUIET_GAP_MS = 800;

class FakeSink implements InjectorSink {
  contextCalls: string[] = [];
  speechCalls: string[] = [];
  injected: Array<{ item: InjectorItem; spoken: boolean }> = [];
  contextResult = true;
  speechResult = true;

  injectContext(text: string): boolean {
    this.contextCalls.push(text);
    return this.contextResult;
  }

  injectSpeech(text: string): boolean {
    this.speechCalls.push(text);
    return this.speechResult;
  }

  onInjected(item: InjectorItem, spoken: boolean): void {
    this.injected.push({ item, spoken });
  }
}

function complete(context: string, spoken?: string): InjectorItem {
  return { kind: 'complete', context, ...(spoken ? { spoken } : {}) };
}

let sink: FakeSink;
let injector: Injector;

function makeInjector(options?: {
  quietGapMs?: number;
  progressThrottleMs?: number;
}): Injector {
  injector = new Injector({
    sink,
    now: () => Date.now(),
    ...(options?.quietGapMs !== undefined
      ? { quietGapMs: options.quietGapMs }
      : {}),
    ...(options?.progressThrottleMs !== undefined
      ? { progressThrottleMs: options.progressThrottleMs }
      : {}),
  });
  return injector;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Far past the initial playbackDeadline (0) + quiet gap: window starts open.
  vi.setSystemTime(1_000_000);
  sink = new FakeSink();
  makeInjector();
});

afterEach(() => {
  injector.dispose();
  vi.useRealTimers();
});

describe('Injector window conditions', () => {
  it('holds items while the user is speaking and delivers on speech stop', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('tests passed'));

    expect(sink.contextCalls).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    injector.noteSpeechStopped();

    expect(sink.contextCalls).toEqual(['tests passed']);
    expect(injector.pendingCount).toBe(0);
  });

  it('holds items while a realtime response is in flight and delivers on done', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('build finished'));

    expect(sink.contextCalls).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual(['build finished']);
  });

  it('waits out the estimated playback plus the quiet gap', () => {
    // 48,000 bytes of 24 kHz mono PCM16 ≈ 1,000 ms of audio.
    injector.noteOutputAudio(48_000);
    injector.enqueue(complete('done'));

    expect(sink.contextCalls).toEqual([]);

    // One tick before playback end + quiet gap: still closed.
    vi.advanceTimersByTime(1_000 + QUIET_GAP_MS - 1);
    expect(sink.contextCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sink.contextCalls).toEqual(['done']);
  });

  it('stacks playback estimates for consecutive audio chunks', () => {
    injector.noteOutputAudio(48_000);
    injector.noteOutputAudio(48_000);
    injector.enqueue(complete('done'));

    vi.advanceTimersByTime(2_000 + QUIET_GAP_MS - 1);
    expect(sink.contextCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sink.contextCalls).toEqual(['done']);
  });

  it('reopens the window immediately when output audio is cleared', () => {
    injector.noteOutputAudio(48_000 * 60);
    injector.enqueue(complete('interrupted'));
    vi.advanceTimersByTime(500);
    expect(sink.contextCalls).toEqual([]);

    injector.noteOutputCleared();

    expect(sink.contextCalls).toEqual(['interrupted']);
  });
});

describe('Injector batching', () => {
  it('flushes a held batch as one context injection and one spoken line, in order', () => {
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'complete',
      context: 'job_1 finished',
      spoken: 'Job one finished.',
      jobHandle: 'job_1',
    });
    injector.enqueue({
      kind: 'progress',
      context: 'job_2 is halfway',
      spoken: 'Job two is halfway.',
      jobHandle: 'job_2',
    });
    injector.enqueue({
      kind: 'permission',
      context: 'job_3 wants to edit a file',
      spoken: 'Job three needs permission.',
      jobHandle: 'job_3',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(3);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual([
      'job_1 finished\njob_2 is halfway\njob_3 wants to edit a file',
    ]);
    expect(sink.speechCalls).toEqual([
      'Job one finished. Job two is halfway. Job three needs permission.',
    ]);
    expect(sink.injected).toHaveLength(3);
    expect(injector.pendingCount).toBe(0);
  });

  it('injects silently when no batch item carries a spoken line', () => {
    injector.enqueue(complete('quiet update'));

    expect(sink.contextCalls).toEqual(['quiet update']);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.injected).toEqual([
      { item: complete('quiet update'), spoken: false },
    ]);
  });
});

describe('Injector progress throttling', () => {
  it('drops a second progress item for the same job inside the throttle window', () => {
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1']);

    vi.advanceTimersByTime(60_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p1']);
    expect(injector.pendingCount).toBe(0);

    // Past the 5-minute throttle the same job may report again.
    vi.advanceTimersByTime(5 * 60_000);
    injector.enqueue({ kind: 'progress', context: 'p3', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1', 'p3']);
  });

  it('throttles per job handle, not globally', () => {
    injector.enqueue({ kind: 'progress', context: 'a1', jobHandle: 'job_a' });
    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'b1', jobHandle: 'job_b' });

    expect(sink.contextCalls).toEqual(['a1', 'b1']);
  });

  it('keeps at most one queued progress item per job (newest wins)', () => {
    makeInjector({ progressThrottleMs: 0 });
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'progress',
      context: 'stale',
      jobHandle: 'job_1',
    });
    injector.enqueue({
      kind: 'progress',
      context: 'fresh',
      jobHandle: 'job_1',
    });
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual(['fresh']);
  });
});

describe('Injector queue maintenance', () => {
  it('drops queued progress on speech start but keeps conclusions and permission asks', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('finished'));
    injector.enqueue({ kind: 'progress', context: 'halfway', jobHandle: 'j' });
    injector.enqueue({
      kind: 'permission',
      context: 'needs approval',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(3);

    injector.noteSpeechStarted();
    expect(injector.pendingCount).toBe(2);

    injector.noteResponseDone();
    injector.noteSpeechStopped();
    expect(sink.contextCalls).toEqual(['finished\nneeds approval']);
  });

  it('retracts a queued permission ask by request id', () => {
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'permission',
      context: 'ask one',
      requestId: 'req_1',
    });
    injector.enqueue({
      kind: 'permission',
      context: 'ask two',
      requestId: 'req_2',
    });

    expect(injector.retractPermission('req_1')).toBe(true);
    expect(injector.pendingCount).toBe(1);
    expect(injector.retractPermission('req_unknown')).toBe(false);

    injector.noteResponseDone();
    expect(sink.contextCalls).toEqual(['ask two']);
  });

  it('clears the whole queue when the realtime generation changes', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('stale one'));
    injector.enqueue({
      kind: 'permission',
      context: 'stale ask',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(2);

    injector.noteGenerationChanged();

    expect(injector.pendingCount).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
  });
});

describe('Injector transport refusal', () => {
  it('requeues the batch and retries after the quiet gap when the sink refuses', () => {
    sink.contextResult = false;
    sink.speechResult = false;

    injector.enqueue(complete('important', 'Say this.'));

    expect(sink.contextCalls).toEqual(['important']);
    expect(sink.speechCalls).toEqual(['Say this.']);
    expect(sink.injected).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    sink.contextResult = true;
    sink.speechResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.contextCalls).toEqual(['important', 'important']);
    expect(sink.speechCalls).toEqual(['Say this.', 'Say this.']);
    expect(sink.injected).toHaveLength(1);
    expect(injector.pendingCount).toBe(0);
  });

  it('counts a spoken-only acceptance as delivered', () => {
    sink.contextResult = false;
    sink.speechResult = true;

    injector.enqueue(complete('body', 'Spoken line.'));

    expect(injector.pendingCount).toBe(0);
    expect(sink.injected).toHaveLength(1);
  });
});
