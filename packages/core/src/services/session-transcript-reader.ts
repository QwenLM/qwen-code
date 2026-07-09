/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { Storage } from '../config/storage.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import type { ChatRecord } from './chatRecordingService.js';

export const SESSION_TRANSCRIPT_DEFAULT_LIMIT = 100;
export const SESSION_TRANSCRIPT_MAX_LIMIT = 500;
export const SESSION_TRANSCRIPT_CURSOR_VERSION = 1 as const;
export const SESSION_TRANSCRIPT_MAX_INDEX_BYTES = 256 * 1024 * 1024;

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

export interface SessionTranscriptCursorState {
  v: typeof SESSION_TRANSCRIPT_CURSOR_VERSION;
  sessionId: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  position: number;
  leafUuid: string;
  startTime: string;
  lastUpdated: string;
  replay?: unknown;
}

export interface SessionTranscriptReadPageOptions {
  cursor?: string;
  limit?: number;
}

export interface SessionTranscriptRecordPage {
  sessionId: string;
  filePath: string;
  records: ChatRecord[];
  gaps: HistoryGap[];
  hasMore: boolean;
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
  segments: RecordSegment[];
}

interface TranscriptIndex {
  filePath: string;
  fileIdentity: SessionTranscriptFileIdentity;
  snapshotSize: number;
  leafUuid: string;
  activeUuids: string[];
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
const cursorHmacKeys = new Map<string, Buffer>();
let indexCacheMaxBytesForTest: number | undefined;

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
    leafUuid: state.leafUuid,
    startTime: state.startTime,
    lastUpdated: state.lastUpdated,
    ...(state.replay !== undefined ? { replay: state.replay } : {}),
  };
}

