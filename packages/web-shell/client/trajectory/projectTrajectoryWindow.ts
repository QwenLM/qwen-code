/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDaemonTranscriptState,
  extractTranscriptTiming,
  getSessionUpdatePayload,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptState,
  type DaemonUiEvent,
} from '@qwen-code/sdk/daemon';
import type { TrajectoryEntry } from './types';

/**
 * The trajectory window holds whole transcript pages and is trimmed by dropping
 * pages, so the reducer's own block/byte ceilings must not evict anything: a
 * trimmed block would silently drop a row while its timing frame stayed.
 */
const NO_TRIM: number = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Record uuid the daemon stamps on a replayed event, used as row identity.
 * Mirrors the envelope shape the session provider reads.
 */
function persistedRecordId(
  update: Record<string, unknown>,
): string | undefined {
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  const recordId = meta?.['qwen.session.recordId'];
  return typeof recordId === 'string' && recordId.length > 0
    ? recordId
    : undefined;
}

/**
 * Chat surfaces a daemon error as a notice rather than a transcript block,
 * except on `turn_error` where it is the turn's outcome. The trajectory keeps
 * the same split so both views describe the same run; the notice side is the
 * session provider's job and has no place in a pure projection.
 */
function keepForTranscript(source: DaemonEvent, event: DaemonUiEvent): boolean {
  return event.type !== 'error' || source.type === 'turn_error';
}

/**
 * Project one contiguous run of raw daemon events into ordered trajectory
 * entries: the blocks the SDK reducer materializes, with each timing frame
 * placed where its telemetry record was written.
 *
 * A timing frame's position is the block count at the moment it arrived. The
 * telemetry record for a model request is written after that round's tool
 * results — which update blocks already in the list rather than appending — and
 * before the next assistant record, which appends. So "after the current last
 * block" lands the frame between the two, matching the record order on disk.
 *
 * A timing frame is never normalized at all. Every other reader turns it into
 * nothing, and leaning on that would put a row in the table the day a
 * normalizer started surfacing it.
 */
export function projectTrajectoryWindow(
  events: readonly DaemonEvent[],
): TrajectoryEntry[] {
  let state: DaemonTranscriptState = createDaemonTranscriptState({
    maxBlocks: NO_TRIM,
    maxRetainedBytes: NO_TRIM,
    retainSubagentBlocks: true,
  });
  // Buffered so the reducer runs once per metering frame instead of once per
  // event: it copies the block list on every call, and a window is thousands
  // of events but only a handful of frames.
  let pending: DaemonUiEvent[] = [];
  const meters: Array<{
    entry: Extract<TrajectoryEntry, { kind: 'timing' | 'usage' }>;
    afterBlockCount: number;
  }> = [];

  const flush = () => {
    if (pending.length === 0) return;
    state = reduceDaemonTranscriptEvents(state, pending);
    pending = [];
  };

  for (const event of events) {
    const update =
      event.type === 'session_update' && isRecord(event.data)
        ? getSessionUpdatePayload(event.data)
        : undefined;
    const timing = update ? extractTranscriptTiming(update) : undefined;
    if (timing && update) {
      flush();
      const recordId = persistedRecordId(update);
      meters.push({
        entry: {
          kind: 'timing',
          timing,
          ...(recordId !== undefined ? { recordId } : {}),
        },
        afterBlockCount: state.blocks.length,
      });
      continue;
    }
    try {
      for (const uiEvent of normalizeDaemonEvent(event)) {
        if (!keepForTranscript(event, uiEvent)) continue;
        if (
          uiEvent.type === 'assistant.usage' &&
          uiEvent.parentToolCallId === undefined
        ) {
          flush();
          meters.push({
            entry: { kind: 'usage', usage: uiEvent.usage },
            afterBlockCount: state.blocks.length,
          });
        }
        // Dispatched as well as recorded: the block keeps the folded counts
        // Chat renders, and the entry keeps the per-round split this view needs.
        pending.push(uiEvent);
      }
    } catch {
      // One malformed event must not cost the whole window. Chat drops it the
      // same way; there is nothing to recover from a frame that cannot be read.
    }
  }
  flush();

  const entries: TrajectoryEntry[] = [];
  let next = 0;
  for (const [index, block] of state.blocks.entries()) {
    while (next < meters.length && meters[next]!.afterBlockCount <= index) {
      entries.push(meters[next]!.entry);
      next += 1;
    }
    entries.push({ kind: 'block', block });
  }
  for (; next < meters.length; next += 1) {
    entries.push(meters[next]!.entry);
  }
  return entries;
}
