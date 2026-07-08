/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EVENT_SCHEMA_VERSION,
  serializedBridgeEventByteLength,
  type BridgeEvent,
  type CompactionEngine,
  type SessionReplaySnapshot,
} from './eventBus.js';
import { normalizeCompactedReplayMaxBytes } from './replayWindowLimits.js';

export type { CompactionEngine, SessionReplaySnapshot };
export {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  MAX_COMPACTED_REPLAY_MAX_BYTES,
  normalizeCompactedReplayMaxBytes,
} from './replayWindowLimits.js';

interface SessionUpdateData {
  update?: {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
    toolCallId?: string;
    status?: string;
    _meta?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const TURN_BOUNDARY_TYPES = new Set(['turn_complete', 'turn_error']);
const TRANSIENT_TYPES = new Set([
  'history_truncated',
  'slow_client_warning',
  'client_evicted',
  'replay_complete',
  'stream_error',
]);
const LATEST_WINS_UPDATES = new Set([
  'available_commands_update',
  'current_mode_update',
]);

type CompactedSlot =
  | {
      kind: 'text' | 'thought';
      parentToolCallId?: string;
      chunks: string[];
      lastEventId: number;
      lastMeta: unknown;
      lastEnvelopeMeta?: Record<string, unknown>;
    }
  | { kind: 'tool'; toolCallId: string; event: BridgeEvent }
  | { kind: 'misc'; event: BridgeEvent }
  | { kind: 'latestWins'; key: string; event: BridgeEvent };

interface ReplaySegment {
  events: BridgeEvent[];
  bytes: number;
  turnCount: number;
}

export interface TurnBoundaryCompactionEngineOptions {
  maxReplayBytes?: number;
}

/**
 * Compaction engine that merges events at turn boundaries.
 *
 * On each `turn_complete` / `turn_error`, all accumulated events for that
 * turn are folded: consecutive text/thought chunks merge into single events,
 * tool call sequences fold to final state, transient signals are dropped.
 * The relative ordering of different event types is preserved.
 *
 * The result is a replay log whose size is O(conversation_turns), not
 * O(streaming_tokens). Typical compression: 25-30x for chatty sessions.
 */
export class TurnBoundaryCompactionEngine implements CompactionEngine {
  private readonly maxReplayBytes: number;
  private replaySegments: ReplaySegment[] = [];
  private replayBytes = 0;
  private liveJournal: BridgeEvent[] = [];
  private lastEventId = 0;
  private closed = false;
  private truncatedEvents = 0;
  private truncatedTurns = 0;

  private slots: CompactedSlot[] = [];
  private toolSlotIndex: Map<string, number> = new Map();
  private textSlotIndex: Map<string, number> = new Map();

  constructor(opts: TurnBoundaryCompactionEngineOptions = {}) {
    this.maxReplayBytes = normalizeCompactedReplayMaxBytes(opts.maxReplayBytes);
  }

  ingest(event: BridgeEvent): void {
    if (this.closed) return;
    if (event.id !== undefined) {
      this.lastEventId = event.id;
    }

    if (TRANSIENT_TYPES.has(event.type)) return;

    this.liveJournal.push(event);

    if (TURN_BOUNDARY_TYPES.has(event.type)) {
      this.compactCurrentTurn(event);
      return;
    }

    if (event.type === 'session_update') {
      this.classifySessionUpdate(event);
      return;
    }

    this.slots.push({ kind: 'misc', event });
  }

  snapshot(): SessionReplaySnapshot {
    const compactedTurns = this.flattenReplaySegments();
    if (this.truncatedEvents > 0) {
      compactedTurns.unshift(
        this.makeHistoryTruncatedEvent(compactedTurns.length),
      );
    }
    return {
      compactedTurns,
      liveJournal: this.liveJournal.slice(),
      lastEventId: this.lastEventId,
    };
  }

  seed(snapshot: { compactedTurns: BridgeEvent[]; lastEventId: number }): void {
    if (this.closed) return;
    this.resetReplayWindow();
    this.lastEventId = snapshot.lastEventId;
    for (const event of snapshot.compactedTurns) {
      if (TRANSIENT_TYPES.has(event.type)) continue;
      this.addReplaySegment([event], 0);
    }
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.textSlotIndex.clear();
  }

  seedReplayEvents(events: BridgeEvent[]): void {
    if (this.closed) return;
    for (const event of events) {
      this.recordLastEventId(event);
      if (TRANSIENT_TYPES.has(event.type)) continue;
      this.addReplaySegment([event], 0);
    }
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.textSlotIndex.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetReplayWindow();
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.textSlotIndex.clear();
  }

  private classifySessionUpdate(event: BridgeEvent): void {
    const data = event.data as SessionUpdateData | undefined;
    const updateType = data?.update?.sessionUpdate;

    if (!updateType) {
      this.slots.push({ kind: 'misc', event });
      return;
    }

    switch (updateType) {
      case 'agent_message_chunk': {
        this.mergeTextSlot('text', event, data);
        break;
      }
      case 'agent_thought_chunk': {
        this.mergeTextSlot('thought', event, data);
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const toolCallId = data?.update?.toolCallId;
        if (!toolCallId) {
          this.slots.push({ kind: 'misc', event });
          break;
        }
        const existingIdx = this.toolSlotIndex.get(toolCallId);
        if (existingIdx !== undefined) {
          const slot = this.slots[existingIdx] as Extract<
            CompactedSlot,
            { kind: 'tool' }
          >;
          slot.event = mergeToolCallEvent(slot.event, event);
        } else {
          const normalizedEvent = normalizeToolCallType(event);
          this.toolSlotIndex.set(toolCallId, this.slots.length);
          this.slots.push({
            kind: 'tool',
            toolCallId,
            event: normalizedEvent,
          });
          // Evict text/thought index entries for this tool's parent so
          // subsequent chunks from the same subagent create new slots,
          // preserving text segmentation around tool-call boundaries.
          const toolParent = extractParentToolCallIdFromMeta(
            data?.update?._meta,
          );
          if (toolParent) {
            this.textSlotIndex.delete(`text::${toolParent}`);
            this.textSlotIndex.delete(`thought::${toolParent}`);
          }
        }
        break;
      }
      default: {
        if (LATEST_WINS_UPDATES.has(updateType)) {
          const existingIdx = this.slots.findIndex(
            (s) => s.kind === 'latestWins' && s.key === updateType,
          );
          if (existingIdx !== -1) {
            (
              this.slots[existingIdx] as Extract<
                CompactedSlot,
                { kind: 'latestWins' }
              >
            ).event = event;
          } else {
            this.slots.push({ kind: 'latestWins', key: updateType, event });
          }
        } else {
          this.slots.push({ kind: 'misc', event });
        }
        break;
      }
    }
  }

  private mergeTextSlot(
    kind: 'text' | 'thought',
    event: BridgeEvent,
    data: SessionUpdateData | undefined,
  ): void {
    const text = data?.update?.content?.text ?? '';
    const meta = data?.update?._meta;
    const parentToolCallId = extractParentToolCallIdFromMeta(meta);

    if (parentToolCallId != null) {
      // Subagent path: merge by (kind, parentToolCallId) regardless of
      // position. Parallel subagents interleave chunks; the index lets
      // us reassemble each subagent's stream without garbling.
      const slotKey = `${kind}::${parentToolCallId}`;
      const existingIdx = this.textSlotIndex.get(slotKey);
      if (existingIdx !== undefined) {
        const slot = this.slots[existingIdx] as Extract<
          CompactedSlot,
          { kind: 'text' | 'thought' }
        >;
        slot.chunks.push(text);
        if (event.id !== undefined) slot.lastEventId = event.id;
        slot.lastMeta = meta ?? slot.lastMeta;
        slot.lastEnvelopeMeta = event._meta ?? slot.lastEnvelopeMeta;
      } else {
        this.textSlotIndex.set(slotKey, this.slots.length);
        this.slots.push({
          kind,
          parentToolCallId,
          chunks: [text],
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
        });
      }
    } else {
      // Top-level path: merge only consecutive same-kind chunks that
      // also have no parentToolCallId. Preserves text segmentation
      // around tool calls (text before / text after stay separate).
      const lastSlot = this.slots[this.slots.length - 1];
      if (
        lastSlot &&
        lastSlot.kind === kind &&
        lastSlot.parentToolCallId == null
      ) {
        lastSlot.chunks.push(text);
        if (event.id !== undefined) lastSlot.lastEventId = event.id;
        lastSlot.lastMeta = meta ?? lastSlot.lastMeta;
        lastSlot.lastEnvelopeMeta = event._meta ?? lastSlot.lastEnvelopeMeta;
      } else {
        this.slots.push({
          kind,
          parentToolCallId: undefined,
          chunks: [text],
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
        });
      }
    }
  }

  private compactCurrentTurn(boundaryEvent: BridgeEvent): void {
    const compacted: BridgeEvent[] = [];

    for (const slot of this.slots) {
      switch (slot.kind) {
        case 'text':
        case 'thought':
          compacted.push(
            makeMergedSessionUpdateEvent(
              slot.kind === 'text'
                ? 'agent_message_chunk'
                : 'agent_thought_chunk',
              slot.chunks.join(''),
              slot.lastEventId,
              slot.lastMeta,
              slot.lastEnvelopeMeta,
            ),
          );
          break;
        case 'tool':
        case 'misc':
        case 'latestWins':
          compacted.push(slot.event);
          break;
        default:
          break;
      }
    }

    compacted.push(boundaryEvent);
    this.addReplaySegment(compacted, 1);
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.textSlotIndex.clear();
  }

  private recordLastEventId(event: BridgeEvent): void {
    if (event.id !== undefined) {
      this.lastEventId = event.id;
    }
  }

  private addReplaySegment(events: BridgeEvent[], turnCount: number): void {
    if (events.length === 0) return;
    const bytes = events.reduce(
      (sum, event) => sum + serializedBridgeEventByteLength(event),
      0,
    );
    this.replaySegments.push({ events: events.slice(), bytes, turnCount });
    this.replayBytes += bytes;
    this.enforceReplayWindow();
  }

  private enforceReplayWindow(): void {
    while (
      this.replayBytes > this.maxReplayBytes &&
      this.replaySegments.length > 1
    ) {
      const dropped = this.replaySegments.shift()!;
      this.replayBytes -= dropped.bytes;
      this.truncatedEvents += dropped.events.length;
      this.truncatedTurns += dropped.turnCount;
    }
  }

  private flattenReplaySegments(): BridgeEvent[] {
    return this.replaySegments.flatMap((segment) => segment.events);
  }

  private makeHistoryTruncatedEvent(retainedEvents: number): BridgeEvent {
    return {
      v: EVENT_SCHEMA_VERSION,
      type: 'history_truncated',
      data: {
        reason: 'replay_window_exceeded',
        truncatedEvents: this.truncatedEvents,
        retainedEvents,
        maxBytes: this.maxReplayBytes,
        ...(this.truncatedTurns > 0
          ? { truncatedTurns: this.truncatedTurns }
          : {}),
        fullTranscriptAvailable: false,
      },
    };
  }

  private resetReplayWindow(): void {
    this.replaySegments = [];
    this.replayBytes = 0;
    this.truncatedEvents = 0;
    this.truncatedTurns = 0;
  }
}

function makeMergedSessionUpdateEvent(
  sessionUpdate: string,
  text: string,
  eventId: number,
  meta: unknown,
  envelopeMeta: Record<string, unknown> | undefined,
): BridgeEvent {
  return {
    id: eventId || undefined,
    v: EVENT_SCHEMA_VERSION,
    type: 'session_update',
    ...(envelopeMeta !== undefined ? { _meta: envelopeMeta } : {}),
    data: {
      update: {
        sessionUpdate,
        content: { type: 'text', text },
        ...(meta != null ? { _meta: meta } : {}),
      },
    },
  };
}

function normalizeToolCallType(event: BridgeEvent): BridgeEvent {
  const data = event.data as SessionUpdateData | undefined;
  if (data?.update?.sessionUpdate === 'tool_call_update') {
    return {
      ...event,
      data: {
        ...data,
        update: { ...data.update, sessionUpdate: 'tool_call' },
      },
    };
  }
  return event;
}

function extractParentToolCallIdFromMeta(meta: unknown): string | undefined {
  if (typeof meta === 'object' && meta !== null) {
    const val = (meta as Record<string, unknown>)['parentToolCallId'];
    return typeof val === 'string' && val.length > 0 ? val : undefined;
  }
  return undefined;
}

function mergeToolCallEvent(
  existing: BridgeEvent,
  incoming: BridgeEvent,
): BridgeEvent {
  const existingData = existing.data as SessionUpdateData | undefined;
  const incomingData = incoming.data as SessionUpdateData | undefined;
  const existingUpdate = existingData?.update ?? {};
  const incomingUpdate = incomingData?.update ?? {};

  const merged: Record<string, unknown> = { ...existingUpdate };
  for (const [key, value] of Object.entries(incomingUpdate)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  // Always use 'tool_call' as the compacted type
  merged['sessionUpdate'] = 'tool_call';
  const mergedMeta =
    existing._meta || incoming._meta
      ? { ...(existing._meta ?? {}), ...(incoming._meta ?? {}) }
      : undefined;

  return {
    id: incoming.id ?? existing.id,
    v: EVENT_SCHEMA_VERSION,
    type: 'session_update',
    ...(mergedMeta ? { _meta: mergedMeta } : {}),
    data: {
      ...existingData,
      ...incomingData,
      update: merged,
    },
  };
}
