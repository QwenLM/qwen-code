/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { createTrajectoryLiveStore } from './trajectory-live-store';

function lifecycle(
  kind: 'request' | 'tool',
  executionId: string,
  phase: 'started' | 'ended',
  id?: number,
): DaemonEvent {
  const shared = {
    v: 1,
    kind,
    executionId,
    sessionId: 'session',
    startedAt: 10,
    phase,
  };
  const value =
    kind === 'request'
      ? {
          ...shared,
          promptId: 'prompt',
          model: 'model',
          ...(phase === 'ended'
            ? { endedAt: 20, durationMs: 10, outcome: 'success' }
            : {}),
        }
      : {
          ...shared,
          callId: 'call',
          toolName: 'shell',
          executionStatus: phase === 'started' ? 'running' : 'success',
          ...(phase === 'ended'
            ? { endedAt: 20, executionDurationMs: 10, outcome: 'cancelled' }
            : {}),
        };
  return {
    v: 1,
    type: 'session_update',
    id,
    data: {
      sessionUpdate:
        kind === 'tool' ? 'tool_call_update' : 'agent_message_chunk',
      _meta: {
        [kind === 'tool' ? 'toolLifecycle' : 'executionLifecycle']: value,
      },
    },
  };
}
const complete: DaemonEvent = { v: 1, type: 'replay_complete', data: {} };
const input = {
  sessionId: 'session',
  scope: 'workspace',
  epoch: 'a',
  incomplete: false,
  events: [],
};
function setup(events: DaemonEvent[] = []) {
  const store = createTrajectoryLiveStore();
  const owner = {};
  store.begin(owner, { ...input, events });
  return { store, owner };
}

