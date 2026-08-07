/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import { parseGoalStateRecordPayloadV2 } from '../goals/goal-reducer.js';
import type { GoalSnapshotV2 } from '../goals/goal-protocol.js';
import type { ChatRecord } from './chatRecordingService.js';
import {
  aggregateTranscriptRecordFragments,
  isTranscriptConversationRecord,
  type TranscriptRecordInput,
  validateTranscriptRecord,
  walkTranscriptUuidChain,
} from '../utils/transcript-records.js';

export const SESSION_TRANSCRIPT_DEFAULT_LIMIT = 100;
export const SESSION_TRANSCRIPT_MAX_LIMIT = 500;
export const SESSION_TRANSCRIPT_CURSOR_VERSION = 1 as const;
export const SESSION_TRANSCRIPT_MAX_INDEX_BYTES = 256 * 1024 * 1024;
export const SESSION_TRANSCRIPT_MAX_PAGE_BYTES = 4 * 1024 * 1024;
// Hard source-byte ceiling for one backward page, counting everything the
// turn-alignment and pair extensions add above the soft `maxBytes`
// selection budget. It is a backstop, not the only bound: each expansion is
// also capped at a bounded multiple of the caller's `maxBytes`. The
// workspace route caps serialized responses at twice this value, leaving
// headroom for the envelope; a single aggregated record can still exceed
// both caps (the always-take-one-record rule admits it so pagination
// cannot dead-end), in which case that anchor reports
// transcript_page_too_large.
export const SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES = 16 * 1024 * 1024;

export class InvalidSessionTranscriptCursorError extends Error {
  constructor(message = 'Invalid transcript cursor') {
    super(message);
    this.name = 'InvalidSessionTranscriptCursorError';
  }
}

export class SessionTranscriptSnapshotUnavailableError extends Error {
  constructor(sessionId: string) {
    super(`Transcript snapshot is unavailable for session ${sessionId}`);
    this.name = 'SessionTranscriptSnapshotUnavailableError';
  }
}

export class SessionTranscriptTooLargeError extends Error {
  constructor(
    readonly sessionId: string,
    readonly snapshotSize: number,
    readonly maxBytes: number,
  ) {
    super(
      `Transcript snapshot for session ${sessionId} is too large to index (${snapshotSize} bytes, max ${maxBytes} bytes)`,
    );
    this.name = 'SessionTranscriptTooLargeError';
  }
}

