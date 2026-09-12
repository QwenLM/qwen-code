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
  readonly contextCalls: string[] = [];
  readonly speechCalls: string[] = [];
  readonly proactiveCalls: string[] = [];

  injectContext(text: string): boolean {
    this.contextCalls.push(text);
    return true;
  }

  injectSpeech(text: string): boolean {
    this.speechCalls.push(text);
    return true;
  }

  injectProactive(text: string): boolean {
    this.proactiveCalls.push(text);
    return true;
  }
}

function proactive(sequence: number): InjectorItem {
  return {
    kind: 'proactive',
    context: `[PROACTIVE ${sequence}] context ${sequence}`,
    deliveryId: `delivery_${sequence}`,
  };
}

let sink: FakeSink;
let injector: Injector;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  sink = new FakeSink();
  injector = new Injector({ sink, now: () => Date.now() });
});

afterEach(() => {
  injector.dispose();
  vi.useRealTimers();
});

describe('Injector proactive FIFO lane', () => {
  it('does not enter the input-commit to direct-response acknowledgement gap', () => {
    injector.noteSpeechStarted();
    injector.enqueue(proactive(1));

    injector.noteInputCommitted(true);
    expect(sink.proactiveCalls).toEqual([]);

    injector.noteResponseCreated('direct');
    injector.notePlaybackStarted();
    injector.noteResponseDone('direct');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual(['[PROACTIVE 1] context 1']);
  });

  it('does not clear a newer pending user turn when the old response completes', () => {
    injector.noteResponseCreated('direct');
    injector.noteSpeechStarted();
    injector.noteInputCommitted(true);
    injector.enqueue(proactive(1));
    injector.noteResponseDone('direct');
    expect(sink.proactiveCalls).toEqual([]);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    expect(sink.proactiveCalls).toEqual(['[PROACTIVE 1] context 1']);
  });

  it('submits only one proactive item and waits for response and playback completion before the next', () => {
    injector.enqueue(proactive(1));
    injector.enqueue(proactive(2));

    expect(sink.proactiveCalls).toEqual(['[PROACTIVE 1] context 1']);
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.noteResponseDone('proactive');
    vi.advanceTimersByTime(QUIET_GAP_MS * 2);

    expect(sink.proactiveCalls).toHaveLength(1);

    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS - 1);
    expect(sink.proactiveCalls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
    ]);
  });

  it('keeps FIFO closed when playback completes before response.done', () => {
    injector.enqueue(proactive(1));
    injector.enqueue(proactive(2));

    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual(['[PROACTIVE 1] context 1']);

    injector.noteResponseDone('proactive');

    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
    ]);
  });

  it('requires a fresh response/playback cycle for every queued proactive item', () => {
    injector.enqueue(proactive(1));
    injector.enqueue(proactive(2));
    injector.enqueue(proactive(3));

    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.noteResponseDone('proactive');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
    ]);
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.noteResponseDone('proactive');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
      '[PROACTIVE 3] context 3',
    ]);
  });

  it('atomically retries an interrupted delivery ahead of later FIFO items', () => {
    injector.enqueue(proactive(1));
    injector.enqueue(proactive(2));

    injector.noteResponseCreated('proactive');
    injector.noteSpeechStarted();
    injector.noteResponseDone('proactive');
    expect(injector.retryProactiveAtFront(proactive(1))).toBe(true);

    injector.noteInputCommitted(true);
    injector.noteResponseCreated('direct');
    injector.notePlaybackStarted();
    injector.noteResponseDone('direct');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 1] context 1',
    ]);

    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.noteResponseDone('proactive');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
    ]);
  });

  it('releases the next FIFO item when a failed cycle is aborted', () => {
    injector.enqueue(proactive(1));
    injector.enqueue(proactive(2));
    injector.noteResponseCreated('proactive');
    injector.noteResponseDone('proactive');

    expect(injector.abortProactive('delivery_1')).toBe(true);
    expect(sink.proactiveCalls).toEqual([
      '[PROACTIVE 1] context 1',
      '[PROACTIVE 2] context 2',
    ]);
  });
});
