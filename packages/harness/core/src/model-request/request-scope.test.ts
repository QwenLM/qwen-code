/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SINGLE_REQUEST_FORK,
  PREDICTION_FORK_REQUEST,
  mergeModelRequestProgress,
  publishModelRequestProgress,
  onModelRequestScopeEnd,
  endModelRequestScope,
  onModelRequestObservation,
  publishModelRequestObservation,
  hasModelRequestObservationListeners,
} from './request-scope.js';
import type { ModelRequestObservation } from './types.js';
import type { SystemMessage } from '../protocol/transcript/message.js';
const identity = { sessionId: 's', requestSetId: 'set', requestId: 'r' };
const message = {
  type: 'system',
  subtype: 'model_queue_status',
  sessionId: 's',
  status: 'queued',
} as SystemMessage;
describe('model request scope side channel', () => {
  it('shares the single-request fork marker across exports and request copies without serializing it', () => {
    expect(SINGLE_REQUEST_FORK).toBe(
      Symbol.for('cli.prompt_suggestion.single_attempt'),
    );
    expect(PREDICTION_FORK_REQUEST).toBe(SINGLE_REQUEST_FORK);
    const request = { [PREDICTION_FORK_REQUEST]: true };
    expect({ ...request }[SINGLE_REQUEST_FORK]).toBe(true);
    expect(JSON.stringify(request)).toBe('{}');
  });

  it('routes actual attempt IDs through the fixed initial scope and unsubscribes', () => {
    const scope = { ...identity, requestId: 'initial-request' };
    const observer = vi.fn();
    const off = onModelRequestObservation(scope, observer);
    const event: ModelRequestObservation = {
      kind: 'request_started',
      request_id: 'retried-request',
      initial_request_id: scope.requestId,
      model: 'test-model',
      at_ms: 123,
      attempt: 2,
      data: { retry_count: 1 },
    };
    try {
      expect(hasModelRequestObservationListeners(scope)).toBe(true);
      publishModelRequestObservation(
        { ...scope, requestId: event.request_id },
        event,
      );
      publishModelRequestObservation(
        { ...scope, sessionId: 'other-session' },
        event,
      );
      expect(observer).not.toHaveBeenCalled();
      publishModelRequestObservation(scope, event);
      expect(observer).toHaveBeenCalledExactlyOnceWith(event);
    } finally {
      off();
    }
    expect(hasModelRequestObservationListeners(scope)).toBe(false);
    publishModelRequestObservation(scope, event);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('isolates synchronous and asynchronous subscriber failures', async () => {
    const observer = vi.fn();
    const off = [
      onModelRequestObservation(identity, () => {
        throw new Error('observer failed');
      }),
      onModelRequestObservation(identity, async () => {
        throw new Error('async observer failed');
      }),
      onModelRequestObservation(identity, observer),
    ];
    const event: ModelRequestObservation = {
      kind: 'physical',
      request_id: 'actual',
      initial_request_id: 'r',
      model: 'test-model',
      at_ms: 1,
      data: { stage: 'physical_send' },
    };
    try {
      expect(() =>
        publishModelRequestObservation(identity, event),
      ).not.toThrow();
      expect(observer).toHaveBeenCalledExactlyOnceWith(event);
      await Promise.resolve();
    } finally {
      off.forEach((release) => release());
    }
  });

  it('gives each registration its own unsubscribe', () => {
    const observer = vi.fn();
    const first = onModelRequestObservation(identity, observer);
    const second = onModelRequestObservation(identity, observer);
    first();
    expect(hasModelRequestObservationListeners(identity)).toBe(true);
    second();
    expect(hasModelRequestObservationListeners(identity)).toBe(false);
  });

  it('delivers progress while the source is blocked, without changing its return value', async () => {
    let unblock!: () => void;
    const wait = new Promise<void>((done) => {
      unblock = done;
    });
    const source = (async function* () {
      await wait;
      yield 'answer';
      return 7;
    })();
    const merged = mergeModelRequestProgress(identity, source);
    const first = merged.next();
    await Promise.resolve();
    publishModelRequestProgress({ ...identity, sessionId: 'other' }, message);
    publishModelRequestProgress(identity, message);
    expect(await first).toEqual({ done: false, value: message });
    unblock();
    expect(await merged.next()).toEqual({ done: false, value: 'answer' });
    expect(await merged.next()).toEqual({ done: true, value: 7 });
  });
  it('forwards a consumer throw to the suspended source and preserves its recovery result', async () => {
    const failure = new Error('consumer interrupted');
    const source = (async function* () {
      try {
        yield 'answer';
      } catch (error) {
        expect(error).toBe(failure);
        yield 'recovered';
        return 7;
      }
      return 0;
    })();
    const merged = mergeModelRequestProgress(identity, source);
    expect(await merged.next()).toEqual({ done: false, value: 'answer' });
    expect(await merged.throw(failure)).toEqual({
      done: false,
      value: 'recovered',
    });
    expect(await merged.next()).toEqual({ done: true, value: 7 });
  });

  it('notifies only the matching lifecycle listener and unsubscribes', async () => {
    const release = vi.fn(async () => {});
    const off = onModelRequestScopeEnd(release);
    await endModelRequestScope('s', 'set');
    expect(release).toHaveBeenCalledWith('s', 'set');
    off();
    await endModelRequestScope('s', 'set');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