describe('trajectory live store', () => {
  it('advances the delivery cursor without publishing plain text frames', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete, 'a');
    store.ingest(owner, lifecycle('request', 'active', 'started', 1), 'a');
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    for (let id = 2; id <= 21; id++) {
      store.ingest(
        owner,
        {
          v: 1,
          type: 'session_update',
          id,
          data: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'token' },
          },
        },
        'a',
      );
    }
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    store.ingest(owner, lifecycle('request', 'duplicate', 'started', 21), 'a');
    expect(store.getSnapshot()).toBe(before);
    store.ingest(owner, lifecycle('request', 'active', 'ended', 22), 'a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().lastEventId).toBe(22);
  });

  it('does not scan retained keys when updating an existing execution', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete);
    store.ingest(owner, lifecycle('request', 'request', 'started', 1));
    store.ingest(owner, lifecycle('tool', 'tool', 'started', 2));
    const requestKeys = vi.spyOn(store.getSnapshot().requests.entries, 'keys');
    const toolKeys = vi.spyOn(store.getSnapshot().tools.entries, 'keys');
    store.ingest(owner, lifecycle('request', 'request', 'ended', 3));
    expect(requestKeys).not.toHaveBeenCalled();
    expect(toolKeys).not.toHaveBeenCalled();
  });

  it('keeps a permanent failure after a transient failure', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete);
    store.invalidate(owner, 'stream_closed');
    store.invalidate(owner, 'auth_failure');
    store.reconnect(owner);
    store.ingest(owner, complete);
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'auth_failure',
    });
  });

  it('invalidates when a stream_error event arrives', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete);
    store.ingest(owner, lifecycle('request', 'active', 'started', 1));
    store.ingest(owner, { v: 1, type: 'stream_error', data: {} });
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'stream_error',
    });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'unknown',
    );
  });

  it('ignores reconnect from a foreign owner', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete);
    const snapshot = store.getSnapshot();
    store.reconnect({});
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it.each(['request', 'tool'] as const)(
    'keeps disconnected %s starts unknown until terminal evidence arrives',
    (kind) => {
      const { store, owner } = setup();
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle(kind, 'active', 'started', 1));
      store.invalidate(owner, 'stream_closed');
      store.reconnect(owner);
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle(kind, 'active', 'started', 2));
      const state = () =>
        kind === 'request'
          ? store.getSnapshot().requests
          : store.getSnapshot().tools;
      expect([...state().entries.values()][0].status).toBe('unknown');
      store.ingest(owner, lifecycle(kind, 'active', 'ended', 3));
      expect([...state().entries.values()][0].status).toBe('success');
    },
  );

  it('learns the epoch without treating a cursor-bearing replay as live', () => {
    const store = createTrajectoryLiveStore();
    const owner = {};
    store.begin(owner, { ...input, epoch: undefined, lastEventId: 0 });
    store.ingest(owner, lifecycle('request', 'replayed', 'started', 1), 'b');
    expect(store.getSnapshot()).toMatchObject({
      status: 'catching-up',
      epoch: 'b',
    });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'unknown',
    );
    store.ingest(owner, complete, 'b');
    expect(store.getSnapshot().status).toBe('live');
  });

  it('enters live on a cursorless subscription only after learning its epoch', () => {
    const store = createTrajectoryLiveStore();
    const owner = {};
    store.begin(owner, { ...input, epoch: undefined });
    store.reconnect(owner, true);
    store.ingest(owner, lifecycle('request', 'live', 'started', 1), 'b');
    expect(store.getSnapshot()).toMatchObject({ status: 'live', epoch: 'b' });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'running',
    );
  });

  it('does not promote cursorless streams without an epoch or across a gap', () => {
    const store = createTrajectoryLiveStore();
    const owner = {};
    store.begin(owner, { ...input, epoch: undefined });
    store.reconnect(owner, true);
    store.ingest(owner, lifecycle('request', 'old', 'started', 1));
    expect(store.getSnapshot().status).not.toBe('live');
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'unknown',
    );
    store.invalidate(owner, 'ring_evicted');
    store.ingest(owner, lifecycle('request', 'new', 'started', 2), 'b');
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'ring_evicted',
    });
    store.reconnect(owner, true);
    store.ingest(owner, complete, 'b');
    expect(store.getSnapshot().status).toBe('stale');
  });

  it('does not carry cursorless promotion into a cursor-bearing reconnect', () => {
    const store = createTrajectoryLiveStore();
    const owner = {};
    store.begin(owner, { ...input, epoch: undefined });
    store.reconnect(owner, true);
    store.ingest(owner, lifecycle('request', 'old', 'started', 1));
    store.invalidate(owner, 'stream_closed');
    store.reconnect(owner, false);
    store.ingest(owner, lifecycle('request', 'replayed', 'started', 2), 'b');
    expect(store.getSnapshot().status).toBe('catching-up');
    expect(
      [...store.getSnapshot().requests.entries.values()].map(
        (entry) => entry.status,
      ),
    ).toEqual(['unknown', 'unknown']);
  });

  it('invalidates an epoch reset even on a cursorless subscription', () => {
    const { store, owner } = setup();
    store.reconnect(owner, true);
    store.ingest(owner, lifecycle('request', 'new', 'started', 1), 'b');
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'epoch_reset',
      epoch: 'b',
    });
  });

  it('unwraps daemon session_update envelopes', () => {
    const event = lifecycle('tool', 'wrapped', 'ended', 1);
    const { store, owner } = setup([
      { ...event, data: { sessionId: 'session', update: event.data } },
    ]);
    store.ingest(owner, complete);
    expect([...store.getSnapshot().tools.entries.values()][0].status).toBe(
      'success',
    );
    const live = lifecycle('request', 'wrapped-live', 'started', 2);
    store.ingest(owner, { ...live, data: { update: live.data } });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'running',
    );
  });

  it.each(['stream_closed', 'stream_error'])(
    'resumes a transient %s from the same owner',
    (reason) => {
      const { store, owner } = setup();
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle('request', 'active', 'started', 1));
      store.invalidate(owner, reason);
      store.reconnect(owner);
      store.ingest(owner, lifecycle('request', 'active', 'ended', 2));
      store.ingest(owner, complete);
      expect(store.getSnapshot()).toMatchObject({
        status: 'live',
        reason: undefined,
      });
      expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
        'success',
      );
    },
  );

  it('preserves gap reasons when the stream subsequently closes', () => {
    const { store, owner } = setup();
    store.invalidate(owner, 'ring_evicted');
    store.invalidate(owner, 'stream_closed');
    store.reconnect(owner);
    store.ingest(owner, complete);
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'ring_evicted',
    });
  });

  it('does not infer a trustworthy live state without an epoch', () => {
    const store = createTrajectoryLiveStore();
    const owner = {};
    store.begin(owner, { ...input, epoch: undefined });
    store.ingest(owner, complete);
    store.ingest(owner, lifecycle('request', 'legacy', 'started', 1));
    expect(store.getSnapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'epoch_unavailable',
    });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'unknown',
    );
  });

  it.each(['session_closed', 'session_died'])(
    'invalidates active executions on %s',
    (type) => {
      const { store, owner } = setup();
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle('tool', 'active', 'started', 1));
      store.ingest(owner, { v: 1, type, data: {} });
      store.reconnect(owner);
      store.ingest(owner, complete);
      expect(store.getSnapshot()).toMatchObject({
        status: 'stale',
        reason: type,
      });
      expect([...store.getSnapshot().tools.entries.values()][0].status).toBe(
        'unknown',
      );
    },
  );

  it('completes an empty replay without waiting for business events', () => {
    const { store, owner } = setup();
    expect(store.getSnapshot().status).toBe('catching-up');
    store.ingest(owner, complete, 'a');
    expect(store.getSnapshot().status).toBe('live');
  });

  it.each(['request', 'tool'] as const)(
    'keeps replay %s starts unknown and only new live starts running',
    (kind) => {
      const { store, owner } = setup([lifecycle(kind, 'old', 'started', 1)]);
      store.ingest(owner, lifecycle(kind, 'buffered', 'started', 2));
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle(kind, 'old', 'started', 3));
      store.ingest(owner, lifecycle(kind, 'new', 'started', 4));
      const state =
        kind === 'request'
          ? store.getSnapshot().requests
          : store.getSnapshot().tools;
      expect([...state.entries.values()].map((entry) => entry.status)).toEqual([
        'unknown',
        'unknown',
        'running',
      ]);
    },
  );

  it.each(['request', 'tool'] as const)(
    'preserves %s terminal evidence across duplicates and reconnect',
    (kind) => {
      const { store, owner } = setup([lifecycle(kind, 'done', 'ended')]);
      store.ingest(owner, complete);
      store.ingest(owner, lifecycle(kind, 'active', 'started', 1));
      store.reconnect(owner);
      store.ingest(owner, lifecycle(kind, 'done', 'started', 2));
      const state =
        kind === 'request'
          ? store.getSnapshot().requests
          : store.getSnapshot().tools;
      expect([...state.entries.values()].map((entry) => entry.status)).toEqual([
        'success',
        'unknown',
      ]);
      store.ingest(owner, lifecycle(kind, 'active', 'ended', 3));
      store.ingest(owner, complete);
      expect(
        [
          ...(kind === 'request'
            ? store.getSnapshot().requests
            : store.getSnapshot().tools
          ).entries.values(),
        ].map((entry) => entry.status),
      ).toEqual(['success', 'success']);
    },
  );

  it('uses the supplied snapshot watermark and ignores duplicate deliveries', () => {
    const { store, owner } = setup();
    const nextOwner = {};
    store.begin(nextOwner, {
      ...input,
      lastEventId: 40,
      events: [lifecycle('request', 'one', 'started', 1)],
    });
    store.ingest(nextOwner, lifecycle('request', 'ignored', 'started', 40));
    store.ingest(nextOwner, lifecycle('request', 'one', 'ended', 41));
    store.ingest(owner, lifecycle('request', 'foreign', 'started', 100));
    expect(store.getSnapshot().requests.entries.size).toBe(1);
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'success',
    );
    expect(store.getSnapshot().lastEventId).toBe(41);
  });

  it('keeps a gap sticky even after replay_complete and reconnect', () => {
    const { store, owner } = setup();
    store.ingest(owner, complete);
    store.ingest(owner, lifecycle('request', 'active', 'started', 2));
    store.ingest(owner, {
      v: 1,
      type: 'state_resync_required',
      data: { reason: 'ring_evicted' },
    });
    store.ingest(owner, complete);
    store.reconnect(owner);
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'ring_evicted',
    });
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'unknown',
    );
    store.begin({}, input);
    store.ingest(owner, complete);
    expect(store.getSnapshot().status).toBe('catching-up');
  });

  it('invalidates changed epochs before comparing reused IDs', () => {
    const { store, owner } = setup();
    store.ingest(owner, lifecycle('request', 'old', 'ended', 100), 'a');
    store.ingest(owner, lifecycle('request', 'new', 'started', 1), 'b');
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reason: 'epoch_reset',
      epoch: 'b',
      lastEventId: undefined,
    });
    const replacement = {};
    store.begin(replacement, { ...input, epoch: 'b' });
    store.ingest(replacement, complete, 'b');
    store.ingest(replacement, lifecycle('request', 'new', 'started', 1), 'b');
    expect(store.getSnapshot().lastEventId).toBe(1);
    expect([...store.getSnapshot().requests.entries.values()][0].status).toBe(
      'running',
    );
  });

  it.each(['request', 'tool'] as const)(
    'bounds %s state and exposes eviction',
    (kind) => {
      const { store, owner } = setup();
      store.ingest(owner, complete);
      for (let index = 0; index < 256; index++)
        store.ingest(
          owner,
          lifecycle(kind, `execution-${index}`, 'started', index + 1),
        );
      expect(store.getSnapshot().truncated).toBe(false);
      store.ingest(owner, lifecycle(kind, 'execution-256', 'started', 257));
      const state =
        kind === 'request'
          ? store.getSnapshot().requests
          : store.getSnapshot().tools;
      expect(state.entries.size).toBe(256);
      expect(store.getSnapshot().truncated).toBe(true);
      expect([...state.entries.values()][0].event.executionId).toBe(
        'execution-1',
      );
      store.ingest(owner, lifecycle(kind, 'execution-256', 'ended', 258));
      expect(store.getSnapshot().truncated).toBe(true);
    },
  );

  it('separates incomplete history from continuity', () => {
    const { store, owner } = setup();
    const replacement = {};
    store.begin(replacement, { ...input, incomplete: true });
    store.ingest(replacement, complete);
    expect(store.getSnapshot()).toMatchObject({
      status: 'live',
      incomplete: true,
      truncated: false,
    });
    store.ingest(replacement, { v: 1, type: 'history_truncated', data: {} });
    expect(store.getSnapshot()).toMatchObject({
      status: 'live',
      incomplete: true,
      truncated: true,
    });
    store.invalidate(owner, 'late');
    expect(store.getSnapshot().status).toBe('live');
  });

  it('initializes each owner once and releases listeners and old ownership', () => {
    const { store, owner } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const snapshot = store.getSnapshot();
    store.begin(owner, { ...input, incomplete: true });
    expect(store.getSnapshot()).toBe(snapshot);
    store.ingest(owner, complete);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.clear();
    store.ingest(owner, complete);
    expect(store.getSnapshot().status).toBe('unavailable');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
