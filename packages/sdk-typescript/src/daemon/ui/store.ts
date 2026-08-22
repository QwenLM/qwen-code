/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTranscriptBlock,
  DaemonTranscriptBlockChangeSummary,
  DaemonTranscriptReducerOptions,
  DaemonTranscriptState,
  DaemonTextDeltaMeta,
  DaemonTranscriptStore,
  DaemonUiEvent,
} from './types.js';
import {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
  estimateDaemonTranscriptBlockBytes,
  rebuildDaemonTranscriptBlockIndex,
  reduceDaemonTranscriptEvents,
} from './transcript.js';

export function createDaemonTranscriptStore(
  seed: Partial<DaemonTranscriptState> &
    Pick<DaemonTranscriptReducerOptions, 'onTruncation'> = {},
): DaemonTranscriptStore {
  // Held in the closure (not on the state object) so `reset()` keeps the
  // listener registered across wholesale state replacements.
  const { onTruncation, ...stateSeed } = seed;
  const reducerOptions: DaemonTranscriptReducerOptions = onTruncation
    ? { onTruncation }
    : {};
  let state = createState(stateSeed);
  const blockChangeSource = {};
  let blockChangeSummary: DaemonTranscriptBlockChangeSummary = {
    source: blockChangeSource,
    revision: 0,
    tailAppendBarrierRevision: 0,
  };
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
    getBlockChangeSummary() {
      return blockChangeSummary;
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
      const previous = state;
      state = reduceDaemonTranscriptEvents(previous, events, reducerOptions);
      blockChangeSummary = nextBlockChangeSummary(
        blockChangeSummary,
        previous,
        state,
        events,
      );
      scheduleNotify();
    },
    appendLocalUserMessage(
      text: string,
      images?: Array<{ data: string; mimeType: string }>,
      meta?: DaemonTextDeltaMeta,
      files?: Array<{
        name: string;
        mimeType: string;
        data?: Blob;
        text?: string;
        attachmentId?: string;
      }>,
    ) {
      state = appendLocalUserTranscriptMessage(state, text, {
        images,
        meta,
        files,
        ...reducerOptions,
      });
      blockChangeSummary = invalidateTailAppend(blockChangeSummary);
      scheduleNotify();
    },
    reset(nextSeed: Partial<DaemonTranscriptState> = {}) {
      state = createState({
        maxBlocks: nextSeed.maxBlocks ?? state.maxBlocks,
        maxRetainedBytes: nextSeed.maxRetainedBytes ?? state.maxRetainedBytes,
        retainSubagentBlocks:
          nextSeed.retainSubagentBlocks ?? state.retainSubagentBlocks,
        ...nextSeed,
      });
      blockChangeSummary = invalidateTailAppend(blockChangeSummary);
      scheduleNotify();
    },
    // wenshao R4-R6 (qwen3.7-max): explicit recovery from the
    // `awaitingResync` one-way latch.
    //
    // RECOVERY FLOW (correct order — wenshao R6 caught a flow bug):
    //   1. Daemon emits `session.state_resync_required`; reducer sets
    //      `state.awaitingResync = true` and starts dropping events.
    //   2. Consumer decides on recovery strategy and calls EITHER:
    //        a. `reset()` — clean slate, discard local blocks
    //        b. `clearAwaitingResync()` — keep local blocks, accept
    //           new events. Call BEFORE the new SSE stream starts
    //           delivering events (or BEFORE a `Last-Event-ID: 0`
    //           replay starts), otherwise the replay events get
    //           dropped by the latch guard.
    //   3. Re-subscribe to SSE; events flow normally.
    //
    // (The earlier JSDoc said "after replay drains" — that was wrong.
    // While the latch is set, every replay event is dropped, so the
    // window between latch-clear and stream-start is what receives
    // events. Clear early; if dispatch order misses something the
    // daemon will eventually emit a new `state_resync_required`.)
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
    clearFollowupSuggestion() {
      if (state.lastFollowupSuggestion === undefined) return;
      state = { ...state, lastFollowupSuggestion: undefined };
      scheduleNotify();
    },
  };
}

function nextBlockChangeSummary(
  current: DaemonTranscriptBlockChangeSummary,
  previous: DaemonTranscriptState,
  next: DaemonTranscriptState,
  events: readonly DaemonUiEvent[],
): DaemonTranscriptBlockChangeSummary {
  if (previous.blocks === next.blocks) return current;
  const revision = current.revision + 1;
  const tailBlockId = streamingTailAppendBlockId(previous, next, events);
  return tailBlockId
    ? {
        source: current.source,
        revision,
        tailAppendBarrierRevision: current.tailAppendBarrierRevision,
        tailBlockId,
      }
    : {
        source: current.source,
        revision,
        tailAppendBarrierRevision: revision,
      };
}

