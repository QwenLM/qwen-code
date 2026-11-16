/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionClient } from '@qwen-code/sdk/daemon';

export interface SessionConfigSync {
  generation: number;
  pendingWrites: number;
  readSequence: number;
  refresh?: () => void;
}

export type SessionConfigSyncMap = WeakMap<
  DaemonSessionClient,
  SessionConfigSync
>;

export function getSessionConfigSync(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
): SessionConfigSync {
  let state = states.get(session);
  if (!state) {
    state = { generation: 0, pendingWrites: 0, readSequence: 0 };
    states.set(session, state);
  }
  return state;
}

export function resetSessionConfigSync(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
): void {
  // A reconnect of the same client object is a new attachment for config IO.
  states.delete(session);
  getSessionConfigSync(states, session);
}

export function observeSessionConfig(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
): void {
  getSessionConfigSync(states, session).generation++;
}

export function beginSessionConfigRead(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
): () => boolean {
  const state = getSessionConfigSync(states, session);
  const generation = state.generation;
  const epoch = session.eventEpoch;
  const sequence = ++state.readSequence;
  return () =>
    states.get(session) === state &&
    session.eventEpoch === epoch &&
    state.pendingWrites === 0 &&
    state.generation === generation &&
    state.readSequence === sequence;
}

function flushRefresh(state: SessionConfigSync): void {
  queueMicrotask(() => {
    if (state.pendingWrites !== 0) return;
    const refresh = state.refresh;
    state.refresh = undefined;
    refresh?.();
  });
}

export function queueSessionConfigRefresh(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
  refresh: () => void,
): void {
  const state = getSessionConfigSync(states, session);
  state.refresh = refresh;
  flushRefresh(state);
}

export function beginSessionConfigMutation(
  states: SessionConfigSyncMap,
  session: DaemonSessionClient,
): { finish: () => void; isCurrent: () => boolean } {
  const state = getSessionConfigSync(states, session);
  const generation = ++state.generation;
  const readSequence = state.readSequence;
  state.pendingWrites++;
  let finished = false;
  return {
    finish() {
      if (finished) return;
      finished = true;
      state.generation++;
      state.pendingWrites--;
      flushRefresh(state);
    },
    isCurrent: () =>
      states.get(session) === state &&
      state.generation === generation + (finished ? 1 : 0) &&
      state.readSequence === readSequence,
  };
}
