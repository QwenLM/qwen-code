/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTranscriptState,
  DaemonTranscriptStore,
  DaemonUiEvent,
} from './types.js';
import {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
  rebuildDaemonTranscriptBlockIndex,
  reduceDaemonTranscriptEvents,
} from './transcript.js';

export function createDaemonTranscriptStore(
  seed: Partial<DaemonTranscriptState> = {},
): DaemonTranscriptStore {
  let state = createState(seed);
  const listeners = new Set<() => void>();
  let notifyScheduled = false;

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  };
  const scheduleNotify = () => {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      notify();
    });
  };

  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(event: DaemonUiEvent | DaemonUiEvent[]) {
      const events = Array.isArray(event) ? event : [event];
      if (events.length === 0) return;
      state = reduceDaemonTranscriptEvents(state, events);
      scheduleNotify();
    },
    appendLocalUserMessage(text: string) {
      state = appendLocalUserTranscriptMessage(state, text);
      scheduleNotify();
    },
    reset(nextSeed: Partial<DaemonTranscriptState> = {}) {
      state = createState({
        maxBlocks: nextSeed.maxBlocks ?? state.maxBlocks,
        ...nextSeed,
      });
      scheduleNotify();
    },
    // wenshao R4 (qwen3.7-max): explicit recovery from the
    // `awaitingResync` one-way latch. After the client receives a
    // `session.state_resync_required` event, it should:
    //   1. Drop local state if a full replay isn't feasible, OR
    //   2. Re-subscribe with `Last-Event-ID: 0` to receive a full
    //      replay, then call `clearAwaitingResync()` once the replay
    //      stream has drained.
    // Without this API the latch could only be cleared by `reset()`,
    // which forces session-id reset semantics — wrong shape for the
    // same-session-with-replay recovery flow.
    clearAwaitingResync() {
      if (!state.awaitingResync) return;
      state = {
        ...state,
        awaitingResync: false,
        // Keep lastResyncRequired for diagnostic visibility — consumers
        // who want a clean slate can also call reset().
      };
      scheduleNotify();
    },
  };
}

function reportListenerError(error: unknown): void {
  const reporter = (
    globalThis as typeof globalThis & {
      reportError?: (error: unknown) => void;
    }
  ).reportError;
  if (typeof reporter === 'function') {
    reporter(error);
    return;
  }
  const logger = globalThis.console?.error;
  if (typeof logger === 'function') {
    logger.call(globalThis.console, error);
  }
}

function createState(
  seed: Partial<DaemonTranscriptState>,
): DaemonTranscriptState {
  const blocks = seed.blocks ? [...seed.blocks] : [];
  return {
    ...createDaemonTranscriptState({
      maxBlocks: seed.maxBlocks,
      now: seed.now,
    }),
    ...seed,
    blocks,
    blockIndexById: rebuildDaemonTranscriptBlockIndex(blocks),
    toolBlockByCallId: { ...(seed.toolBlockByCallId ?? {}) },
    trimmedToolNotificationByCallId: {
      ...(seed.trimmedToolNotificationByCallId ?? {}),
    },
    permissionBlockByRequestId: {
      ...(seed.permissionBlockByRequestId ?? {}),
    },
    toolProgress: { ...(seed.toolProgress ?? {}) },
    lastResyncRequired:
      seed.lastResyncRequired !== undefined
        ? { ...seed.lastResyncRequired }
        : undefined,
  };
}