function invalidateTailAppend(
  current: DaemonTranscriptBlockChangeSummary,
): DaemonTranscriptBlockChangeSummary {
  const revision = current.revision + 1;
  return {
    source: current.source,
    revision,
    tailAppendBarrierRevision: revision,
  };
}

function streamingTailAppendBlockId(
  previous: DaemonTranscriptState,
  next: DaemonTranscriptState,
  events: readonly DaemonUiEvent[],
): string | undefined {
  const first = events[0];
  if (
    !first ||
    (first.type !== 'assistant.text.delta' &&
      first.type !== 'thought.text.delta') ||
    first.parentToolCallId !== undefined ||
    events.some(
      (event) =>
        event.type !== first.type ||
        ('parentToolCallId' in event && event.parentToolCallId !== undefined),
    ) ||
    previous.blocks.length === 0 ||
    previous.blocks.length !== next.blocks.length ||
    previous.blockIndexById !== next.blockIndexById
  ) {
    return undefined;
  }

  const blockId =
    first.type === 'assistant.text.delta'
      ? previous.activeAssistantBlockId
      : previous.activeThoughtBlockId;
  const nextBlockId =
    first.type === 'assistant.text.delta'
      ? next.activeAssistantBlockId
      : next.activeThoughtBlockId;
  const before = previous.blocks[previous.blocks.length - 1];
  const after = next.blocks[next.blocks.length - 1];
  const appendedTextLength = events.reduce(
    (length, event) =>
      length +
      (event.type === 'assistant.text.delta' ||
      event.type === 'thought.text.delta'
        ? event.text.length
        : 0),
    0,
  );
  if (
    !blockId ||
    nextBlockId !== blockId ||
    before?.id !== blockId ||
    after?.id !== blockId ||
    before.kind !== after.kind ||
    !isTextBlock(before) ||
    !isTextBlock(after) ||
    after.streaming !== true ||
    before.parentToolCallId !== after.parentToolCallId ||
    before.meta !== after.meta ||
    before.usage !== after.usage ||
    before.branchRecordId !== after.branchRecordId ||
    before.clientReceivedAt !== after.clientReceivedAt ||
    before.promptId !== after.promptId ||
    before.sourceRecordIds !== after.sourceRecordIds ||
    after.text.length !== before.text.length + appendedTextLength
  ) {
    return undefined;
  }
  return blockId;
}

function isTextBlock(
  block: DaemonTranscriptBlock,
): block is Extract<
  DaemonTranscriptBlock,
  { kind: 'assistant' | 'thought' | 'user' }
> {
  return (
    block.kind === 'assistant' ||
    block.kind === 'thought' ||
    block.kind === 'user'
  );
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
      maxRetainedBytes: seed.maxRetainedBytes,
      now: seed.now,
    }),
    ...seed,
    blocks,
    // Seeded blocks (e.g. a replay snapshot handed to `reset`) must count
    // toward the retention byte budget from the start.
    retainedBytes:
      seed.retainedBytes ??
      blocks.reduce(
        (total, block) => total + estimateDaemonTranscriptBlockBytes(block),
        0,
      ),
    blockIndexById: rebuildDaemonTranscriptBlockIndex(blocks),
    toolBlockByCallId: createNullIndex(seed.toolBlockByCallId),
    trimmedToolNotificationByCallId: createNullIndex(
      seed.trimmedToolNotificationByCallId,
    ),
    permissionBlockByRequestId: createNullIndex(
      seed.permissionBlockByRequestId,
    ),
    toolProgress: createNullIndex(seed.toolProgress),
    activeAssistantBlockByParent: createNullIndex(
      seed.activeAssistantBlockByParent,
    ),
    activeThoughtBlockByParent: createNullIndex(
      seed.activeThoughtBlockByParent,
    ),
    lastResyncRequired:
      seed.lastResyncRequired !== undefined
        ? { ...seed.lastResyncRequired }
        : undefined,
    lastFollowupSuggestion:
      seed.lastFollowupSuggestion !== undefined
        ? { ...seed.lastFollowupSuggestion }
        : undefined,
  };
}

function createNullIndex<T>(
  source?: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source);
}
