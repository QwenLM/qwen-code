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
      // Permission asks are moved to the front of the batch so the
      // size-capped context join can never truncate their handles.
      'job_3 wants to edit a file\njob_1 finished\njob_2 is halfway',
    ]);
    expect(sink.speechCalls).toEqual([
      'Job three needs permission. Job one finished. Job two is halfway.',
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

  it('keys jobless progress on the full context, not a shared prefix', () => {
    injector.noteResponseCreated();
    // Identical first 32 chars, diverging afterwards — the shape of two
    // permission-retraction notices for one session.
    const shared = '[BACKEND session_1] The permission request ';
    injector.enqueue({ kind: 'progress', context: `${shared}(req_1) done.` });
    injector.enqueue({ kind: 'progress', context: `${shared}(req_2) done.` });
    expect(injector.pendingCount).toBe(2);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual([
      `${shared}(req_1) done.\n${shared}(req_2) done.`,
    ]);
  });

  it('dedups true jobless duplicates to a single queued item', () => {
    makeInjector({ progressThrottleMs: 0 });
    injector.noteResponseCreated();
    injector.enqueue({ kind: 'progress', context: 'same jobless notice' });
    injector.enqueue({ kind: 'progress', context: 'same jobless notice' });

    expect(injector.pendingCount).toBe(1);
  });

  it('clears the throttle stamp when speech start drops queued progress', () => {
    injector.noteResponseCreated();
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(injector.pendingCount).toBe(1);

    // Barge-in drops the undelivered progress; the throttle window must not
    // survive it, or the job goes silent for the whole window.
    injector.noteSpeechStarted();
    expect(injector.pendingCount).toBe(0);
    injector.noteSpeechStopped();
    injector.noteResponseDone();

    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p2']);
  });

  it('keeps the throttle stamp for progress that was actually delivered', () => {
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1']);

    injector.noteSpeechStarted();
    injector.noteSpeechStopped();
    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p1']);
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
    expect(sink.contextCalls).toEqual(['needs approval\nfinished']);
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

  it('dispose clears the queue and nothing is delivered afterwards', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('stale one'));
    injector.enqueue({
      kind: 'permission',
      context: 'stale ask',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(2);

    injector.dispose();

    expect(injector.pendingCount).toBe(0);
    injector.noteResponseDone();
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

describe('Injector size caps', () => {
  it('caps the combined context injection at 6000 chars', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('a'.repeat(4_000)));
    injector.enqueue(complete('b'.repeat(4_000)));
    injector.noteSpeechStopped();

    expect(sink.contextCalls).toHaveLength(1);
    expect(sink.contextCalls[0]).toHaveLength(6_000);
    // The first item survives whole; the second is what the cap trims.
    expect(sink.contextCalls[0]!.startsWith('a'.repeat(4_000))).toBe(true);
  });

  it('joins spoken lines whole and stops before breaching 280 chars', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('one', 'x'.repeat(200)));
    injector.enqueue(complete('two', 'y'.repeat(200)));
    injector.noteSpeechStopped();

    expect(sink.speechCalls).toHaveLength(1);
    // Whole-line greedy join: the second line would breach the cap, so
    // only the first is spoken — never a mid-line cut of line two.
    expect(sink.speechCalls[0]).toBe('x'.repeat(200));
  });

  it('truncates a single over-long spoken line with an ellipsis', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('ctx', 'z'.repeat(400)));
    injector.noteSpeechStopped();

    expect(sink.speechCalls).toHaveLength(1);
    expect(sink.speechCalls[0]).toBe(`${'z'.repeat(280)}…`);
  });
});
