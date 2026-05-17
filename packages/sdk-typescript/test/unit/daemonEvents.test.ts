/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  asKnownDaemonEvent,
  createDaemonSessionViewState,
  isDaemonEventType,
  reduceDaemonSessionEvent,
  reduceDaemonSessionEvents,
} from '../../src/daemon/events.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

describe('daemon event schema', () => {
  it('narrows known daemon events by discriminator', () => {
    const event: DaemonEvent = {
      id: 1,
      v: 1,
      type: 'model_switched',
      data: { sessionId: 's-1', modelId: 'qwen3-coder' },
      originatorClientId: 'client-1',
    };

    const known = asKnownDaemonEvent(event);

    expect(known).toBe(event);
    expect(known?.type).toBe('model_switched');
    if (known?.type === 'model_switched') {
      expect(known.data.modelId).toBe('qwen3-coder');
      expect(known.originatorClientId).toBe('client-1');
    }
    expect(isDaemonEventType(event, 'model_switched')).toBe(true);
    expect(isDaemonEventType(event, 'permission_request')).toBe(false);
  });

  it('leaves malformed or unknown events on the raw DaemonEvent path', () => {
    expect(
      asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'model_switched',
        data: { sessionId: 's-1' },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 2,
        v: 1,
        type: 'future_event',
        data: { opaque: true },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 3,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          options: [{ optionId: 'allow' }],
        },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 4,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          toolCall: null,
          options: [{ optionId: 'allow' }],
        },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 5,
        v: 1,
        type: 'stream_error',
        data: { error: 500 },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 6,
        v: 1,
        type: 'session_died',
        data: { sessionId: 's-1', reason: 'killed', exitCode: '1' },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 7,
        v: 1,
        type: 'session_died',
        data: { sessionId: 's-1', reason: 'killed', signalCode: 9 },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 8,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow', droppedAfter: '3' },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 9,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'selected', optionId: '' },
        },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 10,
        v: 1,
        type: 'permission_already_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'cancelled' },
        },
      }),
    ).toBeUndefined();
  });

  it('reduces permission, model, and terminal events into a session view', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: { sessionId: 's-1', phase: 'prompting' },
      },
      {
        id: 2,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          toolCall: { name: 'write_file' },
          options: [{ optionId: 'allow' }, { optionId: 'deny' }],
        },
      },
      {
        id: 3,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      },
      {
        id: 4,
        v: 1,
        type: 'model_switched',
        data: { sessionId: 's-1', modelId: 'qwen3-coder' },
      },
      {
        id: 5,
        v: 1,
        type: 'model_switch_failed',
        data: {
          sessionId: 's-1',
          requestedModelId: 'missing-model',
          error: 'not configured',
        },
      },
      {
        id: 6,
        v: 1,
        type: 'session_died',
        data: { sessionId: 's-1', reason: 'killed' },
      },
    ]);

    expect(state).toMatchObject({
      lastEventId: 6,
      sessionId: 's-1',
      alive: false,
      currentModelId: 'qwen3-coder',
      pendingPermissions: {},
      lastSessionUpdate: { sessionId: 's-1', phase: 'prompting' },
      lastModelSwitchFailure: {
        requestedModelId: 'missing-model',
        error: 'not configured',
      },
    });
    expect(state.terminalEvent?.type).toBe('session_died');
  });

  it('keeps replay cursors monotonic across out-of-order ids', () => {
    const state = reduceDaemonSessionEvents(
      [
        {
          id: 5,
          v: 1,
          type: 'model_switched',
          data: { sessionId: 's-1', modelId: 'qwen3-coder' },
        },
        {
          id: 11,
          v: 1,
          type: 'model_switched',
          data: { sessionId: 's-1', modelId: 'qwen3-next' },
        },
      ],
      createDaemonSessionViewState({ lastEventId: 10 }),
    );

    expect(state.lastEventId).toBe(11);
    expect(state.currentModelId).toBe('qwen3-next');
  });

  it('preserves seeded displayName when creating session view state', () => {
    const state = createDaemonSessionViewState({
      displayName: 'Investigation',
    });

    expect(state.displayName).toBe('Investigation');
  });

  it('records session updates without replacing a known session id with junk', () => {
    const event: DaemonEvent = {
      id: 10,
      v: 1,
      type: 'session_update',
      data: { sessionId: 123, phase: 'streaming' },
    };

    const state = reduceDaemonSessionEvent(
      createDaemonSessionViewState({ sessionId: 's-1' }),
      event,
    );

    expect(state.lastEventId).toBe(10);
    expect(state.sessionId).toBe('s-1');
    expect(state.lastSessionUpdate).toBe(event.data);
  });

  it('does not advance replay state for synthetic events without ids', () => {
    const initial = createDaemonSessionViewState({ lastEventId: 7 });

    const state = reduceDaemonSessionEvent(initial, {
      v: 1,
      type: 'stream_error',
      data: { error: 'subscriber limit reached' },
    });

    expect(state.lastEventId).toBe(7);
    expect(state.alive).toBe(false);
    expect(state.terminalEvent?.type).toBe('stream_error');
    expect(state.streamError).toEqual({ error: 'subscriber limit reached' });
  });

  it('tracks malformed known event payloads without hiding raw events', () => {
    const rawEvent: DaemonEvent = {
      id: 8,
      v: 1,
      type: 'model_switch_failed',
      data: { sessionId: 's-1', requestedModelId: 'missing-model' },
    };

    const state = reduceDaemonSessionEvent(
      createDaemonSessionViewState({ lastEventId: 7 }),
      rawEvent,
    );

    expect(state.lastEventId).toBe(8);
    expect(state.unrecognizedKnownEventCount).toBe(1);
    expect(state.lastUnrecognizedKnownEvent).toBe(rawEvent);
  });

  it('clears model switch failures when a later switch succeeds', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'model_switch_failed',
        data: {
          sessionId: 's-1',
          requestedModelId: 'missing-model',
          error: 'not configured',
        },
      },
      {
        id: 2,
        v: 1,
        type: 'model_switched',
        data: { sessionId: 's-1', modelId: 'qwen3-coder' },
      },
    ]);

    expect(state.currentModelId).toBe('qwen3-coder');
    expect(state.lastModelSwitchFailure).toBeUndefined();
  });

  it('tracks unmatched and cancelled permission resolutions', () => {
    const cancelled = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          toolCall: { name: 'write_file' },
          options: [{ optionId: 'allow' }],
        },
      },
      {
        id: 2,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'cancelled' },
        },
      },
    ]);

    expect(cancelled.pendingPermissions).toEqual({});
    expect(cancelled.lastEventId).toBe(2);

    const unmatched = reduceDaemonSessionEvent(cancelled, {
      id: 3,
      v: 1,
      type: 'permission_resolved',
      data: {
        requestId: 'missing-req',
        outcome: { outcome: 'cancelled' },
      },
    });

    expect(unmatched.lastEventId).toBe(3);
    expect(unmatched.pendingPermissions).toEqual({});
    expect(unmatched.unmatchedPermissionResolutionCount).toBe(1);
    expect(unmatched.lastUnmatchedPermissionResolutionId).toBe('missing-req');
  });

  it('treats permission_already_resolved as an idempotent pending cleanup', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          toolCall: { name: 'write_file' },
          options: [{ optionId: 'allow' }],
        },
      },
      {
        id: 2,
        v: 1,
        type: 'permission_already_resolved',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      },
    ]);

    expect(state.sessionId).toBe('s-1');
    expect(state.pendingPermissions).toEqual({});
    expect(state.unmatchedPermissionResolutionCount).toBe(0);
  });

  it('tracks unmatched permission_already_resolved without rewriting session identity', () => {
    const state = reduceDaemonSessionEvent(
      createDaemonSessionViewState({ sessionId: 's-current' }),
      {
        id: 1,
        v: 1,
        type: 'permission_already_resolved',
        data: {
          requestId: 'missing-req',
          sessionId: 's-other',
          outcome: { outcome: 'cancelled' },
        },
      },
    );

    expect(state.sessionId).toBe('s-current');
    expect(state.pendingPermissions).toEqual({});
    expect(state.unmatchedPermissionResolutionCount).toBe(1);
    expect(state.lastUnmatchedPermissionResolutionId).toBe('missing-req');
  });

  it('caps tracked pending permissions at the daemon session limit', () => {
    const requests: DaemonEvent[] = Array.from({ length: 65 }, (_, index) => ({
      id: index + 1,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: `req-${index}`,
        sessionId: 's-1',
        toolCall: { name: 'write_file' },
        options: [{ optionId: 'allow' }],
      },
    }));

    const state = reduceDaemonSessionEvents(requests);

    expect(Object.keys(state.pendingPermissions)).toHaveLength(64);
    expect(state.pendingPermissions['req-64']).toBeUndefined();
    expect(state.droppedPermissionRequestCount).toBe(1);
    expect(state.lastDroppedPermissionRequestId).toBe('req-64');
    expect(state.lastEventId).toBe(65);
  });

  it('treats stream lifecycle events as terminal and preserves death reason', () => {
    const state = reduceDaemonSessionEvents(
      [
        {
          id: 2,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 's-1',
            toolCall: { name: 'write_file' },
            options: [{ optionId: 'allow' }],
          },
        },
        {
          id: 3,
          v: 1,
          type: 'session_died',
          data: { sessionId: 's-1', reason: 'killed' },
        },
        {
          v: 1,
          type: 'client_evicted',
          data: { reason: 'queue_overflow', droppedAfter: 3 },
        },
      ],
      createDaemonSessionViewState({ lastEventId: 1 }),
    );

    expect(state.alive).toBe(false);
    expect(state.pendingPermissions).toEqual({});
    expect(state.lastEventId).toBe(3);
    expect(state.terminalEvent?.type).toBe('session_died');
  });

  it('keeps first stream terminal event and upgrades to session death', () => {
    const clientThenStream = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow' },
      },
      {
        id: 2,
        v: 1,
        type: 'stream_error',
        data: { error: 'subscriber limit reached' },
      },
    ]);

    expect(clientThenStream.terminalEvent?.type).toBe('client_evicted');

    const streamThenClient = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'stream_error',
        data: { error: 'subscriber limit reached' },
      },
      {
        id: 2,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow' },
      },
    ]);

    expect(streamThenClient.terminalEvent?.type).toBe('stream_error');

    const upgradedToDeath = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'stream_error',
        data: { error: 'subscriber limit reached' },
      },
      {
        id: 2,
        v: 1,
        type: 'session_died',
        data: { sessionId: 's-1', reason: 'killed' },
      },
      {
        id: 3,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow' },
      },
    ]);

    expect(upgradedToDeath.terminalEvent?.type).toBe('session_died');
    expect(upgradedToDeath.lastEventId).toBe(3);
  });

  it('validates session_closed events', () => {
    expect(
      asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_closed',
        data: { sessionId: 's-1', reason: 'client_close' },
      }),
    ).toBeDefined();

    expect(
      asKnownDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_closed',
        data: { sessionId: 's-1' },
      }),
    ).toBeUndefined();

    expect(
      asKnownDaemonEvent({
        id: 3,
        v: 1,
        type: 'session_closed',
        data: { reason: 'client_close' },
      }),
    ).toBeUndefined();
  });

  it('validates session_metadata_updated events', () => {
    expect(
      asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_metadata_updated',
        data: { sessionId: 's-1', displayName: 'My Session' },
      }),
    ).toBeDefined();

    expect(
      asKnownDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_metadata_updated',
        data: { sessionId: 's-1' },
      }),
    ).toBeDefined();

    expect(
      asKnownDaemonEvent({
        id: 3,
        v: 1,
        type: 'session_metadata_updated',
        data: {},
      }),
    ).toBeUndefined();
  });

  it('reduces session_closed as terminal and clears pending permissions', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-1',
          sessionId: 's-1',
          toolCall: { toolCallId: 'tc-1', title: 'test' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
      {
        id: 2,
        v: 1,
        type: 'session_closed',
        data: { sessionId: 's-1', reason: 'client_close' },
      },
    ]);
    expect(state.alive).toBe(false);
    expect(state.terminalEvent?.type).toBe('session_closed');
    expect(Object.keys(state.pendingPermissions)).toHaveLength(0);
  });

  it('session_closed upgrades stream terminal events like session_died', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'stream_error',
        data: { error: 'subscriber limit reached' },
      },
      {
        id: 2,
        v: 1,
        type: 'session_closed',
        data: { sessionId: 's-1', reason: 'client_close' },
      },
    ]);
    expect(state.terminalEvent?.type).toBe('session_closed');
  });

  it('reduces session_metadata_updated to set displayName', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'session_metadata_updated',
        data: { sessionId: 's-1', displayName: 'My Session' },
      },
    ]);
    expect(state.displayName).toBe('My Session');
    expect(state.alive).toBe(true);

    const cleared = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'session_metadata_updated',
        data: { sessionId: 's-1', displayName: 'My Session' },
      },
      {
        id: 2,
        v: 1,
        type: 'session_metadata_updated',
        data: { sessionId: 's-1' },
      },
    ]);
    expect(cleared.displayName).toBeUndefined();
  });

  it('recognizes slow_client_warning frames as known events', () => {
    const warning = {
      // No `id` on synthetic frames (matches the daemon's emit shape).
      v: 1,
      type: 'slow_client_warning',
      data: { queueSize: 192, maxQueued: 256, lastEventId: 42 },
    };
    const known = asKnownDaemonEvent(warning);
    expect(known?.type).toBe('slow_client_warning');

    // Schema validation: required numeric fields. Missing or wrongly
    // typed payloads must NOT be recognized as known events.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: 'lots', maxQueued: 256, lastEventId: 42 },
      }),
    ).toBeUndefined();
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: 192, lastEventId: 42 },
      }),
    ).toBeUndefined();

    // NaN / Infinity pass a bare `typeof === 'number'` check but are
    // schema garbage for a queue-size measurement — finite-number
    // validation must reject them (sibling predicates do the same).
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: Number.NaN, maxQueued: 256, lastEventId: 42 },
      }),
    ).toBeUndefined();
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'slow_client_warning',
        data: {
          queueSize: 192,
          maxQueued: Number.POSITIVE_INFINITY,
          lastEventId: 42,
        },
      }),
    ).toBeUndefined();
  });

  it('reduces slow_client_warning into the view state without ending the stream', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: { sessionId: 's-1', phase: 'prompting' },
      },
      // Warning #1.
      {
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: 200, maxQueued: 256, lastEventId: 1 },
      },
      // Warning #2 (e.g. after a drain + refill on the daemon side).
      {
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: 220, maxQueued: 256, lastEventId: 5 },
      },
    ]);

    // Counter increments + most recent snapshot wins.
    expect(state.slowClientWarningCount).toBe(2);
    expect(state.lastSlowClientWarning).toEqual({
      queueSize: 220,
      maxQueued: 256,
      lastEventId: 5,
    });
    // Warning is non-terminal — stream is still alive, no
    // terminalEvent recorded.
    expect(state.alive).toBe(true);
    expect(state.terminalEvent).toBeUndefined();
    // Warnings carry no `id`, so `lastEventId` stays at the highest
    // id observed (the original session_update at id=1).
    expect(state.lastEventId).toBe(1);
  });
});
