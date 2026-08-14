/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EVENT_SCHEMA_VERSION,
  logEventSizingFailed,
  serializedBridgeEventByteLength,
  type BridgeEvent,
  type CompactionEngine,
  type LiveReplayMode,
  type SessionReplaySnapshot,
} from './eventBus.js';
import {
  normalizeCompactedReplayMaxBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents,
} from './replayWindowLimits.js';

export type { CompactionEngine, SessionReplaySnapshot };
export {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  MAX_COMPACTED_REPLAY_MAX_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeJournalGrowthPoolBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents,
} from './replayWindowLimits.js';
export type { JournalGrowthSessionLimit } from './replayWindowLimits.js';

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
const LIVE_JOURNAL_TEXT_CHUNKS_PER_EVENT = 256;

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

interface LiveJournalTextSegment {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
  chunks: string[];
  sourceRecordIds?: readonly string[];
  parentToolCallId?: string;
  promptId?: string;
  originatorClientId?: string;
  sessionId?: string;
  firstEvent: BridgeEvent;
  lastEvent: BridgeEvent;
}

interface LiveJournalState {
  entries: Array<BridgeEvent | LiveJournalTextSegment>;
  entryBytes: number[];
  entryEvents: number[];
  totalBytes: number;
  totalEvents: number;
  truncatedEvents: number;
  textSegment?: LiveJournalTextSegment;
}

function createLiveJournalState(): LiveJournalState {
  return {
    entries: [],
    entryBytes: [],
    entryEvents: [],
    totalBytes: 0,
    totalEvents: 0,
    truncatedEvents: 0,
  };
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

function lastRecordIdIn(events: BridgeEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = replayRecordId(events[i]!);
    if (id !== undefined) return id;
  }
  return undefined;
}

function lastSummaryRecordIdIn(events: BridgeEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!isSummaryLiveJournalEvent(events[i]!)) continue;
    const id = replayRecordId(events[i]!);
    if (id !== undefined) return id;
  }
  return undefined;
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

/** Current journal caps of a growth request/acknowledgement. */
export interface JournalLimits {
  maxEvents: number;
  maxBytes: number;
}

/**
 * Asked before the journal evicts entries past its caps. Returning larger
 * caps raises them in place (no eviction needed while under the new caps);
 * returning `undefined` — or throwing — falls through to eviction. The
 * engine may ask several times per breach while walking toward a grant
 * that retains more; a refusal throttles later asks.
 */
export type JournalGrowthAdvisor = (
  current: JournalLimits,
) => JournalLimits | undefined;

export interface TurnBoundaryCompactionEngineOptions {
  maxReplayBytes?: number;
  onReplayWindowEviction?: (eviction: ReplayWindowEviction) => void;
  /**
   * Caps on the in-flight live journal (DAEMON-009). Compatible consecutive
   * text/thought chunks are grouped into bounded replay events; other events
   * retain their original boundaries. When either cap is hit the oldest
   * journal entries are dropped whole (merged segments included), so the
   * retained tail can be much smaller than the byte cap, and `snapshot()`
   * prepends a `history_truncated` marker
   * (`reason: 'replay_window_exceeded'`, `scope: 'live_journal'`). Turn
   * compaction is unaffected: it folds from the `slots` working set, not
   * the journal. The caps are shared by the session's `full` and
   * `summary` journals, so one in-flight turn can retain up to twice the
   * cap across both journals (see JOURNAL_GROWTH_HARD_CAP_BYTES).
   */
  maxJournalEvents?: number;
  maxJournalBytes?: number;
  /**
   * Adaptive growth hook: consulted before evicting when a turn outgrows
   * the caps above. Absent → behavior is exactly the fixed-cap eviction.
   */
  onJournalGrowth?: JournalGrowthAdvisor;
  /**
   * Test seam for the growth-refusal throttle. Must be a monotonic
   * millisecond clock; defaults to `performance.now()`, so a backward
   * wall-clock correction cannot stretch a throttle window.
   */
  now?: () => number;
}

