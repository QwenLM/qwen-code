/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  asKnownDaemonEvent,
  createDaemonAuthState,
  createDaemonSessionViewState,
  isDaemonEventType,
  reduceDaemonAuthEvent,
  reduceDaemonAuthEvents,
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

  it('validates mid_turn_message_injected events', () => {
    expect(
      asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: ['check the tests too'] },
      }),
    ).toBeDefined();

    // Empty array is structurally valid (the guard only requires a string[]).
    expect(
      asKnownDaemonEvent({
        id: 2,
        v: 1,
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: [] },
      }),
    ).toBeDefined();

    // Missing messages, non-string entries, and missing sessionId are rejected.
    expect(
      asKnownDaemonEvent({
        id: 3,
        v: 1,
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1' },
      }),
    ).toBeUndefined();
    expect(
      asKnownDaemonEvent({
        id: 4,
        v: 1,
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: ['ok', 42] },
      }),
    ).toBeUndefined();
    expect(
      asKnownDaemonEvent({
        id: 5,
        v: 1,
        type: 'mid_turn_message_injected',
        data: { messages: ['x'] },
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
    // PR 14b fix (codex round 8 — sibling consistency): `satisfies
    // DaemonEvent` keeps `v: 1` / `type: 'slow_client_warning'`
    // narrow rather than widening to `number` / `string`. The same
    // pattern was applied to PR 14b's own fixtures in round 3
    // (`mcp_budget_warning` + `mcp_child_refused_batch`); this is the
    // closest sibling fixture in the same describe block, so
    // matching it here keeps the sdk-test typing style coherent.
    //
    // Note: a tsconfig audit found ~17 OTHER fixtures in this file
    // with the same widening shape (PR 4 / PR 10 / PR 11 era). They
    // remain unfixed because (a) they're outside PR 14b's scope, and
    // (b) the sdk package's `tsconfig.json` excludes the test
    // directory from `tsc --noEmit`, so none of them block CI today.
    // A future PR that opts tests into the typecheck scope can fix
    // all of them at once. Round 3 only signed up for PR 14b's own
    // fixtures.
    const warning = {
      // No `id` on synthetic frames (matches the daemon's emit shape).
      v: 1,
      type: 'slow_client_warning',
      data: { queueSize: 192, maxQueued: 256, lastEventId: 42 },
    } satisfies DaemonEvent;
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

  // PR 14b: MCP guardrail push events. Mirrors the slow_client_warning
  // test patterns (predicate validation + reducer state) — the two
  // event types are siblings on the per-session SSE bus and use the
  // same KnownDaemonEvent narrowing.
  it('recognizes mcp_budget_warning frames as known events', () => {
    // PR 14b fix (codex round 3): `satisfies DaemonEvent` keeps the
    // discriminator literals (`v: 1`, `type: 'mcp_budget_warning'`)
    // narrow without widening to `number`/`string`. Required so the
    // fixture passes through `asKnownDaemonEvent`'s `event.type`
    // switch under strict typecheck. The sdk package's tsconfig
    // currently scopes `tsc --noEmit` to `src/**/*.ts` only — tests
    // aren't gated yet — but the fixture stays type-safe for when
    // they are.
    const warning = {
      id: 7,
      v: 1,
      type: 'mcp_budget_warning',
      data: {
        liveCount: 4,
        reservedCount: 4,
        budget: 4,
        thresholdRatio: 0.75,
        mode: 'warn',
      },
    } satisfies DaemonEvent;
    const known = asKnownDaemonEvent(warning);
    expect(known?.type).toBe('mcp_budget_warning');

    // Schema: required numeric fields, exact-literal `thresholdRatio`,
    // and `mode` constrained to `'warn' | 'enforce'`. Bad shapes are
    // rejected so the reducer routes them through the
    // `unrecognizedKnownEventCount` branch.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_budget_warning',
        data: {
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      }),
    ).toBeUndefined();
    // PR 14b fix (codex round 6): `thresholdRatio` is validated as a
    // finite number rather than the literal 0.75 — the SDK's role is
    // wire-shape validation, not threshold-value enforcement. Pinning
    // the literal would mean a daemon-side bump to e.g. 0.80 silently
    // routes every warning through `unrecognizedKnownEventCount` (a
    // cross-package coordination hazard). Forward-compat for a future
    // 0.5 critical threshold falls out for free; the daemon constant
    // and protocol docs are the source of truth for threshold values.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_budget_warning',
        data: {
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.5, // forward-compat threshold value
          mode: 'warn',
        },
      }),
    ).toBeDefined();
    // Non-finite values (NaN / Infinity) are still rejected — the
    // predicate uses `isFiniteNumber`, not bare `typeof === 'number'`.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_budget_warning',
        data: {
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: Number.NaN,
          mode: 'warn',
        },
      }),
    ).toBeUndefined();
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_budget_warning',
        data: {
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'off', // off-mode never fires the warning — bad payload.
        },
      }),
    ).toBeUndefined();
  });

  it('reduces mcp_budget_warning into the view state without ending the stream', () => {
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
        type: 'mcp_budget_warning',
        data: {
          liveCount: 3,
          reservedCount: 3,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      },
      {
        id: 3,
        v: 1,
        type: 'mcp_budget_warning',
        data: {
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'enforce',
        },
      },
    ]);

    expect(state.mcpBudgetWarningCount).toBe(2);
    expect(state.lastMcpBudgetWarning).toEqual({
      liveCount: 4,
      reservedCount: 4,
      budget: 4,
      thresholdRatio: 0.75,
      mode: 'enforce',
    });
    // Non-terminal — stream stays alive.
    expect(state.alive).toBe(true);
    expect(state.terminalEvent).toBeUndefined();
    expect(state.lastEventId).toBe(3);
  });

  it('recognizes mcp_child_refused_batch frames as known events', () => {
    // PR 14b fix (codex round 3): `satisfies DaemonEvent` preserves
    // the literal discriminator (`v: 1`, `type:
    // 'mcp_child_refused_batch'`) — see sibling fixture above for
    // the full rationale.
    const batch = {
      id: 9,
      v: 1,
      type: 'mcp_child_refused_batch',
      data: {
        refusedServers: [
          { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
          { name: 'c', transport: 'http', reason: 'budget_exhausted' },
        ],
        budget: 1,
        liveCount: 1,
        reservedCount: 1,
        mode: 'enforce',
      },
    } satisfies DaemonEvent;
    const known = asKnownDaemonEvent(batch);
    expect(known?.type).toBe('mcp_child_refused_batch');

    // `mode: 'warn'` must be rejected — warn mode never refuses, so a
    // refused-batch tagged with warn is protocol garbage. The
    // reducer's safety net (`unrecognizedKnownEventCount`) catches it
    // instead of letting the `last*` field hold a malformed shape.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [
            { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'warn',
        },
      }),
    ).toBeUndefined();

    // Unknown transport family rejected (forward-compat: a future
    // daemon emitting a new transport speaks a newer wire than this
    // SDK release).
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [
            { name: 'b', transport: 'quic', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      }),
    ).toBeUndefined();

    // Bad reason rejected — only `'budget_exhausted'` is valid in
    // PR 14b. Future causes extend the literal set.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [
            { name: 'b', transport: 'stdio', reason: 'something_else' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      }),
    ).toBeUndefined();

    // Empty `refusedServers` is structurally valid (the daemon would
    // never emit an empty batch — `emitRefusedBatchIfAny` is gated on
    // `lastRefusedServerNames.length > 0` — but the SDK predicate
    // doesn't enforce that invariant; it's a daemon-side correctness
    // property, not a wire-format requirement). Verify the predicate
    // accepts it so a future daemon contract change doesn't break
    // adapters.
    expect(
      asKnownDaemonEvent({
        v: 1,
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      }),
    ).toBeDefined();
  });

  it('reduces mcp_child_refused_batch into the view state without ending the stream', () => {
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
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [
            { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      },
      // Length-1 batch from `readResource` lazy-spawn refusal
      // arrives next.
      {
        id: 3,
        v: 1,
        type: 'mcp_child_refused_batch',
        data: {
          refusedServers: [
            { name: 'c', transport: 'http', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      },
    ]);

    expect(state.mcpChildRefusedBatchCount).toBe(2);
    expect(state.lastMcpChildRefusedBatch).toEqual({
      refusedServers: [
        { name: 'c', transport: 'http', reason: 'budget_exhausted' },
      ],
      budget: 1,
      liveCount: 1,
      reservedCount: 1,
      mode: 'enforce',
    });
    expect(state.alive).toBe(true);
    expect(state.terminalEvent).toBeUndefined();
    expect(state.lastEventId).toBe(3);
  });

  it('rejected MCP guardrail payloads route through unrecognizedKnownEventCount', () => {
    // The reducer's safety net for "type matches a known type but
    // schema fails": increments `unrecognizedKnownEventCount` and
    // captures the raw event in `lastUnrecognizedKnownEvent`. Mirrors
    // the slow_client_warning sibling pattern.
    const state = reduceDaemonSessionEvent(reduceDaemonSessionEvents([]), {
      id: 1,
      v: 1,
      type: 'mcp_child_refused_batch',
      data: {
        // `mode: 'warn'` is invalid (warn never refuses) — predicate
        // rejects, reducer routes through the unrecognized branch.
        refusedServers: [
          { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
        ],
        budget: 1,
        liveCount: 1,
        reservedCount: 1,
        mode: 'warn',
      },
    });
    expect(state.unrecognizedKnownEventCount).toBe(1);
    expect(state.lastUnrecognizedKnownEvent?.type).toBe(
      'mcp_child_refused_batch',
    );
    // Refused-batch counter NOT incremented — the malformed payload
    // didn't reach the typed reducer arm.
    expect(state.mcpChildRefusedBatchCount).toBe(0);
    expect(state.lastMcpChildRefusedBatch).toBeUndefined();
  });
  it('narrows memory_changed events and rejects malformed payloads', () => {
    const valid: DaemonEvent = {
      id: 7,
      v: 1,
      type: 'memory_changed',
      data: {
        scope: 'workspace',
        filePath: '/work/QWEN.md',
        mode: 'append',
        bytesWritten: 42,
      },
      originatorClientId: 'client-mem',
    };
    const known = asKnownDaemonEvent(valid);
    expect(known?.type).toBe('memory_changed');
    expect(isDaemonEventType(valid, 'memory_changed')).toBe(true);

    // Malformed: scope outside the union → not narrowable.
    const bad: DaemonEvent = {
      id: 8,
      v: 1,
      type: 'memory_changed',
      data: {
        scope: 'remote',
        filePath: '/work/QWEN.md',
        mode: 'append',
        bytesWritten: 1,
      },
    };
    expect(asKnownDaemonEvent(bad)).toBeUndefined();

    // Missing required field (bytesWritten).
    const missing: DaemonEvent = {
      id: 9,
      v: 1,
      type: 'memory_changed',
      data: {
        scope: 'workspace',
        filePath: '/work/QWEN.md',
        mode: 'append',
      },
    };
    expect(asKnownDaemonEvent(missing)).toBeUndefined();
  });

  it('narrows agent_changed events and rejects malformed payloads', () => {
    const valid: DaemonEvent = {
      id: 10,
      v: 1,
      type: 'agent_changed',
      data: { change: 'created', name: 'reviewer', level: 'project' },
    };
    expect(asKnownDaemonEvent(valid)?.type).toBe('agent_changed');

    // change outside union.
    const bad: DaemonEvent = {
      id: 11,
      v: 1,
      type: 'agent_changed',
      data: { change: 'mutated', name: 'x', level: 'project' },
    };
    expect(asKnownDaemonEvent(bad)).toBeUndefined();

    // level outside union.
    const badLevel: DaemonEvent = {
      id: 12,
      v: 1,
      type: 'agent_changed',
      data: { change: 'created', name: 'x', level: 'builtin' },
    };
    expect(asKnownDaemonEvent(badLevel)).toBeUndefined();
  });

  it('reduces memory_changed and agent_changed into lastWorkspaceMutation', () => {
    const state = reduceDaemonSessionEvents([
      {
        id: 1,
        v: 1,
        type: 'memory_changed',
        data: {
          scope: 'workspace',
          filePath: '/work/QWEN.md',
          mode: 'append',
          bytesWritten: 12,
        },
      },
      {
        id: 2,
        v: 1,
        type: 'agent_changed',
        data: { change: 'updated', name: 'reviewer', level: 'project' },
      },
    ]);
    // Latest event wins; type discriminator follows.
    expect(state.lastWorkspaceMutationType).toBe('agent_changed');
    expect(state.lastWorkspaceMutation).toEqual({
      change: 'updated',
      name: 'reviewer',
      level: 'project',
    });
    // Both events are non-terminal.
    expect(state.alive).toBe(true);
    expect(state.terminalEvent).toBeUndefined();
    expect(state.lastEventId).toBe(2);
  });

  it('preserves memory_changed snapshot when no agent_changed follows', () => {
    const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
      id: 5,
      v: 1,
      type: 'memory_changed',
      data: {
        scope: 'global',
        filePath: '/home/.qwen/QWEN.md',
        mode: 'replace',
        bytesWritten: 100,
      },
    });
    expect(state.lastWorkspaceMutationType).toBe('memory_changed');
    expect(state.lastWorkspaceMutation).toEqual({
      scope: 'global',
      filePath: '/home/.qwen/QWEN.md',
      mode: 'replace',
      bytesWritten: 100,
    });
  });
});