function getCursorHmacKeyPath(workspaceCwd: string): string {
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
    return key.length === CURSOR_HMAC_KEY_BYTES ? key : undefined;
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

function signCursorPayload(
  payload: Record<string, unknown>,
  workspaceCwd: string,
): string {
  return crypto
    .createHmac('sha256', getCursorHmacKey(workspaceCwd))
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function hasValidCursorMac(
  payload: Record<string, unknown>,
  mac: string,
  workspaceCwd: string,
): boolean {
  const expected = Buffer.from(
    signCursorPayload(payload, workspaceCwd),
    'utf8',
  );
  const actual = Buffer.from(mac, 'utf8');
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function encodeCursorState(
  state: SessionTranscriptCursorState,
  workspaceCwd: string,
): string {
  const payload = cursorPayload(state);
  return Buffer.from(
    JSON.stringify({
      ...payload,
      mac: signCursorPayload(payload, workspaceCwd),
    }),
    'utf8',
  ).toString('base64url');
}

export function encodeSessionTranscriptCursor(
  state: SessionTranscriptCursorState,
  workspaceCwd: string,
): string {
  return encodeCursorState(state, workspaceCwd);
}

export function decodeSessionTranscriptCursor(
  cursor: string,
  workspaceCwd: string,
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
      !isFiniteNonNegativeInteger(fileIdentity['dev']) ||
      !isFiniteNonNegativeInteger(fileIdentity['ino']) ||
      !isFiniteNonNegativeInteger(parsed['snapshotSize']) ||
      !isFiniteNonNegativeInteger(parsed['position']) ||
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
      leafUuid: parsed['leafUuid'],
      startTime: parsed['startTime'],
      lastUpdated: parsed['lastUpdated'],
      ...(parsed['replay'] !== undefined ? { replay: parsed['replay'] } : {}),
    };
    if (!hasValidCursorMac(cursorPayload(state), parsed['mac'], workspaceCwd)) {
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

function fileIdentityFromStats(stats: fs.Stats): SessionTranscriptFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

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

function isChatRecord(value: unknown): value is ChatRecord {
  if (!isObjectRecord(value)) return false;
  const type = value['type'];
  return (
    typeof value['uuid'] === 'string' &&
    (typeof value['parentUuid'] === 'string' || value['parentUuid'] === null) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['timestamp'] === 'string' &&
    (type === 'user' ||
      type === 'assistant' ||
      type === 'tool_result' ||
      type === 'system')
  );
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
    .parseLineTolerant<ChatRecord>(line, filePath)
    .filter((record) => isChatRecord(record));
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

function aggregateRecords(records: ChatRecord[]): ChatRecord {
  if (records.length === 0) {
    throw new Error('Cannot aggregate empty transcript record array');
  }

  const base = { ...records[0] };

  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record.message !== undefined) {
      if (base.message === undefined) {
        base.message = record.message;
      } else {
        base.message = {
          role: base.message.role,
          parts: [
            ...(base.message.parts ?? []),
            ...(record.message.parts ?? []),
          ],
        };
      }
    }
    if (record.usageMetadata) {
      base.usageMetadata =
        record.usageMetadata as GenerateContentResponseUsageMetadata;
    }
    if (record.toolCallResult && !base.toolCallResult) {
      base.toolCallResult = record.toolCallResult;
    }
    if (record.model && !base.model) {
      base.model = record.model;
    }
    if (record.timestamp > base.timestamp) {
      base.timestamp = record.timestamp;
    }
  }

  return base;
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
        records.push(aggregateRecords(physicalRecords));
      }
    }
    return records;
  } finally {
    await handle.close();
  }
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

  await forEachLineInSnapshot(
    filePath,
    snapshotSize,
    (line, offset, length) => {
      const text = line.toString('utf8').trim();
      if (text.length === 0) return;
      let fragmentIndex = 0;
      for (const record of jsonl.parseLineTolerant<ChatRecord>(
        text,
        filePath,
      )) {
        if (!isChatRecord(record)) continue;
        startTime ??= record.timestamp;
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
            segments: [segment],
          });
        }
      }
    },
  );

  if (!leafUuid || !startTime) {
    debugLogger.warn(
      `index build failed: no transcript records session=${sessionId}`,
    );
    throw new SessionTranscriptSnapshotUnavailableError(sessionId);
  }

  const activeUuids: string[] = [];
  const gaps: HistoryGap[] = [];
  const visited = new Set<string>();
  let currentUuid: string | null = leafUuid;
  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const entry = byUuid.get(currentUuid);
    if (!entry) {
      debugLogger.debug(
        `active chain terminated: missing uuid session=${sessionId} ` +
          `uuid=${currentUuid}`,
      );
      break;
    }
    activeUuids.push(currentUuid);
    const parentUuid = entry.parentUuid;
    if (!parentUuid) break;
    if (!byUuid.has(parentUuid)) {
      gaps.push({ childUuid: currentUuid, missingParentUuid: parentUuid });
      debugLogger.debug(
        `active chain gap session=${sessionId} child=${currentUuid} ` +
          `missingParent=${parentUuid}`,
      );
      break;
    }
    currentUuid = parentUuid;
  }
  if (currentUuid && visited.has(currentUuid)) {
    debugLogger.debug(
      `active chain terminated: cycle session=${sessionId} uuid=${currentUuid}`,
    );
  }
  activeUuids.reverse();

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

  constructor(private readonly workspaceCwd: string) {
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
    const cursor =
      options.cursor !== undefined
        ? decodeSessionTranscriptCursor(options.cursor, this.workspaceCwd)
        : undefined;
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

    const position = cursor?.position ?? 0;
    if (position > index.activeUuids.length) {
      debugLogger.debug(
        `cursor position out of range session=${sessionId} ` +
          `position=${position} active=${index.activeUuids.length}`,
      );
      throw new InvalidSessionTranscriptCursorError();
    }
    const nextPosition = Math.min(position + limit, index.activeUuids.length);
    const pageUuids = index.activeUuids.slice(position, nextPosition);
    const records = await readAggregatedRecords(index, pageUuids);
    const hasMore = nextPosition < index.activeUuids.length;
    const nextCursorState: SessionTranscriptCursorState | undefined = hasMore
      ? {
          v: SESSION_TRANSCRIPT_CURSOR_VERSION,
          sessionId,
          fileIdentity,
          snapshotSize,
          position: nextPosition,
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
      ...(nextCursorState ? { nextCursorState } : {}),
      ...(cursor?.replay !== undefined ? { replay: cursor.replay } : {}),
      startTime: index.startTime,
      lastUpdated: index.lastUpdated,
    };
  }
}

export function resetSessionTranscriptIndexCacheForTest(): void {
  indexCache.clear();
  cursorHmacKeys.clear();
  indexCacheMaxBytesForTest = undefined;
}

export function setSessionTranscriptIndexCacheMaxBytesForTest(
  maxBytes: number,
): void {
  indexCacheMaxBytesForTest = maxBytes;
  pruneCache();
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