export class SessionTranscriptPageTooLargeError extends Error {
  constructor(
    readonly sessionId: string,
    readonly pageBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Transcript page for session ${sessionId} exceeds the page budget (${pageBytes} bytes, max ${maxBytes} bytes)`,
    );
    this.name = 'SessionTranscriptPageTooLargeError';
  }
}

export interface SessionTranscriptCursorState {
  v: typeof SESSION_TRANSCRIPT_CURSOR_VERSION;
  sessionId: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  position: number;
  /** Omitted for legacy oldest-to-newest cursors. */
  direction?: 'backward';
  leafUuid: string;
  startTime: string;
  lastUpdated: string;
  replay?: unknown;
}

export interface SessionTranscriptReadPageOptions {
  cursor?: string;
  /** Start a newest-to-oldest snapshot immediately before this active record. */
  beforeRecordId?: string;
  /** Start at the persisted tail and page newest-to-oldest. */
  direction?: 'backward';
  limit?: number;
  maxBytes?: number;
}

export interface SessionTranscriptRecordPage {
  sessionId: string;
  filePath: string;
  records: ChatRecord[];
  gaps: HistoryGap[];
  hasMore: boolean;
  direction?: 'backward';
  nextCursorState?: SessionTranscriptCursorState;
  replay?: unknown;
  startTime: string;
  lastUpdated: string;
}

interface SessionTranscriptFileIdentity {
  dev: number;
  ino: number;
}

interface RecordSegment {
  offset: number;
  length: number;
  sequence: number;
  fragmentIndex: number;
}

interface UuidIndexEntry {
  parentUuid: string | null;
  type: ChatRecord['type'];
  subtype?: TranscriptRecordInput['subtype'];
  inherited: boolean;
  segments: RecordSegment[];
}

interface TranscriptIndex {
  filePath: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  leafUuid: string;
  activeUuids: string[];
  goalStatePositions: number[];
  gaps: HistoryGap[];
  startTime: string;
  lastUpdated: string;
  byUuid: Map<string, UuidIndexEntry>;
}

interface CacheEntry {
  expiresAt: number;
  byteSize?: number;
  value?: TranscriptIndex;
  pending?: Promise<TranscriptIndex>;
}

const INDEX_CACHE_MAX_ENTRIES = 32;
const INDEX_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
const INDEX_ENTRY_BASE_BYTES = 256;
const INDEX_SEGMENT_BYTES = 64;
const INDEX_STRING_BYTES = 2;
const READ_CHUNK_SIZE = 64 * 1024;
const CURSOR_HMAC_KEY_BYTES = 32;
const CURSOR_HMAC_KEY_FILENAME = 'session-transcript-cursor-key';
const SESSION_TRANSCRIPT_SESSION_ID_PATTERN = /^[0-9a-fA-F-]{32,36}$/;

const debugLogger = createDebugLogger('SESSION_TRANSCRIPT');

const indexCache = new Map<string, CacheEntry>();
// Per-workspace HMAC signing keys are cached for the daemon's lifetime (keyed by
// key-file path). Rotating a key file externally therefore requires a daemon
// restart to take effect — the only in-process invalidation is the corrupt
// (wrong-length) key replacement in readCursorHmacKey. This is acceptable: the
// key protects cursor integrity across workspaces, not against a local adversary
// who can already read the key file next to the transcripts it signs.
const cursorHmacKeys = new Map<string, Buffer>();
let indexCacheMaxBytesForTest: number | undefined;
let expandedPageBytesForTest: number | undefined;

function getExpandedPageBytes(): number {
  return expandedPageBytesForTest ?? SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES;
}

function makeSessionTranscriptNotFoundError(
  sessionId: string,
): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${sessionId}.jsonl'`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = 'open';
  return error;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Windows derives `Stats.ino` from a 64-bit file index that routinely exceeds
// 2^53, so a safe-integer check would reject every cursor there. Above 2^53 the
// value loses precision, so file identity on Windows is approximate; a bigint
// stat would be the durable fix. Byte offsets (snapshotSize/position) are still
// arithmetic operands and stay safe-integer via isFiniteNonNegativeInteger.
function isFiniteNonNegativeFileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function cursorPayload(
  state: SessionTranscriptCursorState,
): Record<string, unknown> {
  return {
    v: state.v,
    sessionId: state.sessionId,
    fileIdentity: {
      dev: state.fileIdentity.dev,
      ino: state.fileIdentity.ino,
    },
    snapshotSize: state.snapshotSize,
    position: state.position,
    ...(state.direction === 'backward' ? { direction: 'backward' } : {}),
    leafUuid: state.leafUuid,
    startTime: state.startTime,
    lastUpdated: state.lastUpdated,
    ...(state.replay !== undefined ? { replay: state.replay } : {}),
  };
}

function getCursorHmacKeyPath(workspaceCwd: string): string {
  // This key binds cursors to one workspace and prevents remote cursor
  // tampering or cross-workspace replay. It is not intended to protect against
  // a local user who can already read the project directory and transcripts.
  return path.join(
    new Storage(workspaceCwd).getProjectDir(),
    CURSOR_HMAC_KEY_FILENAME,
  );
}

function readCursorHmacKey(keyPath: string): Buffer | undefined {
  try {
    const key = Buffer.from(
      fs.readFileSync(keyPath, 'utf8').trim(),
      'base64url',
    );
    if (key.length === CURSOR_HMAC_KEY_BYTES) {
      return key;
    }
    debugLogger.warn(
      `invalid cursor signing key at ${keyPath}; replacing persisted key`,
    );
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function writeCursorHmacKey(keyPath: string, key: Buffer): Buffer {
  const encoded = `${key.toString('base64url')}\n`;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encoded, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readCursorHmacKey(keyPath);
      if (existing) {
        return existing;
      }
      fs.writeFileSync(keyPath, encoded, { encoding: 'utf8', mode: 0o600 });
    } else {
      throw error;
    }
  }
  return key;
}

function getCursorHmacKey(workspaceCwd: string): Buffer {
  const keyPath = getCursorHmacKeyPath(workspaceCwd);
  const cached = cursorHmacKeys.get(keyPath);
  if (cached) return cached;
  const key =
    readCursorHmacKey(keyPath) ??
    writeCursorHmacKey(keyPath, crypto.randomBytes(CURSOR_HMAC_KEY_BYTES));
  cursorHmacKeys.set(keyPath, key);
  return key;
}

function signCursorPayloadWithKey(
  payload: Record<string, unknown>,
  key: Uint8Array,
): string {
  return crypto
    .createHmac('sha256', key)
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function hasValidCursorMacWithKey(
  payload: Record<string, unknown>,
  mac: string,
  key: Uint8Array,
): boolean {
  const expected = Buffer.from(signCursorPayloadWithKey(payload, key), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function encodeCursorState(
  state: SessionTranscriptCursorState,
  key: Uint8Array,
): string {
  const payload = cursorPayload(state);
  return Buffer.from(
    JSON.stringify({
      ...payload,
      mac: signCursorPayloadWithKey(payload, key),
    }),
    'utf8',
  ).toString('base64url');
}

function decodeCursorState(
  cursor: string,
  key: Uint8Array,
): SessionTranscriptCursorState {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!isObjectRecord(parsed)) {
      throw new InvalidSessionTranscriptCursorError();
    }
    const fileIdentity = parsed['fileIdentity'];
    if (
      parsed['v'] !== SESSION_TRANSCRIPT_CURSOR_VERSION ||
      typeof parsed['sessionId'] !== 'string' ||
      !isObjectRecord(fileIdentity) ||
      !isFiniteNonNegativeFileId(fileIdentity['dev']) ||
      !isFiniteNonNegativeFileId(fileIdentity['ino']) ||
      !isFiniteNonNegativeInteger(parsed['snapshotSize']) ||
      !isFiniteNonNegativeInteger(parsed['position']) ||
      (parsed['direction'] !== undefined &&
        parsed['direction'] !== 'backward') ||
      typeof parsed['leafUuid'] !== 'string' ||
      typeof parsed['startTime'] !== 'string' ||
      typeof parsed['lastUpdated'] !== 'string' ||
      typeof parsed['mac'] !== 'string'
    ) {
      debugLogger.debug('cursor decode failed: invalid payload shape');
      throw new InvalidSessionTranscriptCursorError();
    }
    const state = {
      v: SESSION_TRANSCRIPT_CURSOR_VERSION,
      sessionId: parsed['sessionId'],
      fileIdentity: {
        dev: fileIdentity['dev'],
        ino: fileIdentity['ino'],
      },
      snapshotSize: parsed['snapshotSize'],
      position: parsed['position'],
      ...(parsed['direction'] === 'backward'
        ? { direction: 'backward' as const }
        : {}),
      leafUuid: parsed['leafUuid'],
      startTime: parsed['startTime'],
      lastUpdated: parsed['lastUpdated'],
      ...(parsed['replay'] !== undefined ? { replay: parsed['replay'] } : {}),
    };
    if (!hasValidCursorMacWithKey(cursorPayload(state), parsed['mac'], key)) {
      debugLogger.debug(
        `cursor decode failed: mac mismatch session=${state.sessionId} ` +
          `position=${state.position} snapshotSize=${state.snapshotSize}`,
      );
      throw new InvalidSessionTranscriptCursorError();
    }
    debugLogger.debug(
      `cursor decoded session=${state.sessionId} position=${state.position} ` +
        `snapshotSize=${state.snapshotSize}`,
    );
    return state;
  } catch (error) {
    if (error instanceof InvalidSessionTranscriptCursorError) {
      throw error;
    }
    debugLogger.debug(
      `cursor decode failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw new InvalidSessionTranscriptCursorError();
  }
}

export class SessionTranscriptCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== CURSOR_HMAC_KEY_BYTES) {
      throw new RangeError(
        `Transcript cursor signing key must be ${CURSOR_HMAC_KEY_BYTES} bytes`,
      );
    }
    this.key = Buffer.from(key);
  }

  encode(state: SessionTranscriptCursorState): string {
    return encodeCursorState(state, this.key);
  }

  decode(cursor: string): SessionTranscriptCursorState {
    return decodeCursorState(cursor, this.key);
  }
}

export function encodeSessionTranscriptCursor(
  state: SessionTranscriptCursorState,
  workspaceCwd: string,
): string {
  return encodeCursorState(state, getCursorHmacKey(workspaceCwd));
}

export function decodeSessionTranscriptCursor(
  cursor: string,
  workspaceCwd: string,
): SessionTranscriptCursorState {
  return decodeCursorState(cursor, getCursorHmacKey(workspaceCwd));
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return SESSION_TRANSCRIPT_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    throw new RangeError(
      `Transcript limit must be an integer from 1 to ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
    );
  }
  return limit;
}

function normalizeMaxBytes(maxBytes: number | undefined): number | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(
      'Transcript page byte limit must be a positive integer',
    );
  }
  return maxBytes;
}

function recordSegmentBytes(index: TranscriptIndex, uuid: string): number {
  const entry = index.byUuid.get(uuid);
  return (
    entry?.segments.reduce((total, segment) => total + segment.length, 0) ?? 0
  );
}

function selectPageUuids(
  index: TranscriptIndex,
  position: number,
  limit: number,
  maxBytes: number | undefined,
): string[] {
  const candidates = index.activeUuids.slice(position, position + limit);
  if (maxBytes === undefined) return candidates;

  const selected: string[] = [];
  let selectedBytes = 0;
  for (const uuid of candidates) {
    const bytes = recordSegmentBytes(index, uuid);
    // A single aggregate record may itself exceed the budget; it cannot be
    // split, so always take at least one record or pagination dead-ends.
    if (selected.length > 0 && selectedBytes + bytes > maxBytes) break;
    selected.push(uuid);
    selectedBytes += bytes;
  }
  return selected;
}

// User-role records the turn loop persists mid-turn. Replay renders them
// as inline messages, not turn boundaries (see projectUserRecord in
// transcript-replay), so turn alignment and page starts must pass over
// them. realtime_message is deliberately absent: a realtime user record is
// a genuine user turn start even though it is not a page start (see
// isReplayPageStart).
const REPLAY_MID_TURN_USER_SUBTYPES: ReadonlySet<string> = new Set([
  'goal_runtime',
  'notification',
  'cron',
  'mid_turn_user_message',
] satisfies ReadonlyArray<NonNullable<ChatRecord['subtype']>>);

export function isReplayTurnStartType(
  type: ChatRecord['type'] | undefined,
  subtype: string | undefined,
): boolean {
  return (
    type === 'user' &&
    (subtype === undefined || !REPLAY_MID_TURN_USER_SUBTYPES.has(subtype))
  );
}

function isReplayTurnStart(index: TranscriptIndex, uuid: string): boolean {
  const entry = index.byUuid.get(uuid);
  return isReplayTurnStartType(entry?.type, entry?.subtype);
}

// A backward page can safely start at a replay turn start or at the
// assistant record owning any following tool results. The turn loop
// persists one assistant record per model response and records each tool
// run's results as one contiguous batch before the next assistant record,
// so the nearest matching assistant below a tool_result run owns it.
// Realtime conversation records are the exception: they interleave at
// wall-clock time and own no tool results, so the walk must pass through
// them instead of splitting the pair.
function isReplayPageStart(index: TranscriptIndex, uuid: string): boolean {
  const entry = index.byUuid.get(uuid);
  return (
    entry?.subtype !== 'realtime_message' &&
    (entry?.type === 'assistant' ||
      isReplayTurnStartType(entry?.type, entry?.subtype))
  );
}

// Walk backward from `from` toward the nearest item matching `isBoundary`,
// never below `floor`. The returned index is a boundary only if one exists
// within the bound; otherwise it is `floor` itself, so callers must re-check
// the result. Shared by the uuid-indexed reader and the record-array
// selectors (ACP bulk replay) so the walk/floor/accept policy lives in one
// place.
export function findBoundaryAtOrBefore<T>(
  items: ArrayLike<T>,
  from: number,
  floor: number,
  isBoundary: (item: T) => boolean,
): number {
  let candidate = from;
  while (candidate > floor && !isBoundary(items[candidate]!)) {
    candidate--;
  }
  return candidate;
}

function findReplayBoundaryAtOrBefore(
  index: TranscriptIndex,
  from: number,
  floor: number,
  isBoundary: (index: TranscriptIndex, uuid: string) => boolean,
): number {
  return findBoundaryAtOrBefore(index.activeUuids, from, floor, (uuid) =>
    isBoundary(index, uuid),
  );
}

function backwardPageBytesFit(
  index: TranscriptIndex,
  start: number,
  end: number,
  budget: number,
): boolean {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += recordSegmentBytes(index, index.activeUuids[i]!);
    if (total > budget) return false;
  }
  return true;
}

