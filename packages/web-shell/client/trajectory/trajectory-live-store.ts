/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createExecutionLifecycleState,
  createToolLifecycleState,
  extractExecutionLifecycle,
  extractToolLifecycle,
  getSessionUpdatePayload,
  reduceExecutionLifecycle,
  reduceToolLifecycle,
  type DaemonEvent,
  type ExecutionLifecycleState,
  type ToolLifecycleState,
} from '@qwen-code/sdk/daemon';

export interface TrajectoryLiveSnapshot {
  readonly sessionId?: string;
  readonly scope?: string;
  readonly epoch?: string;
  readonly lastEventId?: number;
  readonly status: 'catching-up' | 'live' | 'stale' | 'unavailable';
  readonly reason?: string;
  readonly requests: ExecutionLifecycleState;
  readonly tools: ToolLifecycleState;
  readonly incomplete: boolean;
  readonly truncated: boolean;
}

export interface TrajectoryLiveInput {
  sessionId: string;
  scope: string;
  epoch?: string;
  lastEventId?: number;
  events: readonly DaemonEvent[];
  incomplete: boolean;
}

export interface TrajectoryLiveStore {
  getSnapshot(): TrajectoryLiveSnapshot;
  subscribe(listener: () => void): () => void;
  begin(owner: object, input: TrajectoryLiveInput): void;
  reconnect(owner: object, liveOnly?: boolean): void;
  ingest(owner: object, event: DaemonEvent, epoch?: string): void;
  invalidate(owner: object, reason: string): void;
  clear(): void;
}

function emptySnapshot(): TrajectoryLiveSnapshot {
  return {
    status: 'unavailable',
    requests: createExecutionLifecycleState(),
    tools: createToolLifecycleState(),
    incomplete: false,
    truncated: false,
  };
}

function unknownRunning(state: TrajectoryLiveSnapshot): TrajectoryLiveSnapshot {
  return {
    ...state,
    requests: {
      entries: new Map(
        [...state.requests.entries].map(([key, entry]) => [
          key,
          entry.status === 'running'
            ? { ...entry, status: 'unknown' as const }
            : entry,
        ]),
      ),
    },
    tools: {
      entries: new Map(
        [...state.tools.entries].map(([key, entry]) => [
          key,
          entry.status === 'running'
            ? { ...entry, status: 'unknown' as const }
            : entry,
        ]),
      ),
    },
  };
}

function applyLifecycleUnchecked(
  state: TrajectoryLiveSnapshot,
  event: DaemonEvent,
  source: 'live' | 'replay',
): TrajectoryLiveSnapshot {
  if (event.type === 'history_truncated') {
    return { ...state, incomplete: true, truncated: true };
  }
  if (event.type !== 'session_update') return state;
  const update = getSessionUpdatePayload(event.data);
  const request = extractExecutionLifecycle(update);
  const tool = extractToolLifecycle(update);
  const keyOf = (item: {
    sessionId: string;
    subagentId?: string;
    executionId: string;
  }) =>
    JSON.stringify([item.sessionId, item.subagentId ?? null, item.executionId]);
  const requests = reduceExecutionLifecycle(state.requests, update, {
    source:
      request && state.requests.entries.has(keyOf(request)) ? 'replay' : source,
  });
  const tools = reduceToolLifecycle(state.tools, update, {
    source: tool && state.tools.entries.has(keyOf(tool)) ? 'replay' : source,
  });
  if (requests === state.requests && tools === state.tools) return state;
  const evicted =
    !state.truncated &&
    ((request !== undefined &&
      state.requests.entries.size === 256 &&
      !state.requests.entries.has(keyOf(request))) ||
      (tool !== undefined &&
        state.tools.entries.size === 256 &&
        !state.tools.entries.has(keyOf(tool))));
  return { ...state, requests, tools, truncated: state.truncated || evicted };
}

