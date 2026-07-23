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
const REPLAY_SEGMENT_COMPACT_THRESHOLD = 64;

type CompactedSlot =
  | {
      kind: 'text' | 'thought';
      parentToolCallId?: string;
      chunks: string[];
      sourceRecordIds?: readonly string[];
      lastEventId: number;
      lastMeta: unknown;
      lastEnvelopeMeta?: Record<string, unknown>;
      /**
       * Top-level prompt/originator attribution of the most recent chunk.
       * Preserved onto the merged event so resync consumers can still do
       * prompt correlation and originator filtering after compaction.
       */
      lastTurn?: Pick<BridgeEvent, 'promptId' | 'originatorClientId'>;
      /** `data.sessionId` of the most recent chunk, same rationale. */
      lastSessionId?: string;
    }
  | { kind: 'tool'; toolCallId: string; event: BridgeEvent }
  | { kind: 'misc'; event: BridgeEvent }
  | { kind: 'latestWins'; key: string; event: BridgeEvent };

interface ReplaySegment {
  events: BridgeEvent[];
  bytes: number;
  turnCount: number;
}

function replayRecordId(event: BridgeEvent): string | undefined {
  if (event.type !== 'session_update') return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const update = (data as Record<string, unknown>)['update'];
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return undefined;
  }
  const meta = (update as Record<string, unknown>)['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  const recordId = (meta as Record<string, unknown>)['qwen.session.recordId'];
  return typeof recordId === 'string' ? recordId : undefined;
}

export interface ReplayWindowEviction {
  droppedBytes: number;
  droppedEvents: number;
  droppedSegments: number;
  droppedTurns: number;
  maxBytes: number;
  retainedBytes: number;
  retainedEvents: number;
}

export interface TurnBoundaryCompactionEngineOptions {
  maxReplayBytes?: number;
  onReplayWindowEviction?: (eviction: ReplayWindowEviction) => void;
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
  private readonly onReplayWindowEviction:
    | ((eviction: ReplayWindowEviction) => void)
    | undefined;
  private replaySegments: ReplaySegment[] = [];
  private replaySegmentStart = 0;
  private replayBytes = 0;
  private liveJournal: BridgeEvent[] = [];
  private lastEventId = 0;
  private closed = false;
  private truncatedEvents = 0;
  private truncatedTurns = 0;

  private slots: CompactedSlot[] = [];
  private toolSlotIndex: Map<string, number> = new Map();
  private textSlotIndex: Record<
    'text' | 'thought',
    Map<string, Array<{ sourceRecordIds?: readonly string[]; index: number }>>
  > = {
    text: new Map(),
    thought: new Map(),
  };

  constructor(opts: TurnBoundaryCompactionEngineOptions = {}) {
    this.maxReplayBytes = normalizeCompactedReplayMaxBytes(opts.maxReplayBytes);
    this.onReplayWindowEviction = opts.onReplayWindowEviction;
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
    this.clearTextSlotIndex();
  }