// True when the first tool_result in [start, end) lost its owning call
// below `start`, i.e. the selection begins mid-pair. Only the first result
// needs checking: later results belong to calls at or after it, all inside
// the page once the first pair is whole.
function selectionOrphansToolResult(
  index: TranscriptIndex,
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) {
    if (index.byUuid.get(index.activeUuids[i]!)?.type !== 'tool_result') {
      continue;
    }
    for (let owner = i - 1; owner >= start; owner--) {
      if (isReplayPageStart(index, index.activeUuids[owner]!)) return false;
    }
    return true;
  }
  return false;
}

// Selects one backward page. Worst case the page holds 3 * limit records:
// the requested window, one turn-alignment window, and one pair-extension
// window. Each expansion is additionally capped at one extra byte budget —
// a bounded multiple of the soft `maxBytes` budget, clamped to the hard
// page ceiling — so chained pages stay bounded relative to the caller's
// budget instead of jumping straight to the ceiling.
function selectBackwardPageUuids(
  index: TranscriptIndex,
  sessionId: string,
  position: number,
  limit: number,
  maxBytes: number | undefined,
): { uuids: string[]; nextPosition: number } {
  if (position === 0) return { uuids: [], nextPosition: 0 };
  // One extra byte budget per expansion: enough to admit a small
  // over-budget turn or absorb a result batch whole, but bounded relative
  // to the caller's soft budget so chained pages cannot balloon to the
  // absolute ceiling.
  const expansionByteBudget =
    maxBytes === undefined
      ? getExpandedPageBytes()
      : Math.min(2 * maxBytes, getExpandedPageBytes());

  let start = Math.max(0, position - limit);
  for (let i = start; i < position; i++) {
    if (isReplayTurnStart(index, index.activeUuids[i]!)) {
      start = i;
      break;
    }
  }
  // Turn-boundary alignment may expand the page past the requested window,
  // but never without bound: a transcript dominated by a single long turn
  // (e.g. one in-flight prompt with thousands of records) would otherwise
  // turn EVERY backward page into the whole transcript — ignoring `limit`
  // and making anchor-based pagination dead-end at the file head. Allow at
  // most one extra window (`limit` records) of expansion, and only when it
  // reaches a real boundary: otherwise keep the requested window so pages
  // inside a long turn stay `limit` records, not `2 * limit`.
  const expansionFloor = Math.max(0, position - 2 * limit);
  const expandedStart = findReplayBoundaryAtOrBefore(
    index,
    start,
    expansionFloor,
    isReplayTurnStart,
  );
  if (isReplayTurnStart(index, index.activeUuids[expandedStart]!)) {
    start = expandedStart;
  }

  let selectedStart = position;
  let selectedBytes = 0;
  for (let i = position - 1; i >= start; i--) {
    const uuid = index.activeUuids[i]!;
    const bytes = recordSegmentBytes(index, uuid);
    // Always take at least one record so backward pagination cannot
    // dead-end.
    if (
      selectedStart < position &&
      maxBytes !== undefined &&
      selectedBytes + bytes > maxBytes
    ) {
      break;
    }
    selectedStart = i;
    selectedBytes += bytes;
  }

  // Turn-alignment expansion admits a whole turn even when it overshoots
  // the soft `maxBytes` budget, but never past the expansion byte budget:
  // a page the workspace route cannot serialize would fail at its response
  // cap and dead-end backward pagination at this anchor on every retry.
  const logTurnExpansionSkipped = (reason: string): void => {
    debugLogger.debug(
      `backward turn expansion skipped session=${sessionId} ` +
        `start=${index.activeUuids[selectedStart]!} reason=${reason}`,
    );
  };
  let alignedToReplayBoundary = false;
  for (let i = selectedStart; i < position; i++) {
    if (isReplayTurnStart(index, index.activeUuids[i]!)) {
      selectedStart = i;
      alignedToReplayBoundary = true;
      break;
    }
  }
  if (alignedToReplayBoundary && selectedStart > 0) {
    const previousTurnStart = findReplayBoundaryAtOrBefore(
      index,
      selectedStart - 1,
      -1,
      isReplayTurnStart,
    );
    if (previousTurnStart < 0) {
      // No earlier turn start anywhere: the file head is the only boundary
      // below. Absorb the leading prefix only when it lies inside the same
      // record and byte budgets as every other expansion, so a long
      // synthetic prefix cannot balloon the page past the 3 * limit worst
      // case.
      if (
        expansionFloor === 0 &&
        backwardPageBytesFit(index, 0, position, expansionByteBudget)
      ) {
        selectedStart = 0;
      } else {
        logTurnExpansionSkipped(
          expansionFloor === 0 ? 'byte-budget' : 'record-budget',
        );
      }
    }
  } else if (!alignedToReplayBoundary) {
    // Expansion only pays off when it reaches a turn boundary; otherwise
    // keep the limit/maxBytes-respecting selection.
    const candidate = findReplayBoundaryAtOrBefore(
      index,
      selectedStart,
      expansionFloor,
      isReplayTurnStart,
    );
    if (isReplayTurnStart(index, index.activeUuids[candidate]!)) {
      if (
        backwardPageBytesFit(index, candidate, position, expansionByteBudget)
      ) {
        selectedStart = candidate;
      } else {
        logTurnExpansionSkipped('byte-budget');
      }
    }
  }

  // Backward replay finalizes each page independently, so a page boundary
  // between a tool call and its persisted result would render the completed
  // call as failed ("result missing") on the older page and the result as an
  // orphan block on the newer one. When the selection starts mid-pair,
  // extend the page down to the owning assistant record (or turn boundary)
  // so the pair stays on a single page. The extension runs only when a
  // tool_result in the selection actually lost its call: system records and
  // mid-turn user records are not page starts either, but walking further
  // down gains nothing when there is no pair to keep together. The walk is
  // bounded to one window below the selection: one assistant record can own
  // an arbitrarily long contiguous tool_result run (a persisted parallel
  // batch), and an uncapped walk would balloon the page far past `limit` —
  // reintroducing the unbounded growth this function exists to cap. The
  // budget covers only the records the extension adds beyond the owner —
  // the selection above already respected `maxBytes`, and the owner itself
  // is exempt the way the selection loop exempts its forced first record,
  // so a single oversized owner (which the next page would force-take
  // anyway) cannot fail the check by construction and split the pair.
  // Records between the owner and the selection — a result batch — still
  // count against the budget; an extension that would absorb more than the
  // budget keeps the bounded selection, accepting a mid-pair boundary in
  // that edge. The skip is logged so such a report stays diagnosable
  // without re-deriving the budget arithmetic.
  if (
    selectedStart > 0 &&
    selectionOrphansToolResult(index, selectedStart, position)
  ) {
    const pairFloor = Math.max(0, selectedStart - limit);
    const pairStart = findReplayBoundaryAtOrBefore(
      index,
      selectedStart,
      pairFloor,
      isReplayPageStart,
    );
    if (!isReplayPageStart(index, index.activeUuids[pairStart]!)) {
      debugLogger.debug(
        `backward pair extension skipped session=${sessionId} ` +
          `start=${index.activeUuids[selectedStart]!} reason=record-budget`,
      );
    } else if (
      !backwardPageBytesFit(
        index,
        pairStart + 1,
        selectedStart,
        expansionByteBudget,
      )
    ) {
      debugLogger.debug(
        `backward pair extension skipped session=${sessionId} ` +
          `start=${index.activeUuids[selectedStart]!} reason=byte-budget`,
      );
    } else {
      selectedStart = pairStart;
    }
  }

  return {
    uuids: index.activeUuids.slice(selectedStart, position),
    nextPosition: selectedStart,
  };
}