/**
 * After a growth refusal, don't ask again until this much later — a turn
 * that keeps overflowing would otherwise call the advisor on every append.
 * A grant resets the throttle (doubling means at most ~log2(hard cap /
 * baseline) asks per session).
 */
const JOURNAL_GROWTH_REASK_INTERVAL_MS = 10_000;

/**
 * Step budget for walking reachable grants on one breach. A well-behaved
 * policy doubles toward the hard cap (~log2 steps) and refuses once the
 * pool is empty; the budget only guards a misbehaving advisor granting
 * unbounded non-improving increments.
 */
const JOURNAL_GROWTH_MAX_GRANTS_PER_BREACH = 64;

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
  // Mutable: adaptive growth (see `maybeGrowJournalLimits`) raises these
  // in place when the advisor grants headroom.
  private maxJournalEvents: number;
  private maxJournalBytes: number;
  private readonly onJournalGrowth: JournalGrowthAdvisor | undefined;
  private readonly now: () => number;
  private journalGrowthDeniedAt: number | undefined;
  private readonly onReplayWindowEviction:
    | ((eviction: ReplayWindowEviction) => void)
    | undefined;
  private replaySegments: ReplaySegment[] = [];
  private replaySegmentStart = 0;
  private replayBytes = 0;
  private fullJournal = createLiveJournalState();
  private summaryJournal = createLiveJournalState();
  private lastEventId = 0;
  private closed = false;
  private truncatedEvents = 0;
  private truncatedTurns = 0;
  // Most recent `qwen.session.recordId` observed on an ingested or seeded
  // `session_update`. Surfaced on the `history_truncated` marker emitted by
  // `snapshot()` so clients that lost every turn-boundary event from their
  // retained window (e.g. a live-journal truncation during a single long
  // in-flight turn) still have an anchor for `beforeRecordId` transcript
  // pagination. Undefined until at least one recordId has been observed;
  // omitted from the marker in that case.
  private activeRecordId: string | undefined;
  private summaryRecordId: string | undefined;
  // Pagination anchor for the replay-path `history_truncated` marker,
  // frozen at the first replay-window eviction. Prefers the first
  // retained recordId (the eviction boundary, so `beforeRecordId`
  // fetches exactly the dropped records with no overlap); falls back to
  // the last dropped recordId when the retained window carries no
  // recordId. Deliberately NOT `activeRecordId` — that one is advanced
  // by `ingest()` on every turn boundary and, when a retained segment
  // carries the last seed recordId, would place the anchor inside the
  // retained window and re-fetch records the client already displays.
  private replayAnchorRecordId: string | undefined;

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
    this.maxJournalEvents = normalizeMaxJournalEvents(opts.maxJournalEvents);
    this.maxJournalBytes = normalizeMaxJournalBytes(opts.maxJournalBytes);
    this.onJournalGrowth = opts.onJournalGrowth;
    this.now = opts.now ?? (() => performance.now());
    this.onReplayWindowEviction = opts.onReplayWindowEviction;
  }

  /** Current journal caps — may have grown past the configured baseline. */
  journalLimits(): JournalLimits {
    return { maxEvents: this.maxJournalEvents, maxBytes: this.maxJournalBytes };
  }

  ingest(event: BridgeEvent, byteLength?: number): void {
    if (this.closed) return;
    if (event.id !== undefined) {
      this.lastEventId = event.id;
    }

    if (TRANSIENT_TYPES.has(event.type)) return;

    // Track the latest recordId seen on any session_update so a later
    // `snapshot()` can surface it on a `history_truncated` marker as a
    // pagination anchor. Runs for every non-transient event — recordIds
    // are sparse (only stamped on session_updates at turn boundaries),
    // so `replayRecordId` returning undefined is the common case and
    // intentionally leaves `activeRecordId` untouched.
    const summaryEvent = isSummaryLiveJournalEvent(event);
    const seenRecordId = replayRecordId(event);
    if (seenRecordId !== undefined) {
      this.activeRecordId = seenRecordId;
      if (summaryEvent) this.summaryRecordId = seenRecordId;
    }

    this.appendLiveJournal(this.fullJournal, event, byteLength);
    if (summaryEvent) {
      this.appendLiveJournal(this.summaryJournal, event, byteLength);
    }

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

  snapshot(liveReplayMode: LiveReplayMode = 'full'): SessionReplaySnapshot {
    const compactedTurns = this.flattenReplaySegments();
    if (this.truncatedEvents > 0) {
      compactedTurns.unshift(
        this.makeHistoryTruncatedEvent(compactedTurns.length),
      );
    }
    return {
      compactedTurns,
      liveJournal: this.liveJournalSnapshot(liveReplayMode),
      lastEventId: this.lastEventId,
    };
  }

  /**
   * Snapshot of only the in-flight live journal — the events ingested
   * since the last turn boundary (a boundary folds its turn into the
   * replay window and resets the journal). Cheaper than `snapshot()`:
   * no replay-window flatten.
   */
  liveJournalSnapshot(liveReplayMode: LiveReplayMode = 'full'): BridgeEvent[] {
    const journal =
      liveReplayMode === 'summary' ? this.summaryJournal : this.fullJournal;
    const journalRecordId =
      liveReplayMode === 'summary' ? this.summaryRecordId : this.activeRecordId;
    const liveJournal = journal.entries.map((entry) =>
      isLiveJournalTextSegment(entry)
        ? mergeLiveJournalTextEvent(
            entry.firstEvent,
            entry.lastEvent,
            entry.chunks,
          )
        : entry,
    );
    if (journal.truncatedEvents > 0) {
      // Same wire shape as the compacted-window marker: the SDK's
      // normalizer and type guard both REQUIRE
      // `reason === 'replay_window_exceeded'` (anything else degrades the
      // frame to an unknown/debug event), so the journal marker reuses it
      // and carries `scope: 'live_journal'` as the discriminator — extra
      // fields pass both validators untouched.
      liveJournal.unshift({
        v: EVENT_SCHEMA_VERSION,
        type: 'history_truncated',
        data: {
          reason: 'replay_window_exceeded',
          scope: 'live_journal',
          truncatedEvents: journal.truncatedEvents,
          retainedEvents: journal.totalEvents,
          maxBytes: this.maxJournalBytes,
          maxEvents: this.maxJournalEvents,
          // Pagination anchor — see makeHistoryTruncatedEvent.
          ...(journalRecordId !== undefined
            ? { recordId: journalRecordId }
            : {}),
          fullTranscriptAvailable: true,
        },
      });
    }
    return liveJournal;
  }

  seed(snapshot: { compactedTurns: BridgeEvent[]; lastEventId: number }): void {
    if (this.closed) return;
    this.resetReplayWindow();
    this.lastEventId = snapshot.lastEventId;
    // Drop any previously-observed recordId anchor: the seeded compacted
    // turns are a fresh replay basis and the prior anchor refers to a
    // now-stale position. `activeRecordId` will be rebuilt from any
    // `session_update` recordIds encountered on subsequent `ingest()` calls.
    this.activeRecordId = undefined;
    this.summaryRecordId = undefined;
    // Pre-scan seeded compactedTurns for the last recordId (mirrors
    // seedReplayEvents) so eviction by addReplaySegment doesn't lose it.
    this.activeRecordId = lastRecordIdIn(snapshot.compactedTurns);
    this.summaryRecordId = lastSummaryRecordIdIn(snapshot.compactedTurns);
    for (const event of snapshot.compactedTurns) {
      if (TRANSIENT_TYPES.has(event.type)) continue;
      this.addReplaySegment([event], 0);
    }
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }

  seedReplayEvents(events: BridgeEvent[]): void {
    if (this.closed) return;
    this.resetReplayWindow();
    this.activeRecordId = undefined;
    this.summaryRecordId = undefined;
    // Pre-scan for the last recordId BEFORE segments are added (and
    // possibly evicted) so a subsequent `snapshot()` can still stamp it
    // on a `history_truncated` marker as a pagination anchor. Without
    // this, a seed whose head is evicted by the replay-byte cap would
    // lose its only recordId-bearing events and the marker would ship
    // with no anchor, breaking transcript pagination on reconnect.
    this.activeRecordId = lastRecordIdIn(events);
    this.summaryRecordId = lastSummaryRecordIdIn(events);
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
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetReplayWindow();
    this.resetJournal();
    this.activeRecordId = undefined;
    this.summaryRecordId = undefined;
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }

  private appendLiveJournal(
    journal: LiveJournalState,
    event: BridgeEvent,
    byteLength?: number,
  ): void {
    const bytes = byteLength ?? serializedBridgeEventByteLength(event) ?? 0;
    const textChunk = liveJournalTextChunk(event);
    const current = journal.textSegment;
    const currentIndex = journal.entries.length - 1;
    if (
      textChunk &&
      current &&
      journal.entries[currentIndex] === current &&
      current.chunks.length < LIVE_JOURNAL_TEXT_CHUNKS_PER_EVENT &&
      journal.entryBytes[currentIndex]! + bytes <= this.maxJournalBytes &&
      current.sessionUpdate === textChunk.sessionUpdate &&
      current.parentToolCallId === textChunk.parentToolCallId &&
      stringArraysEqual(current.sourceRecordIds, textChunk.sourceRecordIds) &&
      current.promptId === event.promptId &&
      current.originatorClientId === event.originatorClientId &&
      current.sessionId === captureSessionId(event) &&
      hasOnlyTimestampEnvelopeMeta(current.lastEvent._meta) &&
      hasOnlyTimestampEnvelopeMeta(event._meta)
    ) {
      current.chunks.push(textChunk.text);
      current.lastEvent = event;
      journal.entryBytes[currentIndex]! += bytes;
      journal.entryEvents[currentIndex]! += 1;
      journal.totalBytes += bytes;
      journal.totalEvents += 1;
    } else {
      let entry: BridgeEvent | LiveJournalTextSegment = event;
      if (textChunk) {
        const segment: LiveJournalTextSegment = {
          sessionUpdate: textChunk.sessionUpdate,
          chunks: [textChunk.text],
          sourceRecordIds: textChunk.sourceRecordIds,
          parentToolCallId: textChunk.parentToolCallId,
          promptId: event.promptId,
          originatorClientId: event.originatorClientId,
          sessionId: captureSessionId(event),
          firstEvent: event,
          lastEvent: event,
        };
        entry = segment;
        journal.textSegment = segment;
      } else {
        journal.textSegment = undefined;
      }
      journal.entries.push(entry);
      journal.entryBytes.push(bytes);
      journal.entryEvents.push(1);
      journal.totalBytes += bytes;
      journal.totalEvents += 1;
    }

    // Mirror the eviction condition exactly: at a single entry the byte
    // loop below keeps the last entry, so a grant there would charge the
    // shared pool while buying zero eviction. Skip boundary appends for
    // the same reason: compactCurrentTurn() discards the journal right
    // after this call, so a grant would be charged for nothing.
    if (
      !TURN_BOUNDARY_TYPES.has(event.type) &&
      (journal.entries.length > this.maxJournalEvents ||
        (journal.totalBytes > this.maxJournalBytes &&
          journal.entries.length > 1))
    ) {
      this.maybeGrowJournalLimits(journal);
    }

    while (
      journal.entries.length > this.maxJournalEvents ||
      (journal.totalBytes > this.maxJournalBytes && journal.entries.length > 1)
    ) {
      const dropped = journal.entries.shift();
      journal.totalBytes -= journal.entryBytes.shift() ?? 0;
      const droppedEvents = journal.entryEvents.shift() ?? 0;
      journal.totalEvents -= droppedEvents;
      journal.truncatedEvents += droppedEvents;
      if (dropped === journal.textSegment) {
        journal.textSegment = undefined;
      }
    }
  }

  /**
   * Consults the growth advisor once the journal breaches its caps and
   * applies a grant in place, so the eviction loop below only drops what
   * still exceeds the (possibly raised) caps. An intermediate grant that
   * does not yet retain an extra entry is still applied tentatively —
   * each applied cap is what the next ask reports and is charged for —
   * and the walk continues until a grant retains strictly more than the
   * pre-breach caps, the advisor refuses, or the step budget runs out. A
   * walk that never improves retention rolls back to the original caps
   * and counts as a refusal, so the pool is never charged for growth that
   * preserves no replay. Never throws: a misbehaving advisor degrades to
   * plain eviction, matching the engine's best-effort contract.
   */
  private maybeGrowJournalLimits(journal: LiveJournalState): void {
    const advisor = this.onJournalGrowth;
    if (!advisor || this.closed) return;
    const now = this.now();
    if (this.journalGrowthDeniedAt !== undefined) {
      const sinceDenialMs = now - this.journalGrowthDeniedAt;
      // A negative reading means the injected clock jumped backward; treat
      // the window as elapsed rather than refusing asks until the old
      // wall-clock time is reached again.
      if (
        sinceDenialMs >= 0 &&
        sinceDenialMs < JOURNAL_GROWTH_REASK_INTERVAL_MS
      ) {
        return;
      }
    }
    const originalEvents = this.maxJournalEvents;
    const originalBytes = this.maxJournalBytes;
    const originalRetained = this.retainedTailCount(
      journal,
      originalEvents,
      originalBytes,
    );
    for (let step = 0; step < JOURNAL_GROWTH_MAX_GRANTS_PER_BREACH; step++) {
      let grant: JournalLimits | undefined;
      try {
        grant = advisor({
          maxEvents: this.maxJournalEvents,
          maxBytes: this.maxJournalBytes,
        });
      } catch {
        grant = undefined;
      }
      if (
        !grant ||
        !Number.isSafeInteger(grant.maxBytes) ||
        !Number.isSafeInteger(grant.maxEvents) ||
        grant.maxBytes <= this.maxJournalBytes ||
        grant.maxEvents < this.maxJournalEvents
      ) {
        break;
      }
      this.maxJournalBytes = grant.maxBytes;
      this.maxJournalEvents = grant.maxEvents;
      if (
        this.retainedTailCount(journal, grant.maxEvents, grant.maxBytes) >
        originalRetained
      ) {
        this.journalGrowthDeniedAt = undefined;
        return;
      }
    }
    this.maxJournalEvents = originalEvents;
    this.maxJournalBytes = originalBytes;
    this.journalGrowthDeniedAt = now;
  }

  /** Entries of the newest-first tail the eviction loop would retain. */
  private retainedTailCount(
    journal: LiveJournalState,
    maxEvents: number,
    maxBytes: number,
  ): number {
    let count = 0;
    let bytes = 0;
    for (let i = journal.entries.length - 1; i >= 0; i--) {
      const entryBytes = journal.entryBytes[i] ?? 0;
      if (count + 1 > maxEvents) break;
      // Mirror the eviction loop: a single entry is always kept, even one
      // that alone exceeds the byte cap.
      if (count >= 1 && bytes + entryBytes > maxBytes) break;
      count += 1;
      bytes += entryBytes;
    }
    return count;
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
        if (hasDiscreteMessageMeta(data?.update?._meta)) {
          this.slots.push({ kind: 'misc', event });
          break;
        }
        this.mergeTextSlot('text', event, data);
        break;
      }
      case 'agent_thought_chunk': {
        if (hasDiscreteMessageMeta(data?.update?._meta)) {
          this.slots.push({ kind: 'misc', event });
          break;
        }
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
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }

  private recordLastEventId(event: BridgeEvent): void {
    if (event.id !== undefined) {
      this.lastEventId = event.id;
    }
  }

  private resetJournal(): void {
    this.fullJournal = createLiveJournalState();
    this.summaryJournal = createLiveJournalState();
    // Grown caps intentionally persist across turn boundaries — they are
    // session ceilings, not per-turn state. A refusal, however, belonged
    // to the finished turn's pressure; a new turn gets a fresh ask.
    this.journalGrowthDeniedAt = undefined;
  }

  private addReplaySegment(events: BridgeEvent[], turnCount: number): void {
    if (events.length === 0) return;
    const bytes = events.reduce(
      // Live events passed the publish-time serializability gate, but the
      // seed paths (persisted transcripts) bypass it — log a diagnostic
      // and count 0 so a single unserializable record can't wedge the
      // replay-window accounting.
      (sum, event) => {
        const size = serializedBridgeEventByteLength(event);
        if (size === undefined) {
          logEventSizingFailed(event.type);
          return sum;
        }
        return sum + size;
      },
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
    let lastDroppedRecordId: string | undefined;

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
      const droppedRecordId = lastRecordIdIn(dropped.events);
      if (droppedRecordId !== undefined) {
        lastDroppedRecordId = droppedRecordId;
      }
    }

    if (droppedSegmentCount > 0) {
      // Freeze the pagination anchor at the first eviction so later
      // ingests don't move it. Prefer the FIRST retained recordId — the
      // eviction boundary itself — so `beforeRecordId` fetches exactly
      // the dropped records with no overlap against the retained window.
      // Only when the retained window carries no recordId at all (the
      // live-journal-overflow fallback this anchor exists for) fall back
      // to the last dropped recordId, which still reaches the older
      // history without touching the recordId-less retained window.
      // Using the pre-scanned `activeRecordId` (last recordId across ALL
      // seed events) here was wrong: when a retained segment carried it,
      // the anchor sat inside the retained window and `beforeRecordId`
      // re-fetched records the client already displays, duplicating
      // transcript blocks (prepend has no dedup).
      this.replayAnchorRecordId ??=
        this.firstRetainedReplayRecordId() ?? lastDroppedRecordId;
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

  private firstRetainedReplayRecordId(): string | undefined {
    for (let i = this.replaySegmentStart; i < this.replaySegments.length; i++) {
      const recordId = lastRecordIdIn(this.replaySegments[i]!.events);
      if (recordId !== undefined) return recordId;
    }
    return undefined;
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
        // Pagination anchor for clients whose retained window lost every
        // turn-boundary event (e.g. live-journal truncation during one
        // long in-flight turn). Uses the eviction-time anchor, not
        // `activeRecordId`, so a post-seed `ingest()` can't push it past
        // records the client already displays. Undefined when no recordId
        // was observed before the first eviction — the field is
        // intentionally omitted in that case so old clients continue to
        // validate the marker shape.
        ...(this.replayAnchorRecordId !== undefined
          ? { recordId: this.replayAnchorRecordId }
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
    this.replayAnchorRecordId = undefined;
  }

  private clearTextSlotIndex(): void {
    this.textSlotIndex.text.clear();
    this.textSlotIndex.thought.clear();
  }
}

function isLiveJournalTextSegment(
  entry: BridgeEvent | LiveJournalTextSegment,
): entry is LiveJournalTextSegment {
  return 'firstEvent' in entry;
}

function liveJournalTextChunk(event: BridgeEvent):
  | {
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
      text: string;
      sourceRecordIds?: readonly string[];
      parentToolCallId?: string;
    }
  | undefined {
  if (event.type !== 'session_update') return undefined;
  const data = event.data as SessionUpdateData | undefined;
  const sessionUpdate = data?.update?.sessionUpdate;
  if (
    sessionUpdate !== 'agent_message_chunk' &&
    sessionUpdate !== 'agent_thought_chunk'
  ) {
    return undefined;
  }
  if (!hasOnlyModeledChunkKeys(data)) {
    return undefined;
  }
  if (
    hasDiscreteMessageMeta(data?.update?._meta) ||
    hasUnmodeledTextMeta(data?.update?._meta)
  ) {
    return undefined;
  }
  const content = data?.update?.content;
  if (content?.type !== 'text' || typeof content.text !== 'string') {
    return undefined;
  }
  return {
    sessionUpdate,
    text: content.text,
    sourceRecordIds: extractSourceRecordIdsFromMeta(data?.update?._meta),
    parentToolCallId: extractParentToolCallIdFromMeta(data?.update?._meta),
  };
}

// `mergeLiveJournalTextEvent` rebuilds a merged entry by spread-merging
// the segment's first and last source events, so only chunks whose data,
// update, and content carry exactly the modeled keys can join a segment —
// extra data/update keys would leak into the merged aggregate, and extra
// content keys (ACP TextContent `annotations` / `_meta`) would be dropped
// by the `{ type, text }` content rebuild, so such chunks stay raw entries.
function hasOnlyModeledChunkKeys(data: SessionUpdateData | undefined): boolean {
  if (!data || !data.update) return false;
  const content: unknown = data.update.content;
  return (
    Object.keys(data).every((key) => key === 'sessionId' || key === 'update') &&
    Object.keys(data.update).every(
      (key) => key === 'sessionUpdate' || key === 'content' || key === '_meta',
    ) &&
    (content === undefined ||
      (typeof content === 'object' &&
        content !== null &&
        Object.keys(content).every((key) => key === 'type' || key === 'text')))
  );
}

function mergeLiveJournalTextEvent(
  existing: BridgeEvent,
  incoming: BridgeEvent,
  chunks: readonly string[],
): BridgeEvent {
  const existingData = existing.data as SessionUpdateData;
  const incomingData = incoming.data as SessionUpdateData;
  return {
    ...existing,
    ...incoming,
    data: {
      ...existingData,
      ...incomingData,
      update: {
        ...existingData.update,
        ...incomingData.update,
        content: { type: 'text', text: chunks.join('') },
      },
    },
  };
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

function isSummaryLiveJournalEvent(event: BridgeEvent): boolean {
  if (event.type !== 'session_update') return true;
  const data = event.data as SessionUpdateData | undefined;
  const meta = data?.update?._meta;
  const parentToolCallId = extractParentToolCallIdFromMeta(meta);
  if (parentToolCallId === undefined) return true;
  // Mirror the UI normalizer's self-reference guard
  // (normalizeToolUpdate drops parentToolCallId === toolCallId): such a
  // frame renders as a ROOT tool block in the main transcript, so the
  // summary journal must retain it too or a refresh drops a block the
  // user was just looking at.
  if (parentToolCallId === data?.update?.toolCallId) return true;
  if (data?.update?.sessionUpdate !== 'agent_message_chunk') return false;
  if (typeof meta !== 'object' || meta === null) return false;
  const usage = (meta as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null) return false;
  const fields = usage as Record<string, unknown>;
  return (
    typeof fields['inputTokens'] === 'number' ||
    typeof fields['outputTokens'] === 'number'
  );
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

function hasDiscreteMessageMeta(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as Record<string, unknown>)['qwenDiscreteMessage'] === true
  );
}

function hasOnlyTimestampEnvelopeMeta(meta: unknown): boolean {
  if (meta === undefined) return true;
  if (typeof meta !== 'object' || meta === null) return false;
  return Object.keys(meta).every(
    (key) => key === 'timestamp' || key === 'serverTimestamp',
  );
}

function hasUnmodeledTextMeta(meta: unknown): boolean {
  if (meta === undefined) return false;
  if (typeof meta !== 'object' || meta === null) return true;
  const record = meta as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'timestamp' || key === 'serverTimestamp') {
      continue;
    }
    if (key === 'parentToolCallId') {
      // Empty strings model "no parent": extractParentToolCallIdFromMeta
      // ignores them, so both replay surfaces agree the chunk is top-level.
      if (typeof value !== 'string') return true;
      continue;
    }
    if (key === 'subagentType') {
      // Display label SubAgentTracker pairs with parentToolCallId. The
      // completed-turn path merges by parentToolCallId alone and lets the
      // latest meta carry the label, so the live view must match instead
      // of splitting on it.
      if (typeof value !== 'string') return true;
      continue;
    }
    if (key === 'qwenTranscript') {
      if (typeof value !== 'object' || value === null) return true;
      const transcript = value as Record<string, unknown>;
      for (const [field, fieldValue] of Object.entries(transcript)) {
        if (field === 'sourceRecordIds') {
          if (
            !Array.isArray(fieldValue) ||
            fieldValue.some((id) => typeof id !== 'string')
          ) {
            return true;
          }
          continue;
        }
        if (field === 'planToolCallId') {
          if (typeof fieldValue !== 'string') return true;
          continue;
        }
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
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