  seedReplayEvents(events: BridgeEvent[]): void {
    if (this.closed) return;
    this.resetReplayWindow();
    let recordEvents: BridgeEvent[] = [];
    let recordId: string | undefined;
    const flushRecord = () => {
      this.addReplaySegment(recordEvents, 0);
      recordEvents = [];
      recordId = undefined;
    };
    for (const event of events) {
      this.recordLastEventId(event);
      if (TRANSIENT_TYPES.has(event.type)) continue;
      const nextRecordId = replayRecordId(event);
      if (nextRecordId === undefined) {
        flushRecord();
        this.addReplaySegment([event], 0);
        continue;
      }
      if (recordId !== undefined && recordId !== nextRecordId) {
        flushRecord();
      }
      recordId = nextRecordId;
      recordEvents.push(event);
    }
    flushRecord();
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetReplayWindow();
    this.liveJournal = [];
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
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
        if (hasTodoStopGuardDiscreteMeta(data?.update?._meta)) {
          this.slots.push({ kind: 'misc', event });
          break;
        }
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
            this.textSlotIndex.text.delete(toolParent);
            this.textSlotIndex.thought.delete(toolParent);
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
    const sourceRecordIds = extractSourceRecordIdsFromMeta(meta);

    if (parentToolCallId != null) {
      // Subagent path: merge by (kind, parentToolCallId) regardless of
      // position. Parallel subagents interleave chunks; the index lets
      // us reassemble each subagent's stream without garbling.
      const entries = this.textSlotIndex[kind].get(parentToolCallId) ?? [];
      const existingIdx = entries.find((entry) =>
        stringArraysEqual(entry.sourceRecordIds, sourceRecordIds),
      )?.index;
      if (existingIdx !== undefined) {
        const slot = this.slots[existingIdx] as Extract<
          CompactedSlot,
          { kind: 'text' | 'thought' }
        >;
        slot.chunks.push(text);
        if (event.id !== undefined) slot.lastEventId = event.id;
        slot.lastMeta = meta ?? slot.lastMeta;
        slot.lastEnvelopeMeta = event._meta ?? slot.lastEnvelopeMeta;
        slot.lastTurn = captureTurnFields(event, slot.lastTurn);
        slot.lastSessionId = captureSessionId(event) ?? slot.lastSessionId;
      } else {
        entries.push({ sourceRecordIds, index: this.slots.length });
        this.textSlotIndex[kind].set(parentToolCallId, entries);
        this.slots.push({
          kind,
          parentToolCallId,
          chunks: [text],
          sourceRecordIds,
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
          lastTurn: captureTurnFields(event),
          lastSessionId: captureSessionId(event),
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
        lastSlot.parentToolCallId == null &&
        stringArraysEqual(lastSlot.sourceRecordIds, sourceRecordIds)
      ) {
        lastSlot.chunks.push(text);
        if (event.id !== undefined) lastSlot.lastEventId = event.id;
        lastSlot.lastMeta = meta ?? lastSlot.lastMeta;
        lastSlot.lastEnvelopeMeta = event._meta ?? lastSlot.lastEnvelopeMeta;
        lastSlot.lastTurn = captureTurnFields(event, lastSlot.lastTurn);
        lastSlot.lastSessionId =
          captureSessionId(event) ?? lastSlot.lastSessionId;
      } else {
        this.slots.push({
          kind,
          parentToolCallId: undefined,
          chunks: [text],
          sourceRecordIds,
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
          lastTurn: captureTurnFields(event),
          lastSessionId: captureSessionId(event),
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
              slot.lastTurn,
              slot.lastSessionId,
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
    this.clearTextSlotIndex();
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
    let droppedSegmentCount = 0;
    let droppedBytes = 0;
    let droppedEvents = 0;
    let droppedTurns = 0;

    while (
      this.replayBytes > this.maxReplayBytes &&
      this.activeReplaySegmentCount() > 1
    ) {
      const dropped = this.replaySegments[this.replaySegmentStart]!;
      this.replaySegmentStart += 1;
      droppedSegmentCount += 1;
      droppedBytes += dropped.bytes;
      droppedEvents += dropped.events.length;
      droppedTurns += dropped.turnCount;
      this.replayBytes -= dropped.bytes;
      this.truncatedEvents += dropped.events.length;
      this.truncatedTurns += dropped.turnCount;
    }

    if (droppedSegmentCount > 0) {
      this.compactReplaySegmentQueueIfNeeded();
      this.notifyReplayWindowEviction({
        droppedBytes,
        droppedEvents,
        droppedSegments: droppedSegmentCount,
        droppedTurns,
        maxBytes: this.maxReplayBytes,
        retainedBytes: this.replayBytes,
        retainedEvents: this.flattenReplaySegments().length,
      });
    }
  }

  private flattenReplaySegments(): BridgeEvent[] {
    return this.replaySegments
      .slice(this.replaySegmentStart)
      .flatMap((segment) => segment.events);
  }

  private activeReplaySegmentCount(): number {
    return this.replaySegments.length - this.replaySegmentStart;
  }

  private compactReplaySegmentQueueIfNeeded(): void {
    if (this.replaySegmentStart < REPLAY_SEGMENT_COMPACT_THRESHOLD) return;
    this.replaySegments.splice(0, this.replaySegmentStart);
    this.replaySegmentStart = 0;
  }

  private notifyReplayWindowEviction(eviction: ReplayWindowEviction): void {
    try {
      this.onReplayWindowEviction?.(eviction);
    } catch {
      // Best-effort diagnostic; eviction accounting must not break replay.
    }
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
        fullTranscriptAvailable: true,
      },
    };
  }

  private resetReplayWindow(): void {
    this.replaySegments = [];
    this.replaySegmentStart = 0;
    this.replayBytes = 0;
    this.truncatedEvents = 0;
    this.truncatedTurns = 0;
  }

  private clearTextSlotIndex(): void {
    this.textSlotIndex.text.clear();
    this.textSlotIndex.thought.clear();
  }
}

function makeMergedSessionUpdateEvent(
  sessionUpdate: string,
  text: string,
  eventId: number,
  meta: unknown,
  envelopeMeta: Record<string, unknown> | undefined,
  turn?: Pick<BridgeEvent, 'promptId' | 'originatorClientId'>,
  sessionId?: string,
): BridgeEvent {
  return {
    id: eventId || undefined,
    v: EVENT_SCHEMA_VERSION,
    type: 'session_update',
    // Re-stamp prompt/originator attribution captured from the source
    // chunks — clients rebuilding state from a compacted snapshot need
    // them for prompt correlation and originator filtering. Present only
    // when the source events carried them ("present only if set" style).
    ...(turn?.promptId !== undefined ? { promptId: turn.promptId } : {}),
    ...(turn?.originatorClientId !== undefined
      ? { originatorClientId: turn.originatorClientId }
      : {}),
    ...(envelopeMeta !== undefined ? { _meta: envelopeMeta } : {}),
    data: {
      ...(sessionId !== undefined ? { sessionId } : {}),
      update: {
        sessionUpdate,
        content: { type: 'text', text },
        ...(meta != null ? { _meta: meta } : {}),
      },
    },
  };
}

/**
 * Field-level merge of `promptId`/`originatorClientId` from an incoming
 * event with an earlier capture. Each field falls back independently so a
 * chunk carrying only one field does not silently drop the other from the
 * previous capture (mirrors the tool_call path's per-field `??` merge).
 */
function captureTurnFields(
  event: BridgeEvent,
  previous?: Pick<BridgeEvent, 'promptId' | 'originatorClientId'>,
): Pick<BridgeEvent, 'promptId' | 'originatorClientId'> | undefined {
  const promptId = event.promptId ?? previous?.promptId;
  const originatorClientId =
    event.originatorClientId ?? previous?.originatorClientId;
  if (promptId === undefined && originatorClientId === undefined) {
    return undefined;
  }
  return {
    ...(promptId !== undefined ? { promptId } : {}),
    ...(originatorClientId !== undefined ? { originatorClientId } : {}),
  };
}

/** `data.sessionId` of an event when present and a string. */
function captureSessionId(event: BridgeEvent): string | undefined {
  const sessionId = (event.data as { sessionId?: unknown } | undefined)
    ?.sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
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

function extractSourceRecordIdsFromMeta(
  meta: unknown,
): readonly string[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const transcript = (meta as Record<string, unknown>)['qwenTranscript'];
  if (typeof transcript !== 'object' || transcript === null) return undefined;
  const ids = (transcript as Record<string, unknown>)['sourceRecordIds'];
  if (!Array.isArray(ids)) return undefined;
  const normalized = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string')),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function stringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function hasTodoStopGuardDiscreteMeta(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as Record<string, unknown>)['qwenDiscreteMessage'] === true &&
    (meta as Record<string, unknown>)['source'] === 'todo_stop_guard'
  );
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
  const updateMeta = mergeTranscriptUpdateMeta(
    existingUpdate['_meta'],
    incomingUpdate['_meta'],
  );
  if (updateMeta !== undefined) merged['_meta'] = updateMeta;
  // Always use 'tool_call' as the compacted type
  merged['sessionUpdate'] = 'tool_call';
  const mergedMeta =
    existing._meta || incoming._meta
      ? { ...(existing._meta ?? {}), ...(incoming._meta ?? {}) }
      : undefined;
  // Latest-wins attribution, mirroring `id`: the folded tool_call keeps
  // the most recent prompt/originator stamp so resync consumers can still
  // correlate it to its turn ("present only if set" style).
  const promptId = incoming.promptId ?? existing.promptId;
  const originatorClientId =
    incoming.originatorClientId ?? existing.originatorClientId;

  return {
    id: incoming.id ?? existing.id,
    v: EVENT_SCHEMA_VERSION,
    type: 'session_update',
    ...(promptId !== undefined ? { promptId } : {}),
    ...(originatorClientId !== undefined ? { originatorClientId } : {}),
    ...(mergedMeta ? { _meta: mergedMeta } : {}),
    data: {
      ...existingData,
      ...incomingData,
      update: merged,
    },
  };
}

function mergeTranscriptUpdateMeta(
  existing: unknown,
  incoming: unknown,
): unknown {
  const existingRecord =
    typeof existing === 'object' && existing !== null
      ? (existing as Record<string, unknown>)
      : undefined;
  const incomingRecord =
    typeof incoming === 'object' && incoming !== null
      ? (incoming as Record<string, unknown>)
      : undefined;
  if (!existingRecord && !incomingRecord) return undefined;
  const sourceRecordIds = [
    ...new Set([
      ...(extractSourceRecordIdsFromMeta(existingRecord) ?? []),
      ...(extractSourceRecordIdsFromMeta(incomingRecord) ?? []),
    ]),
  ];
  return {
    ...(existingRecord ?? {}),
    ...(incomingRecord ?? {}),
    ...(sourceRecordIds.length > 0
      ? { qwenTranscript: { sourceRecordIds } }
      : {}),
  };
}