function fileIdentityFromStats(stats: fs.Stats): SessionTranscriptFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

// `ino: 0` (FAT/exFAT, some SMB mounts) is not proof that two stats describe
// the same file, but it is not treated as unverifiable here the way
// `FileReadCache` and the writer lease treat it. Those two compare identities
// that can belong to *different* files — a global `dev:ino` cache key, and an
// open handle against the path it was opened from — so a zero-inode match
// there is a false positive with real consequences.
//
// This reader only ever compares the same session's transcript path against
// itself across time, and the cursor carries a content-derived proof
// (`leafUuid` + `snapshotSize` + `lastUpdated`, all re-checked below) that
// already detects the replacement an inode comparison would catch. Refusing
// zero here bought nothing and broke pagination outright: `readPage` hands
// back a cursor built from the current identity, so on such a filesystem
// every continuation rejected the cursor the reader itself had just issued.
//
// Comparing the raw values still catches a zero/non-zero transition, which
// does mean the file changed.
function sameFileIdentity(
  a: SessionTranscriptFileIdentity,
  b: SessionTranscriptFileIdentity,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function makeCacheKey(
  filePath: string,
  fileIdentity: SessionTranscriptFileIdentity,
  snapshotSize: number,
  lastUpdated: string,
): string {
  // `lastUpdated` (file mtime) is part of the key so an in-place rewrite that
  // preserves the inode AND byte length (e.g. `rsync --inplace`, a redaction
  // pass) still invalidates the cached index instead of serving a stale one
  // whose byte offsets now point at different records.
  return `${filePath}:${fileIdentity.dev}:${fileIdentity.ino}:${snapshotSize}:${lastUpdated}`;
}

function getIndexCacheMaxBytes(): number {
  return indexCacheMaxBytesForTest ?? INDEX_CACHE_MAX_BYTES;
}

function estimateStringBytes(value: string | null | undefined): number {
  return value ? value.length * INDEX_STRING_BYTES : 0;
}

function estimateIndexCacheBytes(index: TranscriptIndex): number {
  let total =
    INDEX_ENTRY_BASE_BYTES +
    estimateStringBytes(index.filePath) +
    estimateStringBytes(index.leafUuid) +
    estimateStringBytes(index.startTime) +
    estimateStringBytes(index.lastUpdated);

  for (const uuid of index.activeUuids) {
    total += estimateStringBytes(uuid);
  }
  total += index.goalStatePositions.length * 8;
  for (const gap of index.gaps) {
    total +=
      INDEX_ENTRY_BASE_BYTES +
      estimateStringBytes(gap.childUuid) +
      estimateStringBytes(gap.missingParentUuid);
  }
  for (const [uuid, entry] of index.byUuid) {
    total +=
      INDEX_ENTRY_BASE_BYTES +
      estimateStringBytes(uuid) +
      estimateStringBytes(entry.parentUuid) +
      entry.segments.length * INDEX_SEGMENT_BYTES;
  }

  return total;
}

function getIndexCacheBytes(): number {
  let total = 0;
  for (const entry of indexCache.values()) {
    total += entry.byteSize ?? 0;
  }
  return total;
}

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of indexCache) {
    if (entry.expiresAt <= now) {
      indexCache.delete(key);
      debugLogger.debug(`index cache expired ${key}`);
    }
  }
  while (indexCache.size > INDEX_CACHE_MAX_ENTRIES) {
    const oldest = indexCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    indexCache.delete(oldest);
    debugLogger.debug(`index cache evicted LRU ${oldest}`);
  }
  while (getIndexCacheBytes() > getIndexCacheMaxBytes()) {
    let evicted = false;
    for (const [key, entry] of indexCache) {
      if (!entry.byteSize) continue;
      indexCache.delete(key);
      debugLogger.debug(`index cache evicted by byte budget ${key}`);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
}

async function forEachLineInSnapshot(
  filePath: string,
  snapshotSize: number,
  onLine: (line: Buffer, offset: number, length: number) => void,
): Promise<void> {
  if (snapshotSize === 0) return;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingOffset = 0;
  let streamOffset = 0;
  const stream = fs.createReadStream(filePath, {
    start: 0,
    end: snapshotSize - 1,
    highWaterMark: READ_CHUNK_SIZE,
  });

  const makePendingLine = (): Buffer =>
    pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLength);

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let lineStart = 0;
    while (lineStart < buffer.length) {
      const lineEnd = buffer.indexOf(0x0a, lineStart);
      if (lineEnd === -1) break;
      const lineOffset =
        pendingLength > 0 ? pendingOffset : streamOffset + lineStart;
      const currentLine = buffer.subarray(lineStart, lineEnd);
      const rawLine =
        pendingLength > 0
          ? Buffer.concat(
              [...pending, currentLine],
              pendingLength + currentLine.length,
            )
          : currentLine;
      const line =
        rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1)
          : rawLine;
      onLine(line, lineOffset, line.length);
      pending = [];
      pendingLength = 0;
      lineStart = lineEnd + 1;
    }

    if (lineStart < buffer.length) {
      if (pendingLength === 0) {
        pendingOffset = streamOffset + lineStart;
      }
      const tail = buffer.subarray(lineStart);
      pending.push(tail);
      pendingLength += tail.length;
    }
    streamOffset += buffer.length;
  }

  if (pendingLength > 0) {
    const rawLine = makePendingLine();
    const line =
      rawLine[rawLine.length - 1] === 0x0d
        ? rawLine.subarray(0, rawLine.length - 1)
        : rawLine;
    onLine(line, pendingOffset, line.length);
  }
}

