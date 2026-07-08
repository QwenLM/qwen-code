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
  hasMore: boolean;
  nextCursor?: string;
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
  startTime: string;
  lastUpdated: string;
  byUuid: Map<string, UuidIndexEntry>;
}

interface CacheEntry {
  expiresAt: number;
  value?: TranscriptIndex;
  pending?: Promise<TranscriptIndex>;
}

const INDEX_CACHE_MAX_ENTRIES = 32;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
const READ_CHUNK_SIZE = 64 * 1024;
let cursorHmacKey: Buffer | undefined;

const indexCache = new Map<string, CacheEntry>();

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

function getCursorHmacKey(): Buffer {
  cursorHmacKey ??= crypto.randomBytes(32);
  return cursorHmacKey;
}

function signCursorPayload(payload: Record<string, unknown>): string {
  return crypto
    .createHmac('sha256', getCursorHmacKey())
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function hasValidCursorMac(
  payload: Record<string, unknown>,
  mac: string,
): boolean {
  const expected = Buffer.from(signCursorPayload(payload), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function encodeCursorState(state: SessionTranscriptCursorState): string {
  const payload = cursorPayload(state);
  return Buffer.from(
    JSON.stringify({
      ...payload,
      mac: signCursorPayload(payload),
    }),
    'utf8',
  ).toString('base64url');
}

export function encodeSessionTranscriptCursor(
  state: SessionTranscriptCursorState,
): string {
  return encodeCursorState(state);
}

export function decodeSessionTranscriptCursor(
  cursor: string,
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
    if (!hasValidCursorMac(cursorPayload(state), parsed['mac'])) {
      throw new InvalidSessionTranscriptCursorError();
    }
    return state;
  } catch (error) {
    if (error instanceof InvalidSessionTranscriptCursorError) {
      throw error;
    }
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
): string {
  return `${filePath}:${fileIdentity.dev}:${fileIdentity.ino}:${snapshotSize}`;
}

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of indexCache) {
    if (entry.expiresAt <= now) {
      indexCache.delete(key);
    }
  }
  while (indexCache.size > INDEX_CACHE_MAX_ENTRIES) {
    const oldest = indexCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    indexCache.delete(oldest);
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
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;
  let streamOffset = 0;
  const stream = fs.createReadStream(filePath, {
    start: 0,
    end: snapshotSize - 1,
    highWaterMark: READ_CHUNK_SIZE,
  });

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let combined: Buffer;
    let combinedOffset: number;
    if (pending.length === 0) {
      combined = buffer;
      combinedOffset = streamOffset;
    } else {
      combined = Buffer.concat([pending, buffer]);
      combinedOffset = pendingOffset;
      pending = Buffer.alloc(0);
    }

    let lineStart = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== 0x0a) continue;
      const rawLine = combined.subarray(lineStart, i);
      const line =
        rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1)
          : rawLine;
      onLine(line, combinedOffset + lineStart, line.length);
      lineStart = i + 1;
    }

    if (lineStart < combined.length) {
      pending = combined.subarray(lineStart);
      pendingOffset = combinedOffset + lineStart;
    }
    streamOffset += buffer.length;
  }

  if (pending.length > 0) {
    const line =
      pending[pending.length - 1] === 0x0d
        ? pending.subarray(0, pending.length - 1)
        : pending;
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
  const record = records[segment.fragmentIndex];
  return record?.uuid === uuid ? [record] : [];
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
    throw new SessionTranscriptTooLargeError(
      sessionId,
      snapshotSize,
      SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    );
  }
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
    throw new SessionTranscriptSnapshotUnavailableError(sessionId);
  }

  const activeUuids: string[] = [];
  const visited = new Set<string>();
  let currentUuid: string | null = leafUuid;
  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    activeUuids.push(currentUuid);
    currentUuid = byUuid.get(currentUuid)?.parentUuid ?? null;
  }
  activeUuids.reverse();

  return {
    filePath,
    fileIdentity,
    snapshotSize,
    leafUuid,
    activeUuids,
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
  );
  const cached = indexCache.get(key);
  if (cached?.value && cached.expiresAt > now) {
    indexCache.delete(key);
    indexCache.set(key, cached);
    return cached.value;
  }
  if (cached?.pending && cached.expiresAt > now) {
    return cached.pending;
  }

  const pending = buildIndex(params);
  indexCache.set(key, {
    pending,
    expiresAt: now + INDEX_CACHE_TTL_MS,
  });
  try {
    const value = await pending;
    indexCache.set(key, {
      value,
      expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
    });
    pruneCache();
    return value;
  } catch (error) {
    indexCache.delete(key);
    throw error;
  }
}

export class SessionTranscriptReader {
  private readonly storage: Storage;

  constructor(workspaceCwd: string) {
    this.storage = new Storage(workspaceCwd);
  }

  getSessionFilePath(sessionId: string): string {
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
        ? decodeSessionTranscriptCursor(options.cursor)
        : undefined;
    if (cursor && cursor.sessionId !== sessionId) {
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
      throw new SessionTranscriptSnapshotUnavailableError(sessionId);
    }

    const index = await getCachedIndex({
      filePath,
      fileIdentity,
      snapshotSize,
      lastUpdated: cursor?.lastUpdated ?? new Date(stats.mtimeMs).toISOString(),
    });
    if (cursor && cursor.leafUuid !== index.leafUuid) {
      throw new SessionTranscriptSnapshotUnavailableError(sessionId);
    }

    const position = cursor?.position ?? 0;
    if (position > index.activeUuids.length) {
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

    return {
      sessionId,
      filePath,
      records,
      hasMore,
      ...(nextCursorState
        ? {
            nextCursorState,
            nextCursor: encodeCursorState(nextCursorState),
          }
        : {}),
      ...(cursor?.replay !== undefined ? { replay: cursor.replay } : {}),
      startTime: index.startTime,
      lastUpdated: index.lastUpdated,
    };
  }
}

export function resetSessionTranscriptIndexCacheForTest(): void {
  indexCache.clear();
}