function applyLifecycle(
  state: TrajectoryLiveSnapshot,
  event: DaemonEvent,
  source: 'live' | 'replay',
): TrajectoryLiveSnapshot {
  try {
    return applyLifecycleUnchecked(state, event, source);
  } catch {
    // Match transcript replay's per-frame isolation: bad metadata must not
    // prevent later replay or the shared chat subscription from being consumed.
    return { ...state, incomplete: true };
  }
}

export function createTrajectoryLiveStore(): TrajectoryLiveStore {
  let owner: object | undefined;
  let snapshot = emptySnapshot();
  let cursor: number | undefined;
  let busEpoch: string | undefined;
  let liveOnly = false;
  const transient = (reason?: string) =>
    reason === 'stream_closed' || reason === 'stream_error';
  const listeners = new Set<() => void>();
  const publish = (next: TrajectoryLiveSnapshot) => {
    if (next === snapshot) return;
    snapshot = { ...next, lastEventId: cursor, epoch: busEpoch };
    listeners.forEach((listener) => listener());
  };
  const invalidate = (candidate: object, reason: string) => {
    if (candidate !== owner) return;
    if (snapshot.status === 'stale' && !transient(snapshot.reason)) return;
    publish({ ...unknownRunning(snapshot), status: 'stale', reason });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin(candidate, input) {
      if (candidate === owner) return;
      owner = candidate;
      cursor = input.lastEventId;
      busEpoch = input.epoch;
      liveOnly = false;
      let next: TrajectoryLiveSnapshot = {
        ...emptySnapshot(),
        sessionId: input.sessionId,
        scope: input.scope,
        epoch: input.epoch,
        lastEventId: input.lastEventId,
        status: 'catching-up',
        incomplete: input.incomplete,
      };
      for (const event of input.events)
        next = applyLifecycle(next, event, 'replay');
      publish(next);
    },
    reconnect(candidate, nextLiveOnly = false) {
      if (
        candidate !== owner ||
        (snapshot.status === 'stale' && !transient(snapshot.reason))
      )
        return;
      liveOnly = nextLiveOnly;
      publish({
        ...unknownRunning(snapshot),
        status: 'catching-up',
        reason: undefined,
      });
    },
    ingest(candidate, event, epoch) {
      if (candidate !== owner) return;
      if (epoch !== undefined && busEpoch !== undefined && epoch !== busEpoch) {
        cursor = undefined;
        busEpoch = epoch;
        publish({
          ...unknownRunning(snapshot),
          status: 'stale',
          reason: 'epoch_reset',
          epoch,
          lastEventId: undefined,
        });
        return;
      }
      busEpoch = epoch ?? busEpoch;
      if (event.type === 'state_resync_required') {
        const data = event.data;
        const reason =
          data &&
          typeof data === 'object' &&
          'reason' in data &&
          typeof data.reason === 'string'
            ? data.reason
            : 'state_resync_required';
        invalidate(candidate, reason);
        return;
      }
      if (
        event.type === 'session_closed' ||
        event.type === 'session_died' ||
        event.type === 'stream_error'
      ) {
        invalidate(candidate, event.type);
        return;
      }
      if (snapshot.status === 'stale') return;
      if (event.type === 'replay_complete') {
        liveOnly = false;
        publish({
          ...snapshot,
          epoch: busEpoch,
          status: busEpoch === undefined ? 'unavailable' : 'live',
          reason: busEpoch === undefined ? 'epoch_unavailable' : undefined,
        });
        return;
      }
      if (event.id !== undefined && cursor !== undefined && event.id <= cursor)
        return;
      cursor = event.id ?? cursor;
      const state =
        liveOnly && busEpoch !== undefined
          ? { ...snapshot, status: 'live' as const, reason: undefined }
          : snapshot;
      if (state !== snapshot) liveOnly = false;
      const next = applyLifecycle(
        state,
        event,
        state.status === 'live' ? 'live' : 'replay',
      );
      publish(next);
    },
    invalidate,
    clear() {
      owner = undefined;
      cursor = undefined;
      busEpoch = undefined;
      liveOnly = false;
      publish(emptySnapshot());
    },
  };
}