async function readSegmentRecords(
  handle: fsp.FileHandle,
  filePath: string,
  segment: RecordSegment,
  uuid: string,
): Promise<ChatRecord[]> {
  if (segment.length === 0) return [];
  const buffer = Buffer.alloc(segment.length);
  await handle.read(buffer, 0, segment.length, segment.offset);
  const line = buffer.toString('utf8').trim();
  if (line.length === 0) return [];
  const records = jsonl
    .parseLineTolerant<unknown>(line, filePath)
    .flatMap((value): ChatRecord[] => {
      const record = validateTranscriptRecord(value).record;
      return record && isTranscriptConversationRecord(record)
        ? [record as unknown as ChatRecord]
        : [];
    });
  const anomalySessionId = path.basename(filePath, '.jsonl');
  const record = records[segment.fragmentIndex];
  if (!record) {
    debugLogger.warn(
      `segment read anomaly: no fragment session=${anomalySessionId} ` +
        `uuid=${uuid} offset=${segment.offset} fragment=${segment.fragmentIndex}`,
    );
    // The frozen snapshot changed under us (e.g. an in-place rewrite that kept
    // the inode and byte length): the recorded offset no longer parses to the
    // expected record. Surface it as snapshot-unavailable (→ 409) rather than
    // silently dropping the record and returning a short/empty transcript.
    throw new SessionTranscriptSnapshotUnavailableError(anomalySessionId);
  }
  if (record.uuid !== uuid) {
    debugLogger.warn(
      `segment read anomaly: uuid mismatch session=${anomalySessionId} ` +
        `expected=${uuid} actual=${record.uuid} offset=${segment.offset}`,
    );
    throw new SessionTranscriptSnapshotUnavailableError(anomalySessionId);
  }
  return [record];
}