describe('PR 21 — auth device-flow events', () => {
  it('narrows the 5 device-flow event types', () => {
    const types = [
      'auth_device_flow_started',
      'auth_device_flow_throttled',
      'auth_device_flow_authorized',
      'auth_device_flow_failed',
      'auth_device_flow_cancelled',
    ] as const;
    const datas: Record<(typeof types)[number], unknown> = {
      auth_device_flow_started: {
        deviceFlowId: 'flow-1',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_000_000,
      },
      auth_device_flow_throttled: {
        deviceFlowId: 'flow-1',
        intervalMs: 10_000,
      },
      auth_device_flow_authorized: {
        deviceFlowId: 'flow-1',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_900_000,
        accountAlias: 'user-A',
      },
      auth_device_flow_failed: {
        deviceFlowId: 'flow-1',
        errorKind: 'access_denied',
      },
      auth_device_flow_cancelled: {
        deviceFlowId: 'flow-1',
      },
    };
    for (const [i, type] of types.entries()) {
      const event: DaemonEvent = {
        id: i + 1,
        v: 1,
        type,
        data: datas[type],
      };
      expect(isDaemonEventType(event, type)).toBe(true);
      expect(asKnownDaemonEvent(event)?.type).toBe(type);
    }
  });

  it('rejects malformed device-flow data via type guards', () => {
    expect(
      asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'auth_device_flow_started',
        data: {
          deviceFlowId: 'x',
          providerId: 'qwen-oauth' /* missing expiresAt */,
        },
      }),
    ).toBeUndefined();
    // PR #4255 fold-in 2 (C2): unknown errorKind is no longer a
    // narrowing failure — the open `(string & {})` arm of the
    // DaemonAuthDeviceFlowErrorKind union accepts ANY non-empty
    // string so a daemon adding a new kind isn't silently dropped.
    // The data IS valid; consumers branching on the known literals
    // still narrow exhaustively, with unknown kinds falling into the
    // string fallback arm.
    const futureKind = asKnownDaemonEvent({
      id: 2,
      v: 1,
      type: 'auth_device_flow_failed',
      data: { deviceFlowId: 'x', errorKind: 'rate_limited' },
    });
    expect(futureKind).toBeDefined();
    expect(futureKind?.type).toBe('auth_device_flow_failed');
    // Empty string still rejected (truly malformed).
    expect(
      asKnownDaemonEvent({
        id: 3,
        v: 1,
        type: 'auth_device_flow_failed',
        data: { deviceFlowId: 'x', errorKind: '' },
      }),
    ).toBeUndefined();
  });

  it('reduceDaemonAuthEvent: started → throttled → authorized projects per-provider state', () => {
    const events: DaemonEvent[] = [
      {
        id: 1,
        v: 1,
        type: 'auth_device_flow_started',
        data: {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          expiresAt: 1_700_000_900_000,
        },
      },
      {
        id: 2,
        v: 1,
        type: 'auth_device_flow_throttled',
        data: { deviceFlowId: 'flow-A', intervalMs: 10_000 },
      },
      {
        id: 3,
        v: 1,
        type: 'auth_device_flow_authorized',
        data: {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          expiresAt: 1_700_000_999_000,
          accountAlias: 'user-A',
        },
      },
    ];
    const state = reduceDaemonAuthEvents(events);
    const flow = state.flows['qwen-oauth'];
    expect(flow).toBeDefined();
    expect(flow?.status).toBe('authorized');
    expect(flow?.intervalMs).toBe(10_000);
    expect(flow?.authorizedExpiresAt).toBe(1_700_000_999_000);
    expect(flow?.accountAlias).toBe('user-A');
  });

  it('reduceDaemonAuthEvent: failed event always projects status:error + errorKind (aligned with daemon)', () => {
    // Issue #4175 PR 21 fold-in 0 P1-10: SDK reducer now mirrors the
    // daemon's status machine — every `failed` event resolves to
    // `status: 'error'`, regardless of `errorKind`. The error nature
    // (expired vs denied vs persist failure) lives in `errorKind`,
    // not `status`. Earlier drafts collapsed `expired_token` to
    // `status: 'expired'`, diverging from the daemon's GET response.
    const expired = reduceDaemonAuthEvent(
      reduceDaemonAuthEvent(createDaemonAuthState(), {
        id: 1,
        v: 1,
        type: 'auth_device_flow_started',
        data: {
          deviceFlowId: 'flow-X',
          providerId: 'qwen-oauth',
          expiresAt: 0,
        },
      }),
      {
        id: 2,
        v: 1,
        type: 'auth_device_flow_failed',
        data: { deviceFlowId: 'flow-X', errorKind: 'expired_token' },
      },
    );
    expect(expired.flows['qwen-oauth']?.status).toBe('error');
    expect(expired.flows['qwen-oauth']?.errorKind).toBe('expired_token');

    const denied = reduceDaemonAuthEvent(
      reduceDaemonAuthEvent(createDaemonAuthState(), {
        id: 3,
        v: 1,
        type: 'auth_device_flow_started',
        data: {
          deviceFlowId: 'flow-Y',
          providerId: 'qwen-oauth',
          expiresAt: 0,
        },
      }),
      {
        id: 4,
        v: 1,
        type: 'auth_device_flow_failed',
        data: { deviceFlowId: 'flow-Y', errorKind: 'access_denied' },
      },
    );
    expect(denied.flows['qwen-oauth']?.status).toBe('error');
    expect(denied.flows['qwen-oauth']?.errorKind).toBe('access_denied');

    // P1-10 cousin: new `persist_failed` errorKind also lands as
    // `status: 'error'`, with the kind preserved.
    const persistFailed = reduceDaemonAuthEvent(
      reduceDaemonAuthEvent(createDaemonAuthState(), {
        id: 5,
        v: 1,
        type: 'auth_device_flow_started',
        data: {
          deviceFlowId: 'flow-Z',
          providerId: 'qwen-oauth',
          expiresAt: 0,
        },
      }),
      {
        id: 6,
        v: 1,
        type: 'auth_device_flow_failed',
        data: { deviceFlowId: 'flow-Z', errorKind: 'persist_failed' },
      },
    );
    expect(persistFailed.flows['qwen-oauth']?.status).toBe('error');
    expect(persistFailed.flows['qwen-oauth']?.errorKind).toBe('persist_failed');
  });

  it('reduceDaemonAuthEvent ignores stale events that do not match the current flow', () => {
    const seeded = reduceDaemonAuthEvent(createDaemonAuthState(), {
      id: 1,
      v: 1,
      type: 'auth_device_flow_started',
      data: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        expiresAt: 100,
      },
    });
    const stale = reduceDaemonAuthEvent(seeded, {
      id: 2,
      v: 1,
      type: 'auth_device_flow_authorized',
      data: {
        deviceFlowId: 'flow-OTHER',
        providerId: 'qwen-oauth',
        expiresAt: 200,
      },
    });
    expect(stale.flows['qwen-oauth']?.status).toBe('pending');
  });

  it('reduceDaemonAuthEvent rejects out-of-order frames (fold-in 8 #2 monotonicity)', () => {
    // Live: started(id=5) → authorized(id=10). Replay then injects a
    // stale `failed` (id=7) for the same flow — without monotonicity
    // it would overwrite `authorized` back to `error`/`upstream_error`.
    let state = reduceDaemonAuthEvent(createDaemonAuthState(), {
      id: 5,
      v: 1,
      type: 'auth_device_flow_started',
      data: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_900_000,
      },
    });
    state = reduceDaemonAuthEvent(state, {
      id: 10,
      v: 1,
      type: 'auth_device_flow_authorized',
      data: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_001_000_000,
      },
    });
    expect(state.flows['qwen-oauth']?.status).toBe('authorized');
    expect(state.flows['qwen-oauth']?.lastSeenEventId).toBe(10);

    const replayedStale = reduceDaemonAuthEvent(state, {
      id: 7, // stale: less than the current lastSeenEventId (10)
      v: 1,
      type: 'auth_device_flow_failed',
      data: {
        deviceFlowId: 'flow-A',
        errorKind: 'upstream_error',
      },
    });
    // Stale frame must NOT overwrite the authorized terminal.
    expect(replayedStale.flows['qwen-oauth']?.status).toBe('authorized');
    expect(replayedStale.flows['qwen-oauth']?.lastSeenEventId).toBe(10);
    expect(replayedStale.flows['qwen-oauth']?.errorKind).toBeUndefined();

    // A fresh `started` (id=4 < 10) for a NEW flow under the same
    // providerId is also rejected as stale — the SDK has already
    // observed the newer flow's authorized state and the lower-id
    // started must be a replay of an old flow that gave way.
    const replayedStartedStale = reduceDaemonAuthEvent(state, {
      id: 4,
      v: 1,
      type: 'auth_device_flow_started',
      data: {
        deviceFlowId: 'flow-OLD',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_500_000,
      },
    });
    expect(replayedStartedStale.flows['qwen-oauth']?.deviceFlowId).toBe(
      'flow-A',
    );
    expect(replayedStartedStale.flows['qwen-oauth']?.status).toBe('authorized');
  });

  it('reduceDaemonAuthEvent passes synthetic frames (no envelope id) through the gate', () => {
    // Synthetic frames originate inside SDK reducer machinery and
    // aren't subject to replay ordering — gate must let them
    // through even when state's lastSeenEventId is set.
    let state = reduceDaemonAuthEvent(createDaemonAuthState(), {
      id: 5,
      v: 1,
      type: 'auth_device_flow_started',
      data: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_900_000,
      },
    });
    state = reduceDaemonAuthEvent(state, {
      // No `id`: synthetic / fallback path.
      v: 1,
      type: 'auth_device_flow_cancelled',
      data: { deviceFlowId: 'flow-A' },
    });
    expect(state.flows['qwen-oauth']?.status).toBe('cancelled');
  });

  it('reduceDaemonSessionEvent no-ops on auth events (workspace-scoped)', () => {
    const initial = createDaemonSessionViewState();
    const next = reduceDaemonSessionEvent(initial, {
      id: 1,
      v: 1,
      type: 'auth_device_flow_started',
      data: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        expiresAt: 1_700_000_900_000,
      },
    });
    // Only `lastEventId` advanced; everything else is the seeded zero state.
    expect(next.lastEventId).toBe(1);
    expect(next.alive).toBe(true);
    expect(next.terminalEvent).toBeUndefined();
    expect(next.unrecognizedKnownEventCount).toBe(0);
  });

  // #4282 fold-in 3 (gpt-5.5 C8): reducer + parser coverage for the 5
  // PR 17 mutation events. Covers happy-path counter + last-snapshot
  // accumulation, malformed-payload rejection (must round-trip through
  // `asKnownDaemonEvent → undefined` and increment
  // `unrecognizedKnownEventCount` rather than the event-specific
  // counter), and the envelope-level `originatorClientId` merge.
  describe('PR 17 mutation events', () => {
    it('approval_mode_changed: increments counter, copies envelope originator', () => {
      const next = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 5,
        v: 1,
        type: 'approval_mode_changed',
        originatorClientId: 'client-A',
        data: {
          sessionId: 'sess-1',
          previous: 'default',
          next: 'yolo',
          persisted: true,
        },
      });
      expect(next.approvalModeChangedCount).toBe(1);
      expect(next.approvalMode).toBe('yolo');
      expect(next.lastApprovalModeChange?.next).toBe('yolo');
      expect(next.lastApprovalModeChange?.persisted).toBe(true);
      // Envelope `originatorClientId` was merged onto the snapshot.
      expect(next.lastApprovalModeChange?.originatorClientId).toBe('client-A');
    });

    it('approval_mode_changed: malformed payload routes to unrecognized counter', () => {
      const malformed: DaemonEvent = {
        id: 6,
        v: 1,
        type: 'approval_mode_changed',
        // Missing `next`, `persisted` — fails `isApprovalModeChangedData`.
        data: { sessionId: 'sess-1', previous: 'default' },
      };
      expect(asKnownDaemonEvent(malformed)).toBeUndefined();
      const next = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        malformed,
      );
      expect(next.unrecognizedKnownEventCount).toBe(1);
      expect(next.approvalModeChangedCount).toBe(0);
      expect(next.approvalMode).toBeUndefined();
    });

    it('tool_toggled: increments counter, stores last snapshot with envelope originator', () => {
      const next = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 7,
        v: 1,
        type: 'tool_toggled',
        originatorClientId: 'client-B',
        data: { toolName: 'run_shell_command', enabled: false },
      });
      expect(next.toolToggleCount).toBe(1);
      expect(next.lastToolToggle?.toolName).toBe('run_shell_command');
      expect(next.lastToolToggle?.enabled).toBe(false);
      expect(next.lastToolToggle?.originatorClientId).toBe('client-B');
    });

    it('workspace_initialized: accepts noop / created / overwrote actions', () => {
      const initial = createDaemonSessionViewState();
      const afterCreate = reduceDaemonSessionEvent(initial, {
        id: 8,
        v: 1,
        type: 'workspace_initialized',
        data: { path: '/work/QWEN.md', action: 'created' },
      });
      expect(afterCreate.workspaceInitCount).toBe(1);
      expect(afterCreate.lastWorkspaceInit?.action).toBe('created');
      const afterNoop = reduceDaemonSessionEvent(afterCreate, {
        id: 9,
        v: 1,
        type: 'workspace_initialized',
        data: { path: '/work/QWEN.md', action: 'noop' },
      });
      expect(afterNoop.workspaceInitCount).toBe(2);
      expect(afterNoop.lastWorkspaceInit?.action).toBe('noop');
      // Bogus action literal is rejected by the parser.
      const malformed: DaemonEvent = {
        id: 10,
        v: 1,
        type: 'workspace_initialized',
        data: { path: '/work/QWEN.md', action: 'replaced' },
      };
      expect(asKnownDaemonEvent(malformed)).toBeUndefined();
    });

    it('mcp_server_restarted: counter + last snapshot + envelope originator merge', () => {
      const next = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 11,
        v: 1,
        type: 'mcp_server_restarted',
        originatorClientId: 'client-C',
        data: { serverName: 'docs', durationMs: 1234 },
      });
      expect(next.mcpRestartCount).toBe(1);
      expect(next.mcpRestartRefusedCount).toBe(0);
      expect(next.lastMcpRestart?.serverName).toBe('docs');
      expect(next.lastMcpRestart?.durationMs).toBe(1234);
      expect(next.lastMcpRestart?.originatorClientId).toBe('client-C');
    });

    it('mcp_server_restart_refused: routes to refused counter only, all reasons accepted', () => {
      const initial = createDaemonSessionViewState();
      const reasons: Array<
        | 'in_flight'
        | 'disabled'
        | 'budget_would_exceed'
        // F2 (#4175 commit 5): pool-mode hard restart failure carried
        // alongside the soft-skip reasons. The reducer treats it like
        // any other refusal — count + remember last — without a
        // dedicated counter, since the bridge fan-out emits one event
        // per failed pool entry and aggregating into the refused
        // counter is the operator-meaningful signal ("this many
        // restart attempts didn't take effect").
        | 'restart_failed'
      > = ['in_flight', 'disabled', 'budget_would_exceed', 'restart_failed'];
      let state = initial;
      for (const [i, reason] of reasons.entries()) {
        state = reduceDaemonSessionEvent(state, {
          id: 12 + i,
          v: 1,
          type: 'mcp_server_restart_refused',
          data: { serverName: 'docs', reason },
        });
      }
      expect(state.mcpRestartRefusedCount).toBe(4);
      expect(state.mcpRestartCount).toBe(0);
      expect(state.lastMcpRestartRefused?.reason).toBe('restart_failed');
      // Bogus reason literal is rejected by the parser.
      const malformed: DaemonEvent = {
        id: 99,
        v: 1,
        type: 'mcp_server_restart_refused',
        data: { serverName: 'docs', reason: 'made_up_reason' },
      };
      expect(asKnownDaemonEvent(malformed)).toBeUndefined();
    });

    it('mergeOriginator: prefers data-level originator over envelope when both present', () => {
      // The daemon does not currently populate `data.originatorClientId`,
      // but the field is declared on the Data interfaces. If a future
      // daemon version sets it directly, we must not clobber it with
      // the envelope value.
      const next = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 50,
        v: 1,
        type: 'tool_toggled',
        originatorClientId: 'envelope-client',
        data: {
          toolName: 'Bash',
          enabled: true,
          originatorClientId: 'data-client',
        },
      });
      expect(next.lastToolToggle?.originatorClientId).toBe('data-client');
    });
  });

  // F3 Commit 7 — multi-client permission coordination event reducer
  // tests. Covers permission_partial_vote / permission_forbidden plus
  // the side-effect that resolved/already_resolved events clear
  // `permissionVoteProgress` for the matching requestId.
  describe('F3 permission coordination events', () => {
    it('narrows permission_partial_vote and permission_forbidden via asKnownDaemonEvent', () => {
      const partial = asKnownDaemonEvent({
        id: 1,
        v: 1,
        type: 'permission_partial_vote',
        data: {
          requestId: 'req-1',
          sessionId: 'sess-1',
          votesReceived: 1,
          votesNeeded: 1,
          quorum: 2,
          optionTallies: { proceed_once: 1 },
        },
      });
      expect(partial?.type).toBe('permission_partial_vote');

      const forbidden = asKnownDaemonEvent({
        id: 2,
        v: 1,
        type: 'permission_forbidden',
        data: {
          requestId: 'req-1',
          sessionId: 'sess-1',
          clientId: 'client_B',
          reason: 'designated_mismatch',
        },
        originatorClientId: 'client_A',
      });
      expect(forbidden?.type).toBe('permission_forbidden');
    });

    it('rejects malformed permission_partial_vote (negative tally)', () => {
      expect(
        asKnownDaemonEvent({
          id: 3,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: -1 },
          },
        }),
      ).toBeUndefined();
    });

    it('rejects malformed permission_forbidden (unknown reason)', () => {
      expect(
        asKnownDaemonEvent({
          id: 4,
          v: 1,
          type: 'permission_forbidden',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            reason: 'unauthorized',
          },
        }),
      ).toBeUndefined();
    });

    it('reducer accumulates permission_partial_vote into permissionVoteProgress', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            toolCall: {},
            options: [{ optionId: 'proceed_once' }],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
      ]);
      expect(state.permissionVoteProgress['req-1']).toMatchObject({
        votesReceived: 1,
        votesNeeded: 1,
        quorum: 2,
        optionTallies: { proceed_once: 1 },
      });
      expect(Object.keys(state.pendingPermissions)).toEqual(['req-1']);
    });

    it('reducer clears permissionVoteProgress on permission_resolved', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            toolCall: {},
            options: [{ optionId: 'proceed_once' }],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
        {
          id: 3,
          v: 1,
          type: 'permission_resolved',
          data: {
            requestId: 'req-1',
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
          },
        },
      ]);
      expect(state.permissionVoteProgress).toEqual({});
      expect(state.pendingPermissions).toEqual({});
    });

    it('reducer clears permissionVoteProgress on permission_already_resolved', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            toolCall: {},
            options: [{ optionId: 'proceed_once' }],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
        {
          id: 3,
          v: 1,
          type: 'permission_already_resolved',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
          },
        },
      ]);
      expect(state.permissionVoteProgress).toEqual({});
    });

    // Wenshao review #4335 / 3271041465 — SDK reconnects mid-permission
    // and misses `permission_request`, then sees `permission_partial_vote`
    // (stored in permissionVoteProgress). When the matching
    // `permission_resolved` arrives, the early-return path on
    // unmatched requestId must STILL clear the orphan progress
    // entry; otherwise it persists for the lifetime of the session.
    it('reducer clears orphan permissionVoteProgress on unmatched permission_resolved (reconnect race)', () => {
      const state = reduceDaemonSessionEvents([
        // No permission_request — simulates a client that reconnected
        // after the original prompt was dispatched.
        {
          id: 1,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'orphan-req',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_resolved',
          data: {
            requestId: 'orphan-req',
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
          },
        },
      ]);
      // Pre-fix: permissionVoteProgress['orphan-req'] would still be
      // populated because the resolved-handler early-returned without
      // touching permissionVoteProgress. Post-fix: cleared.
      expect(state.permissionVoteProgress).toEqual({});
      // The unmatched-resolution counter still bumps; that signal
      // remains valuable for diagnostics.
      expect(state.unmatchedPermissionResolutionCount).toBe(1);
      expect(state.lastUnmatchedPermissionResolutionId).toBe('orphan-req');
    });

    it('reducer clears orphan permissionVoteProgress on unmatched permission_already_resolved (reconnect race)', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'orphan-req',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_already_resolved',
          data: {
            requestId: 'orphan-req',
            sessionId: 'sess-1',
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
          },
        },
      ]);
      expect(state.permissionVoteProgress).toEqual({});
      expect(state.unmatchedPermissionResolutionCount).toBe(1);
    });

    it('reducer appends permission_forbidden to bounded forbiddenVotes', () => {
      const events: DaemonEvent[] = [];
      for (let i = 0; i < 35; i++) {
        events.push({
          id: 100 + i,
          v: 1,
          type: 'permission_forbidden',
          data: {
            requestId: `req-${i}`,
            sessionId: 'sess-1',
            clientId: `client_${i}`,
            reason: 'designated_mismatch',
          },
          originatorClientId: 'prompt-originator',
        });
      }
      const state = reduceDaemonSessionEvents(events);
      // Ring is bounded at 32; total count tracks all events.
      expect(state.forbiddenVotes.length).toBe(32);
      expect(state.forbiddenVoteCount).toBe(35);
      // FIFO eviction — the first 3 entries should have been evicted.
      expect(state.forbiddenVotes[0]!.requestId).toBe('req-3');
      expect(state.forbiddenVotes[31]!.requestId).toBe('req-34');
    });

    // Wenshao review #4335 / 3272576003 — terminal events
    // (session_died / session_closed / client_evicted / stream_error)
    // must drop forbiddenVotes + forbiddenVoteCount alongside the
    // existing pendingPermissions / permissionVoteProgress reset.
    // Pre-fix the rejection history would persist on a dead session
    // and adapters reading view state would render stale data.
    it.each([
      ['session_died', { sessionId: 'sess-1', reason: 'dead' }],
      [
        'session_closed',
        { sessionId: 'sess-1', reason: 'client_close' as const },
      ],
      [
        'client_evicted',
        { sessionId: 'sess-1', clientId: 'c', reason: 'too-slow' },
      ],
      ['stream_error', { sessionId: 'sess-1', error: 'broken' }],
    ])(
      'reducer clears forbiddenVotes + forbiddenVoteCount on %s (#4335 / 3272576003)',
      (terminalType, terminalData) => {
        const state = reduceDaemonSessionEvents([
          {
            id: 1,
            v: 1,
            type: 'permission_forbidden',
            data: {
              requestId: 'req-1',
              sessionId: 'sess-1',
              clientId: 'rejected',
              reason: 'designated_mismatch',
            },
          },
          {
            id: 2,
            v: 1,
            type: terminalType,
            data: terminalData,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ]);
        expect(state.forbiddenVotes).toEqual([]);
        expect(state.forbiddenVoteCount).toBe(0);
        expect(state.alive).toBe(false);
      },
    );

    // Wenshao review #4335 / 3270622311 — the SSE envelope's
    // `originatorClientId` (= prompt originator per F3 N3) must reach
    // view state. Pre-fix, the reducer copied only `event.data` and
    // dropped the prompt-originator attribution, leaving SDK consumers
    // unable to tell which client's prompt was targeted by the
    // partial-vote progress / forbidden vote.
    it('reducer stamps prompt-originator on permission_partial_vote view state (mergeOriginator)', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            toolCall: {},
            options: [{ optionId: 'proceed_once' }],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
          originatorClientId: 'prompt-originator-id',
        },
      ]);
      expect(state.permissionVoteProgress['req-1']).toMatchObject({
        requestId: 'req-1',
        votesReceived: 1,
        originatorClientId: 'prompt-originator-id',
      });
    });

    it('reducer stamps prompt-originator on permission_forbidden view state (mergeOriginator)', () => {
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_forbidden',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            clientId: 'rejected-voter-id',
            reason: 'designated_mismatch',
          },
          originatorClientId: 'prompt-originator-id',
        },
      ]);
      expect(state.forbiddenVotes).toHaveLength(1);
      expect(state.forbiddenVotes[0]).toMatchObject({
        requestId: 'req-1',
        clientId: 'rejected-voter-id',
        originatorClientId: 'prompt-originator-id',
      });
    });

    it('reducer preserves data.originatorClientId over envelope when both present (mergeOriginator)', () => {
      // Defensive: mergeOriginator's contract is to PRESERVE any pre-
      // existing data.originatorClientId. The daemon does not currently
      // populate it, but if a future producer does, the reducer must
      // not overwrite it with the envelope value.
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_forbidden',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            clientId: 'rejected',
            reason: 'designated_mismatch',
            originatorClientId: 'data-side-originator',
          },
          originatorClientId: 'envelope-side-originator',
        },
      ]);
      expect(state.forbiddenVotes[0]?.originatorClientId).toBe(
        'data-side-originator',
      );
    });

    it('partial_vote → resolved ordering (M=2 N=2 quorum scenario)', () => {
      // F3 N3 ordering invariant — partial_vote frames precede the
      // resolved frame for the same requestId.
      const state = reduceDaemonSessionEvents([
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            toolCall: {},
            options: [{ optionId: 'proceed_once' }],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_partial_vote',
          data: {
            requestId: 'req-1',
            sessionId: 'sess-1',
            votesReceived: 1,
            votesNeeded: 1,
            quorum: 2,
            optionTallies: { proceed_once: 1 },
          },
        },
        {
          id: 3,
          v: 1,
          type: 'permission_resolved',
          data: {
            requestId: 'req-1',
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
          },
        },
      ]);
      // Reducer end-state: pending cleared, vote progress cleared.
      expect(state.permissionVoteProgress).toEqual({});
      expect(state.pendingPermissions).toEqual({});
    });

    it('rejects malformed permission_partial_vote payload via unrecognizedKnownEventCount counter', () => {
      // The reducer's `narrow then no-op` path: when the event type IS
      // in `KNOWN_EVENT_TYPES` but its data fails the type-guard
      // (e.g. missing required fields, negative tally), the reducer
      // bumps `unrecognizedKnownEventCount` rather than crashing.
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 9,
        v: 1,
        type: 'permission_partial_vote',
        data: { malformed: true },
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
      expect(state.permissionVoteProgress).toEqual({});
    });

    it('forward-compat: emits unknown event types fall through silently (no counter bump)', () => {
      // R3-11 (final review fold-in) — true forward-compat path. The
      // reducer's `unrecognizedKnownEventCount` only fires for types
      // that ARE in `KNOWN_EVENT_TYPES` (i.e. the daemon and SDK
      // agree on the type but disagree on the shape). For unknown
      // types — e.g. a future daemon emitting `permission_unknown_v2`
      // before the SDK ships support — the reducer must silently
      // ignore (track only `lastEventId`) so the SDK can keep
      // streaming through unknown events without piling up false
      // unrecognized-known counts.
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        id: 99,
        v: 1,
        type: 'permission_unknown_v2_future',
        data: { whatever: 'shape' },
      });
      expect(state.unrecognizedKnownEventCount).toBe(0);
      expect(state.lastEventId).toBe(99);
    });
  });

  describe('state_resync_required (#4175 F4 prereq, Ilya0527 issue #15)', () => {
    it('sets awaitingResync + records the resync data when daemon emits state_resync_required', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'state_resync_required',
        data: {
          reason: 'ring_evicted',
          lastDeliveredId: 5,
          earliestAvailableId: 12,
        },
      });
      expect(state.awaitingResync).toBe(true);
      expect(state.resyncRequiredCount).toBe(1);
      expect(state.lastResyncRequired).toEqual({
        reason: 'ring_evicted',
        lastDeliveredId: 5,
        earliestAvailableId: 12,
      });
    });

    it('auto-skips delta events (session_update) while awaitingResync is true', () => {
      // Step 1: daemon emits resync → flag set.
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      // Step 2: subsequent session_update would normally set
      // `lastSessionUpdate` — but awaitingResync auto-skips it.
      const skipped = reduceDaemonSessionEvent(afterResync, {
        id: 13,
        v: 1,
        type: 'session_update',
        data: { sessionId: 's-X', phase: 'prompting' },
      });
      // lastSessionUpdate unchanged (skipped), lastEventId DID advance.
      expect(skipped.lastSessionUpdate).toBeUndefined();
      expect(skipped.lastEventId).toBe(13);
      expect(skipped.awaitingResync).toBe(true);
    });

    it('auto-skips permission_request while awaitingResync (no pendingPermissions mutation)', () => {
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      const skipped = reduceDaemonSessionEvent(afterResync, {
        id: 13,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'req-stale',
          sessionId: 's-1',
          toolCall: {
            toolCallId: 'tc-1',
            status: 'pending',
            title: 'Read /etc/passwd',
          },
          options: [
            {
              optionId: 'allow_once',
              name: 'Allow once',
              kind: 'allow_once',
            },
          ],
        },
      });
      // pendingPermissions stays empty — the permission_request was
      // applied to stale state and we can't trust which permissions
      // are still pending until loadSession recovery.
      expect(skipped.pendingPermissions).toEqual({});
    });

    it('still applies terminal events (session_died) while awaitingResync', () => {
      // Critical: a session that DIES while in resync limbo must still
      // be observable as dead. Otherwise UIs would render "loading
      // resync state…" indefinitely while the underlying session is
      // gone.
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      const dead = reduceDaemonSessionEvent(afterResync, {
        id: 14,
        v: 1,
        type: 'session_died',
        data: { sessionId: 's-1', reason: 'channel_closed' },
      });
      expect(dead.alive).toBe(false);
      expect(dead.terminalEvent?.type).toBe('session_died');
      // awaitingResync stays set (the consumer never recovered from
      // resync — the session just died first). The terminal event
      // takes precedence for UI rendering.
      expect(dead.awaitingResync).toBe(true);
    });

    it('still applies stream_error while awaitingResync', () => {
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      const errored = reduceDaemonSessionEvent(afterResync, {
        v: 1,
        type: 'stream_error',
        data: { error: 'transport gone' },
      });
      expect(errored.alive).toBe(false);
      expect(errored.streamError).toEqual({ error: 'transport gone' });
    });

    it('captures errorKind on stream_error in view state (wenshao #4360 review)', () => {
      // The daemon stamps `errorKind` on `stream_error` payloads when
      // classifiable (commit `14637cd79`, via `mapDomainErrorToErrorKind`).
      // SDK consumers receiving these frames need `state.streamError.
      // errorKind` to render typed retry/remediation UI (e.g. retry on
      // init_timeout, install on missing_binary) without regex-matching
      // the `error` message string.
      //
      // This test pins the flowthrough: the reducer's `stream_error`
      // case must assign `event.data` as-is to `state.streamError`,
      // preserving all fields including the optional `errorKind`. If
      // a future refactor strips `errorKind` (e.g. by spreading only
      // `{error}` instead of the full data object), this fails.
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'stream_error',
        data: {
          error: 'initialize timed out after 5000ms',
          errorKind: 'init_timeout',
        },
      });
      expect(state.alive).toBe(false);
      expect(state.streamError?.errorKind).toBe('init_timeout');
      expect(state.streamError?.error).toContain('timed out');
    });

    it('still applies session_closed while awaitingResync (wenshao #4360 review)', () => {
      // session_closed is in RESYNC_PASSTHROUGH_TYPES alongside
      // session_died — terminal session lifecycle signals must still
      // surface even when the consumer is in resync limbo. Otherwise
      // a session that closes during resync would silently keep
      // `alive: true` in view state and the UI would render "loading
      // resync state…" indefinitely.
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      const closed = reduceDaemonSessionEvent(afterResync, {
        id: 15,
        v: 1,
        type: 'session_closed',
        data: { sessionId: 's-1', reason: 'client_initiated' },
      });
      expect(closed.alive).toBe(false);
      expect(closed.terminalEvent?.type).toBe('session_closed');
      // awaitingResync stays set (consumer never recovered) — the
      // terminal event takes precedence for UI rendering but the
      // resync flag remains as observability state.
      expect(closed.awaitingResync).toBe(true);
    });

    it('still applies client_evicted while awaitingResync (wenshao #4360 review)', () => {
      // client_evicted is the 5th member of RESYNC_PASSTHROUGH_TYPES.
      // It happens when the subscriber's queue overflows (the daemon
      // closes the stream after force-pushing the synthetic frame).
      // Even in resync limbo, the SDK must see the eviction so the
      // adapter can stop pretending the stream is alive.
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      const evicted = reduceDaemonSessionEvent(afterResync, {
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow', droppedAfter: 17 },
      });
      expect(evicted.alive).toBe(false);
      expect(evicted.terminalEvent?.type).toBe('client_evicted');
    });

    it('reseeding view state via createDaemonSessionViewState clears awaitingResync (consumer recovery)', () => {
      // Consumer recovery path: after observing awaitingResync, call
      // loadSession (out of band) and reconstruct view state. The
      // fresh state has the flag back to false.
      const stale = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'state_resync_required',
        data: {
          reason: 'ring_evicted',
          lastDeliveredId: 5,
          earliestAvailableId: 12,
        },
      });
      expect(stale.awaitingResync).toBe(true);
      // Consumer calls loadSession + builds fresh state from result.
      const recovered = createDaemonSessionViewState({
        sessionId: 's-1',
        lastEventId: 20,
      });
      expect(recovered.awaitingResync).toBe(false);
      expect(recovered.resyncRequiredCount).toBe(0);
    });

    it('a second state_resync_required increments resyncRequiredCount', () => {
      // Repeated reconnect past the ring boundary — counter accumulates.
      let state = createDaemonSessionViewState();
      state = reduceDaemonSessionEvent(state, {
        v: 1,
        type: 'state_resync_required',
        data: {
          reason: 'ring_evicted',
          lastDeliveredId: 5,
          earliestAvailableId: 12,
        },
      });
      state = reduceDaemonSessionEvent(state, {
        v: 1,
        type: 'state_resync_required',
        data: {
          reason: 'ring_evicted',
          lastDeliveredId: 20,
          earliestAvailableId: 100,
        },
      });
      expect(state.resyncRequiredCount).toBe(2);
      expect(state.lastResyncRequired?.lastDeliveredId).toBe(20);
    });

    it('rejects malformed state_resync_required payload via unrecognizedKnownEventCount', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'state_resync_required',
        data: { reason: 'ring_evicted' }, // missing lastDeliveredId/earliestAvailableId
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
      expect(state.awaitingResync).toBe(false);
    });

    it('still applies session_snapshot while awaitingResync (RESYNC_PASSTHROUGH_TYPES)', () => {
      // session_snapshot is in RESYNC_PASSTHROUGH_TYPES — a reconnecting
      // client that missed ring events still needs to seed its side-channel
      // model/mode state. Without passthrough, the auto-skip gate would
      // drop the snapshot and the client would remain on stale null/null.
      const afterResync = reduceDaemonSessionEvent(
        createDaemonSessionViewState(),
        {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 5,
            earliestAvailableId: 12,
          },
        },
      );
      expect(afterResync.awaitingResync).toBe(true);

      const afterSnapshot = reduceDaemonSessionEvent(afterResync, {
        id: 13,
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's-1',
          currentModelId: 'qwen-max',
          currentApprovalMode: 'auto-edit',
        },
      });
      // The snapshot must have applied — model/mode state is populated.
      expect(afterSnapshot.currentModelId).toBe('qwen-max');
      expect(afterSnapshot.approvalMode).toBe('auto-edit');
      // awaitingResync stays true (consumer hasn't explicitly recovered).
      expect(afterSnapshot.awaitingResync).toBe(true);
    });
  });

  describe('followup_suggestion (daemon assist push)', () => {
    it('recognizes followup_suggestion frames as known events', () => {
      const event = {
        id: 3,
        v: 1,
        type: 'followup_suggestion',
        data: {
          sessionId: 's-1',
          suggestion: 'Run the build?',
          promptId: 's-1########3',
        },
      } satisfies DaemonEvent;
      const known = asKnownDaemonEvent(event);
      expect(known?.type).toBe('followup_suggestion');
      if (known?.type === 'followup_suggestion') {
        expect(known.data.sessionId).toBe('s-1');
        expect(known.data.suggestion).toBe('Run the build?');
        expect(known.data.promptId).toBe('s-1########3');
      }
    });

    it('rejects malformed followup_suggestion payloads', () => {
      // Missing fields → predicate rejects → asKnownDaemonEvent
      // returns undefined → reducer counts via unrecognizedKnownEventCount.
      expect(
        asKnownDaemonEvent({
          v: 1,
          type: 'followup_suggestion',
          data: { suggestion: 'x', promptId: 'p' },
        }),
      ).toBeUndefined();
      expect(
        asKnownDaemonEvent({
          v: 1,
          type: 'followup_suggestion',
          data: { sessionId: 's', promptId: 'p' },
        }),
      ).toBeUndefined();
      expect(
        asKnownDaemonEvent({
          v: 1,
          type: 'followup_suggestion',
          data: { sessionId: 's', suggestion: 'x' },
        }),
      ).toBeUndefined();
      // Empty suggestion is protocol garbage — the daemon filters
      // rejected suggestions server-side and only emits when accepted.
      expect(
        asKnownDaemonEvent({
          v: 1,
          type: 'followup_suggestion',
          data: { sessionId: 's', suggestion: '', promptId: 'p' },
        }),
      ).toBeUndefined();
      // Wrong types.
      expect(
        asKnownDaemonEvent({
          v: 1,
          type: 'followup_suggestion',
          data: { sessionId: 's', suggestion: 42, promptId: 'p' },
        }),
      ).toBeUndefined();
    });

    it('reducer stores lastFollowupSuggestion and overwrites on a fresh event', () => {
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
          type: 'followup_suggestion',
          data: {
            sessionId: 's-1',
            suggestion: 'First',
            promptId: 's-1########1',
          },
        },
        {
          id: 3,
          v: 1,
          type: 'followup_suggestion',
          data: {
            sessionId: 's-1',
            suggestion: 'Second',
            promptId: 's-1########2',
          },
        },
      ]);
      expect(state.lastFollowupSuggestion).toEqual({
        sessionId: 's-1',
        suggestion: 'Second',
        promptId: 's-1########2',
      });
      // Non-terminal — does not touch alive / pendingPermissions.
      expect(state.alive).toBe(true);
      expect(state.terminalEvent).toBeUndefined();
      expect(state.lastEventId).toBe(3);
    });

    it('malformed payload routes to unrecognizedKnownEventCount', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'followup_suggestion',
        data: { sessionId: 's-1', suggestion: 'incomplete' }, // missing promptId
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
      expect(state.lastFollowupSuggestion).toBeUndefined();
    });
  });

  describe('session_snapshot (A5 #4511)', () => {
    it('asKnownDaemonEvent narrows session_snapshot', () => {
      const event: DaemonEvent = {
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's-1',
          currentModelId: 'qwen-turbo',
          currentApprovalMode: 'auto',
        },
      };
      const known = asKnownDaemonEvent(event);
      expect(known).toBeDefined();
      expect(known!.type).toBe('session_snapshot');
    });

    it('reducer seeds currentModelId and approvalMode from snapshot', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's-1',
          currentModelId: 'qwen-turbo',
          currentApprovalMode: 'yolo',
        },
      });
      expect(state.sessionId).toBe('s-1');
      expect(state.currentModelId).toBe('qwen-turbo');
      expect(state.approvalMode).toBe('yolo');
    });

    it('reducer does not overwrite model/mode with null snapshot values', () => {
      const initial = {
        ...createDaemonSessionViewState(),
        currentModelId: 'existing-model',
        approvalMode: 'default',
      };
      const state = reduceDaemonSessionEvent(initial, {
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's-1',
          currentModelId: null,
          currentApprovalMode: null,
        },
      });
      expect(state.currentModelId).toBe('existing-model');
      expect(state.approvalMode).toBe('default');
    });

    it('drops malformed session_snapshot (missing sessionId)', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'session_snapshot',
        data: { currentModelId: 'qwen-turbo' },
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
    });

    it('drops session_snapshot with a non-string currentModelId', () => {
      // Guards the reducer's `!= null` propagation: an unchecked non-string
      // would land in `state.currentModelId` and crash downstream string ops.
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's1',
          currentModelId: 42 as unknown as string,
          currentApprovalMode: null,
        },
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
      expect(state.currentModelId).toBeUndefined();
    });

    it('drops session_snapshot with a non-string currentApprovalMode', () => {
      const state = reduceDaemonSessionEvent(createDaemonSessionViewState(), {
        v: 1,
        type: 'session_snapshot',
        data: {
          sessionId: 's1',
          currentModelId: null,
          currentApprovalMode: {} as unknown as string,
        },
      });
      expect(state.unrecognizedKnownEventCount).toBe(1);
      expect(state.approvalMode).toBeUndefined();
    });
  });
});
