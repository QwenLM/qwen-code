/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startModelInvocationObservation,
  withModelObservationScope,
  withModelObservationSource,
} from './model-observation.js';

afterEach(() => vi.useRealTimers());
const input = {
  sessionId: 'session-1',
  executionId: '00000000-0000-4000-8000-000000000001',
  model: 'qwen-test',
  startedAt: 0,
  retryAttempt: 3,
};

describe('model invocation observer', () => {
  it('ignores unowned and other-session generators', () => {
    expect(startModelInvocationObservation(input)).toBeUndefined();
    const observe = vi.fn();
    withModelObservationScope(
      {
        sessionId: 'other',
        source: 'main',
        observe,
        observationFailed: vi.fn(),
      },
      () => expect(startModelInvocationObservation(input)).toBeUndefined(),
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it('captures nested source and retry ordinal at invocation, with first terminal winning', () => {
    const observe = vi.fn();
    const failed = vi.fn();
    const tracker = withModelObservationScope(
      {
        sessionId: input.sessionId,
        source: 'main',
        observe,
        observationFailed: failed,
      },
      () =>
        withModelObservationSource('compression', () =>
          startModelInvocationObservation(input),
        ),
    )!;
    tracker.update(
      {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: NaN,
      },
      'resolved-model',
    );
    tracker.finish('success');
    tracker.finish('error', new Error('business parse error'));
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0][0]).toMatchObject({
      source: 'compression',
      model: 'resolved-model',
      outcome: 'success',
      backoffRetryOrdinal: 2,
      usage: { promptTokenCount: 10, candidatesTokenCount: 3 },
    });
    expect(observe.mock.calls[0][0].usage).not.toHaveProperty(
      'thoughtsTokenCount',
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it('closes an idle iterator once without depending on telemetry', () => {
    vi.useFakeTimers();
    const observe = vi.fn();
    const tracker = withModelObservationScope(
      {
        sessionId: input.sessionId,
        source: 'main',
        observe,
        observationFailed: vi.fn(),
      },
      () => startModelInvocationObservation(input),
    )!;
    tracker.touchStream();
    vi.advanceTimersByTime(300_000);
    tracker.update({ candidatesTokenCount: 99 });
    tracker.finish('success');
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0][0].outcome).toBe('interrupted');
    expect(observe.mock.calls[0][0].usage).toBeUndefined();
  });

  it('contains observer failure without changing provider behavior', () => {
    const failed = vi.fn();
    const tracker = withModelObservationScope(
      {
        sessionId: input.sessionId,
        source: 'hook',
        observe: () => {
          throw new Error('observer');
        },
        observationFailed: failed,
      },
      () => startModelInvocationObservation(input),
    )!;
    expect(() => tracker.finish('success')).not.toThrow();
    expect(failed).toHaveBeenCalledOnce();
  });
});