async function readAggregatedRecords(
  index: TranscriptIndex,
  uuids: string[],
): Promise<ChatRecord[]> {
  const handle = await fsp.open(index.filePath, 'r');
  try {
    const records: ChatRecord[] = [];
    for (const uuid of uuids) {
      const entry = index.byUuid.get(uuid);
      if (!entry) continue;
      const physicalRecords: ChatRecord[] = [];
      for (const segment of entry.segments) {
        physicalRecords.push(
          ...(await readSegmentRecords(handle, index.filePath, segment, uuid)),
        );
      }
      if (physicalRecords.length > 0) {
        records.push(aggregateTranscriptRecordFragments(physicalRecords));
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

async function readGoalStateBeforePosition(
  index: TranscriptIndex,
  position: number,
): Promise<GoalSnapshotV2 | undefined> {
  let low = 0;
  let high = index.goalStatePositions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.goalStatePositions[middle]! < position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const goalStatePosition = index.goalStatePositions[low - 1];
  if (goalStatePosition === undefined) return undefined;
  const uuid = index.activeUuids[goalStatePosition]!;
  const [record] = await readAggregatedRecords(index, [uuid]);
  return parseGoalStateRecordPayloadV2(record?.systemPayload)?.snapshot;
}

async function buildIndex(params: {
  filePath: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  lastUpdated: string;
}): Promise<TranscriptIndex> {
  const { filePath, fileIdentity, snapshotSize, lastUpdated } = params;
  const sessionId = path.basename(filePath, '.jsonl');
  if (snapshotSize > SESSION_TRANSCRIPT_MAX_INDEX_BYTES) {
    debugLogger.warn(
      `index rejected: snapshot too large session=${sessionId} ` +
        `snapshotSize=${snapshotSize} max=${SESSION_TRANSCRIPT_MAX_INDEX_BYTES}`,
    );
    throw new SessionTranscriptTooLargeError(
      sessionId,
      snapshotSize,
      SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    );
  }
  debugLogger.debug(
    `index build start session=${sessionId} snapshotSize=${snapshotSize}`,
  );
  const byUuid = new Map<string, UuidIndexEntry>();
  let sequence = 0;
  let leafUuid: string | undefined;
  let startTime: string | undefined;
  let sideTaskSourceUuid: string | undefined;

  await forEachLineInSnapshot(
    filePath,
    snapshotSize,
    (line, offset, length) => {
      const text = line.toString('utf8').trim();
      if (text.length === 0) return;
      let fragmentIndex = 0;
      for (const value of jsonl.parseLineTolerant<unknown>(text, filePath)) {
        const record = validateTranscriptRecord(value).record;
        if (!record || !isTranscriptConversationRecord(record)) {
          continue;
        }
        if (
          record.type === 'system' &&
          record.subtype === 'session_source' &&
          isObjectRecord(record.systemPayload) &&
          record.systemPayload['sourceType'] === 'side_task'
        ) {
          sideTaskSourceUuid = record.uuid;
        }
        if (record.timestamp) startTime ??= record.timestamp;
        leafUuid = record.uuid;
        const existing = byUuid.get(record.uuid);
        const segment = {
          offset,
          length,
          sequence: sequence++,
          fragmentIndex,
        };
        fragmentIndex++;
        if (existing) {
          existing.segments.push(segment);
        } else {
          byUuid.set(record.uuid, {
            parentUuid: record.parentUuid,
            type: record.type,
            ...(record.subtype !== undefined
              ? { subtype: record.subtype }
              : {}),
            inherited: record.forkedFrom !== undefined,
            segments: [segment],
          });
        }
      }
    },
  );

  if (!leafUuid) {
    debugLogger.warn(
      `index build failed: no transcript records session=${sessionId}`,
    );
    throw new SessionTranscriptSnapshotUnavailableError(sessionId);
  }
  startTime ??= lastUpdated;

  const chain = walkTranscriptUuidChain(leafUuid, (uuid) => {
    const entry = byUuid.get(uuid);
    return entry
      ? {
          uuid,
          parentUuid: entry.parentUuid,
          sessionId,
          timestamp: startTime,
          type: 'system',
        }
      : undefined;
  });
  const sourceBoundary = sideTaskSourceUuid
    ? chain.uuids.indexOf(sideTaskSourceUuid)
    : -1;
  const activeUuids =
    sourceBoundary >= 0
      ? chain.uuids
          .slice(sourceBoundary)
          .filter((uuid) => byUuid.get(uuid)?.inherited !== true)
      : [...chain.uuids];
  const goalStatePositions: number[] = [];
  for (let position = 0; position < activeUuids.length; position++) {
    const uuid = activeUuids[position]!;
    const entry = byUuid.get(uuid);
    if (entry?.type === 'system' && entry.subtype === 'goal_state') {
      goalStatePositions.push(position);
    }
  }
  const gaps: HistoryGap[] = [...chain.gaps];
  if (chain.cycleUuid) {
    debugLogger.debug(
      `active chain terminated: cycle session=${sessionId} uuid=${chain.cycleUuid}`,
    );
  }

  debugLogger.debug(
    `index build complete session=${sessionId} records=${byUuid.size} ` +
      `active=${activeUuids.length} gaps=${gaps.length}`,
  );

  return {
    filePath,
    fileIdentity,
    snapshotSize,
    leafUuid,
    activeUuids,
    goalStatePositions,
    gaps,
    startTime,
    lastUpdated,
    byUuid,
  };
}

async function getCachedIndex(params: {
  filePath: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  lastUpdated: string;
}): Promise<TranscriptIndex> {
  const now = Date.now();
  pruneCache(now);
  const key = makeCacheKey(
    params.filePath,
    params.fileIdentity,
    params.snapshotSize,
    params.lastUpdated,
  );
  const cached = indexCache.get(key);
  if (cached?.value && cached.expiresAt > now) {
    indexCache.delete(key);
    indexCache.set(key, cached);
    debugLogger.debug(`index cache hit ${key}`);
    return cached.value;
  }
  if (cached?.pending && cached.expiresAt > now) {
    debugLogger.debug(`index cache pending hit ${key}`);
    return cached.pending;
  }

  debugLogger.debug(`index cache miss ${key}`);
  const pending = buildIndex(params);
  indexCache.set(key, {
    pending,
    expiresAt: now + INDEX_CACHE_TTL_MS,
  });
  try {
    const value = await pending;
    const byteSize = estimateIndexCacheBytes(value);
    if (byteSize > getIndexCacheMaxBytes()) {
      if (indexCache.get(key)?.pending === pending) {
        indexCache.delete(key);
      }
      debugLogger.debug(
        `index cache skipped oversized entry ${key} byteSize=${byteSize}`,
      );
      return value;
    }
    indexCache.set(key, {
      value,
      byteSize,
      expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
    });
    pruneCache();
    return value;
  } catch (error) {
    indexCache.delete(key);
    debugLogger.debug(
      `index cache build failed ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

export class SessionTranscriptReader {
  private readonly storage: Storage;

  constructor(
    private readonly workspaceCwd: string,
    private readonly cursorCodec?: SessionTranscriptCursorCodec,
  ) {
    this.storage = new Storage(workspaceCwd);
  }

  getSessionFilePath(sessionId: string): string {
    if (!SESSION_TRANSCRIPT_SESSION_ID_PATTERN.test(sessionId)) {
      debugLogger.debug(`invalid session id for transcript read: ${sessionId}`);
      throw makeSessionTranscriptNotFoundError(sessionId);
    }
    return path.join(
      this.storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
  }

  async readPage(
    sessionId: string,
    options: SessionTranscriptReadPageOptions = {},
  ): Promise<SessionTranscriptRecordPage> {
    const limit = normalizeLimit(options.limit);
    const maxBytes = normalizeMaxBytes(options.maxBytes);
    const cursor =
      options.cursor !== undefined
        ? (this.cursorCodec?.decode(options.cursor) ??
          decodeSessionTranscriptCursor(options.cursor, this.workspaceCwd))
        : undefined;
    if (
      cursor &&
      (options.beforeRecordId !== undefined || options.direction !== undefined)
    ) {
      throw new InvalidSessionTranscriptCursorError();
    }
    if (cursor && cursor.sessionId !== sessionId) {
      debugLogger.debug(
        `cursor session mismatch requested=${sessionId} cursor=${cursor.sessionId}`,
      );
      throw new InvalidSessionTranscriptCursorError();
    }

    const filePath = this.getSessionFilePath(sessionId);
    const stats = await fsp.stat(filePath);
    const currentIdentity = fileIdentityFromStats(stats);
    const snapshotSize = cursor?.snapshotSize ?? stats.size;
    const fileIdentity = cursor?.fileIdentity ?? currentIdentity;
    if (
      stats.size < snapshotSize ||
      !sameFileIdentity(currentIdentity, fileIdentity)
    ) {
      debugLogger.warn(
        `snapshot unavailable session=${sessionId} ` +
          `currentSize=${stats.size} cursorSize=${snapshotSize} ` +
          `currentIdentity=${currentIdentity.dev}:${currentIdentity.ino} ` +
          `cursorIdentity=${fileIdentity.dev}:${fileIdentity.ino}`,
      );
      throw new SessionTranscriptSnapshotUnavailableError(sessionId);
    }

    const index = await getCachedIndex({
      filePath,
      fileIdentity,
      snapshotSize,
      lastUpdated: cursor?.lastUpdated ?? new Date(stats.mtimeMs).toISOString(),
    });
    if (cursor && cursor.leafUuid !== index.leafUuid) {
      debugLogger.warn(
        `snapshot unavailable: leaf changed session=${sessionId} ` +
          `cursorLeaf=${cursor.leafUuid} indexLeaf=${index.leafUuid}`,
      );
      throw new SessionTranscriptSnapshotUnavailableError(sessionId);
    }

    const direction =
      cursor?.direction ??
      options.direction ??
      (options.beforeRecordId !== undefined ? 'backward' : 'forward');
    let position =
      cursor?.position ??
      (direction === 'backward' ? index.activeUuids.length : 0);
    if (!cursor && options.beforeRecordId !== undefined) {
      if (options.beforeRecordId.length === 0) {
        throw new InvalidSessionTranscriptCursorError();
      }
      position = index.activeUuids.indexOf(options.beforeRecordId);
      if (position < 0) {
        throw new InvalidSessionTranscriptCursorError();
      }
    }
    if (position > index.activeUuids.length) {
      debugLogger.debug(
        `cursor position out of range session=${sessionId} ` +
          `position=${position} active=${index.activeUuids.length}`,
      );
      throw new InvalidSessionTranscriptCursorError();
    }
    const backwardPage =
      direction === 'backward'
        ? selectBackwardPageUuids(index, sessionId, position, limit, maxBytes)
        : undefined;
    const pageUuids =
      backwardPage?.uuids ?? selectPageUuids(index, position, limit, maxBytes);
    const nextPosition =
      backwardPage?.nextPosition ?? position + pageUuids.length;
    const records = await readAggregatedRecords(index, pageUuids);
    const backwardGoalState =
      direction === 'backward'
        ? await readGoalStateBeforePosition(index, nextPosition)
        : undefined;
    const hasMore =
      direction === 'backward'
        ? nextPosition > 0
        : nextPosition < index.activeUuids.length;
    const nextCursorState: SessionTranscriptCursorState | undefined = hasMore
      ? {
          v: SESSION_TRANSCRIPT_CURSOR_VERSION,
          sessionId,
          fileIdentity,
          snapshotSize,
          position: nextPosition,
          ...(direction === 'backward'
            ? { direction: 'backward' as const }
            : {}),
          leafUuid: index.leafUuid,
          startTime: index.startTime,
          lastUpdated: index.lastUpdated,
        }
      : undefined;

    debugLogger.debug(
      `read page session=${sessionId} position=${position} ` +
        `nextPosition=${nextPosition} records=${records.length} ` +
        `hasMore=${hasMore}`,
    );

    return {
      sessionId,
      filePath,
      records,
      gaps: index.gaps,
      hasMore,
      ...(direction === 'backward' ? { direction: 'backward' as const } : {}),
      ...(nextCursorState ? { nextCursorState } : {}),
      ...(backwardGoalState
        ? { replay: { goalState: backwardGoalState } }
        : cursor?.replay !== undefined
          ? { replay: cursor.replay }
          : {}),
      startTime: index.startTime,
      lastUpdated: index.lastUpdated,
    };
  }
}

export function resetSessionTranscriptIndexCacheForTest(): void {
  indexCache.clear();
  cursorHmacKeys.clear();
  indexCacheMaxBytesForTest = undefined;
  expandedPageBytesForTest = undefined;
}

export function setSessionTranscriptIndexCacheMaxBytesForTest(
  maxBytes: number,
): void {
  indexCacheMaxBytesForTest = maxBytes;
  pruneCache();
}

export function setSessionTranscriptExpandedPageBytesForTest(
  maxBytes: number,
): void {
  expandedPageBytesForTest = maxBytes;
}

export function getSessionTranscriptIndexCacheStatsForTest(): {
  entries: number;
  byteSize: number;
} {
  return {
    entries: indexCache.size,
    byteSize: getIndexCacheBytes(),
  };
}
