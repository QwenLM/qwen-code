/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// node:sqlite-backed session index sidecar. The JSONL transcripts stay the
// sole authoritative store; this database only mirrors, per file, exactly
// the bytes it has consumed (indexedBytes checkpoint), so it can always be
// deleted and rebuilt. See docs/design/session-sqlite-sidecar.md.

import type * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../../utils/debugLogger.js';
import * as jsonl from '../../utils/jsonl-utils.js';
import {
  isTranscriptConversationRecord,
  validateTranscriptRecord,
} from '../../utils/transcript-records.js';
import { readSessionTitleInfoFromFileSync } from '../../utils/sessionStorageUtils.js';
import {
  isTurnResultRecordPayload,
  type ChatRecord,
} from '../chatRecordingService.js';
import { parseGoalStateRecordPayloadV2 } from '../../goals/goal-reducer.js';
import { recoverGoalFromRecords } from '../../goals/goal-persistence.js';
import {
  isAssistantPreviewCandidate,
  navigationKindForRecord,
  type SessionTranscriptNavigationTurnKind,
} from './nav-hints.js';
import type {
  SessionIndexCatalogRow,
  SessionIndexRecordRow,
  SessionIndexSessionRow,
  SessionIndexSegment,
  SessionIndexStore,
  SessionIndexTurnCache,
  SessionIndexTurnHint,
} from './types.js';

const debugLogger = createDebugLogger('SESSION_INDEX');

export const SESSION_INDEX_SCHEMA_VERSION = 3;
export const SESSION_INDEX_DB_FILE = 'sessions.index.sqlite';

/** Mirrors MAX_PROMPT_SCAN_LINES in sessionService.ts (kept private there). */
const PROMPT_SCAN_HEAD_RECORDS = 10;
/** Mirrors TAIL_READ_SIZE in sessionService.ts (source tail fallback window). */
const SOURCE_TAIL_WINDOW_BYTES = 64 * 1024;
const PROMPT_DISPLAY_MAX_CODEPOINTS = 200;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

export function sessionIndexDbPath(projectDir: string): string {
  return path.join(projectDir, SESSION_INDEX_DB_FILE);
}

export async function resetSessionIndexDatabase(
  projectDir: string,
): Promise<void> {
  const dbPath = sessionIndexDbPath(projectDir);
  await fsp.rm(dbPath, { force: true });
  await fsp.rm(`${dbPath}-wal`, { force: true });
  await fsp.rm(`${dbPath}-shm`, { force: true });
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDriver {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  sessionId TEXT PRIMARY KEY,
  fileName TEXT NOT NULL UNIQUE,
  mtimeMs INTEGER NOT NULL,
  sizeBytes INTEGER NOT NULL,
  startTime TEXT,
  firstRecordUuid TEXT,
  firstRecordTimestamp TEXT,
  firstRecordSessionId TEXT,
  firstPrompt TEXT,
  cwd TEXT,
  gitBranch TEXT,
  customTitle TEXT,
  titleSource TEXT,
  goalObjective TEXT,
  parentSessionId TEXT,
  sourceType TEXT,
  sourceId TEXT,
  recordCount INTEGER NOT NULL,
  indexedBytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS sessions_mtime ON sessions(mtimeMs DESC);
CREATE TABLE IF NOT EXISTS records(
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  uuid TEXT NOT NULL,
  parentUuid TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  timestamp TEXT,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  conversation INTEGER NOT NULL DEFAULT 0,
  inherited INTEGER NOT NULL DEFAULT 0,
  sideTaskSource INTEGER NOT NULL DEFAULT 0,
  navKind TEXT,
  assistantPreview INTEGER NOT NULL DEFAULT 0,
  turnResultPromptId TEXT,
  PRIMARY KEY(sessionId, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS records_uuid ON records(sessionId, uuid);
CREATE TABLE IF NOT EXISTS turns_cache(
  sessionId TEXT PRIMARY KEY,
  indexedBytes INTEGER NOT NULL,
  leafUuid TEXT NOT NULL,
  startTime TEXT,
  totalTurns INTEGER NOT NULL,
  turnsJson TEXT NOT NULL
);
`;

function truncatePromptForDisplay(text: string): string {
  const codePoints: string[] = [];
  for (const codePoint of text) {
    if (codePoints.length === PROMPT_DISPLAY_MAX_CODEPOINTS) {
      return `${codePoints.join('')}...`;
    }
    codePoints.push(codePoint);
  }
  return text;
}

/** Mirrors SessionService.extractFirstPromptFromRecords. */
function extractFirstPromptFromRecords(records: ChatRecord[]): string {
  for (const record of records) {
    if (record.type !== 'user' || record.subtype !== undefined) continue;
    const payload = record.systemPayload as
      | { displayText?: unknown }
      | undefined;
    if (payload?.displayText !== undefined) {
      if (typeof payload.displayText === 'string' && payload.displayText) {
        return truncatePromptForDisplay(payload.displayText);
      }
      continue;
    }
    for (const part of record.message?.parts ?? []) {
      if (
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        const text = (part as { text: string }).text;
        const truncated = truncatePromptForDisplay(text);
        if (truncated) return truncated;
        break;
      }
    }
  }
  return '';
}

/** Reads [startOffset, endOffset) of a file line by line. */
async function forEachLineInRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
  onLine: (line: Buffer, offset: number, length: number) => void,
): Promise<number> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = startOffset;
    let carry = Buffer.alloc(0);
    let carryStart = startOffset;
    let consumed = startOffset;
    while (position < endOffset) {
      const want = Math.min(SCAN_CHUNK_BYTES, endOffset - position);
      const { bytesRead } = await fh.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const base = carryStart;
      let lineStart = 0;
      let newline: number;
      while ((newline = chunk.indexOf(0x0a, lineStart)) >= 0) {
        const line = chunk.subarray(lineStart, newline);
        onLine(line, base + lineStart, line.length);
        lineStart = newline + 1;
      }
      consumed = base + lineStart;
      carry = chunk.subarray(lineStart);
      carryStart = base + lineStart;
      position += bytesRead;
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First `limit` validated records of a transcript, read from byte 0. */
async function readHeadChatRecords(
  filePath: string,
  sizeBytes: number,
  limit = 10,
): Promise<ChatRecord[]> {
  const head: ChatRecord[] = [];
  await forEachLineInRange(filePath, 0, sizeBytes, (line) => {
    if (head.length >= limit) return;
    const text = line.toString('utf8').trim();
    if (text.length === 0) return;
    for (const value of jsonl.parseLineTolerant<unknown>(text, filePath)) {
      if (head.length >= limit) break;
      const record = validateTranscriptRecord(value).record;
      if (record) head.push(record as unknown as ChatRecord);
    }
  });
  return head;
}

interface SyncedRecordRow {
  seq: number;
  uuid: string;
  parentUuid: string | null;
  type: string;
  subtype: string | null;
  timestamp: string | null;
  offset: number;
  length: number;
  conversation: boolean;
  inherited: boolean;
  sideTaskSource: boolean;
  navKind: SessionTranscriptNavigationTurnKind | null;
  assistantPreview: boolean;
  turnResultPromptId: string | null;
}

class SqliteSessionIndexStore implements SessionIndexStore {
  private readonly db: SqliteDatabase;
  private lastDirSweepMs = 0;
  // Serializes sync operations: one shared connection must never interleave
  // two `BEGIN … await … COMMIT` windows, so concurrent callers queue here.
  private syncQueue: Promise<unknown> = Promise.resolve();

  private enqueueSync<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncQueue.then(fn, fn);
    this.syncQueue = run.catch(() => undefined);
    return run;
  }

  constructor(driver: SqliteDriver, projectDir: string) {
    const dbPath = sessionIndexDbPath(projectDir);
    this.db = new driver.DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA busy_timeout=2000');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value?: unknown } | undefined;
    const version = typeof row?.value === 'string' ? Number(row.value) : 0;
    if (version === SESSION_INDEX_SCHEMA_VERSION) return;
    debugLogger.debug(
      `session index schema mismatch (${version} -> ${SESSION_INDEX_SCHEMA_VERSION}), rebuilding`,
    );
    this.db.exec(
      'DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS turns_cache;',
    );
    this.db.exec(SCHEMA);
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(SESSION_INDEX_SCHEMA_VERSION));
    this.lastDirSweepMs = 0;
  }

  syncDirectory(chatsDir: string, minIntervalMs = 30_000): Promise<number> {
    return this.enqueueSync(async () => {
      let entries: string[];
      try {
        entries = await fsp.readdir(chatsDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          entries = [];
        } else {
          throw error;
        }
      }
      const fileNames = new Set(entries.filter((e) => e.endsWith('.jsonl')));

      // The names pass runs on EVERY call — a session created or deleted in
      // the TTL window must never be invisible to (or linger in) listings.
      // Only the per-file stat sweep is throttled.
      const known = this.db
        .prepare('SELECT fileName FROM sessions')
        .all() as Array<{ fileName: string }>;
      const deleteByFileName = this.db.prepare(
        'DELETE FROM sessions WHERE fileName = ?',
      );
      const deleteRecords = this.db.prepare(
        'DELETE FROM records WHERE sessionId = (SELECT sessionId FROM sessions WHERE fileName = ?)',
      );
      const deleteTurnsCache = this.db.prepare(
        'DELETE FROM turns_cache WHERE sessionId = (SELECT sessionId FROM sessions WHERE fileName = ?)',
      );
      this.db.exec('BEGIN');
      try {
        for (const { fileName } of known) {
          if (!fileNames.has(fileName)) {
            deleteRecords.run(fileName);
            deleteTurnsCache.run(fileName);
            deleteByFileName.run(fileName);
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }

      // Brand-new files are indexed immediately even inside the TTL window:
      // they have no catalog row at all, so there is nothing to throttle.
      const now = Date.now();
      const sweepDue =
        this.lastDirSweepMs === 0 || now - this.lastDirSweepMs >= minIntervalMs;
      const skipFreshness = this.db.prepare(
        'SELECT mtimeMs, sizeBytes FROM sessions WHERE fileName = ?',
      );

      let examined = 0;
      for (const fileName of fileNames) {
        const filePath = path.join(chatsDir, fileName);
        const existing = skipFreshness.get(fileName) as
          | { mtimeMs: number; sizeBytes: number }
          | undefined;
        if (!sweepDue && existing) continue;
        let stats: fs.Stats;
        try {
          stats = await fsp.stat(filePath);
        } catch {
          continue;
        }
        examined++;
        if (
          existing &&
          existing.mtimeMs === stats.mtimeMs &&
          existing.sizeBytes === stats.size
        ) {
          continue;
        }
        await this.syncFileInTransaction(filePath, stats);
      }
      if (sweepDue) this.lastDirSweepMs = Date.now();
      return sweepDue ? examined : -1;
    });
  }

  syncFile(filePath: string): Promise<void> {
    return this.enqueueSync(async () => {
      const stats = await fsp.stat(filePath);
      const existing = this.db
        .prepare('SELECT mtimeMs, sizeBytes FROM sessions WHERE fileName = ?')
        .get(path.basename(filePath)) as
        | { mtimeMs: number; sizeBytes: number }
        | undefined;
      if (
        existing &&
        existing.mtimeMs === stats.mtimeMs &&
        existing.sizeBytes === stats.size
      ) {
        return;
      }
      await this.syncFileInTransaction(filePath, stats);
    });
  }

  private async syncFileInTransaction(
    filePath: string,
    stats: fs.Stats,
  ): Promise<void> {
    this.db.exec('BEGIN');
    try {
      await this.syncFileLocked(filePath, stats);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private async syncFileLocked(
    filePath: string,
    stats: fs.Stats,
  ): Promise<void> {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith('.jsonl')) return;
    const sessionId = fileName.slice(0, -'.jsonl'.length);
    const sizeBytes = stats.size;

    const existing = this.db
      .prepare(
        'SELECT sessionId, indexedBytes, recordCount, status FROM sessions WHERE sessionId = ?',
      )
      .get(sessionId) as
      | {
          sessionId: string;
          indexedBytes: number;
          recordCount: number;
          status: string;
        }
      | undefined;

    let startAt = 0;
    let seq = 0;
    let rewound = false;
    if (existing) {
      if (existing.indexedBytes <= sizeBytes) {
        startAt = existing.indexedBytes;
        seq = (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(seq) + 1, 0) AS nextSeq FROM records WHERE sessionId = ?',
            )
            .get(sessionId) as { nextSeq: number }
        ).nextSeq;
      } else {
        // File shrank or was replaced: rewind and rebuild from zero. The
        // JSONL is the only authority; sidecar bytes are never "repaired".
        this.db
          .prepare('DELETE FROM records WHERE sessionId = ?')
          .run(sessionId);
        this.db
          .prepare('DELETE FROM turns_cache WHERE sessionId = ?')
          .run(sessionId);
        this.db
          .prepare('DELETE FROM sessions WHERE sessionId = ?')
          .run(sessionId);
        rewound = true;
      }
    }
    const priorRecordCount = rewound ? 0 : (existing?.recordCount ?? 0);
    const priorMismatch = !rewound && existing?.status === 'mismatch';

    // State accumulated over the whole file (carried across incremental scans
    // via the previous session row where flagged as resumed below).
    const resumed = startAt > 0;
    const headRecords: ChatRecord[] = [];
    const rows: SyncedRecordRow[] = [];
    /** uuid -> index into `rows`, scoped to this file (fragment merging). */
    const rowIndexByUuid = new Map<string, number>();
    if (resumed) {
      const prior = this.db
        .prepare(
          'SELECT seq, uuid, type, subtype, navKind, assistantPreview FROM records WHERE sessionId = ?',
        )
        .all(sessionId) as Array<{
        seq: number;
        uuid: string;
        type: string;
        subtype: string | null;
        navKind: string | null;
        assistantPreview: number;
      }>;
      // Fragment merging in a resumed scan only matters when a new fragment
      // of an already-seen uuid arrives; keep the map light.
      for (const priorRow of prior) {
        if (!rowIndexByUuid.has(priorRow.uuid)) {
          rowIndexByUuid.set(priorRow.uuid, -priorRow.seq - 1);
        }
      }
    }
    let recordCount = 0;
    let sessionMismatch = false;
    let firstRecordUuid: string | null = null;
    let firstRecordSessionId: string | null = null;
    let firstRecordTimestamp: string | null = null;
    let firstConversationStartTime: string | null = null;
    let firstPrompt = '';
    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let lastGoal: {
      matched: boolean;
      value: string | undefined;
      offset: number;
    } = {
      matched: false,
      value: undefined,
      offset: -1,
    };
    // Creation metadata mirrors SessionService.extractCreationMetadataFromFile:
    // head records first (they carry parent_session / session_source written
    // at creation), with a last-tail-window session_source fallback only when
    // the head carried no sourceType.
    let headParentSessionId: string | undefined;
    let headSource: { sourceType?: string; sourceId?: string } = {};
    let tailSourceLast:
      | { sourceType: string; sourceId?: string; offset: number }
      | undefined;

    const consumed = await forEachLineInRange(
      filePath,
      startAt,
      sizeBytes,
      (line, offset, length) => {
        const text = line.toString('utf8').trim();
        if (text.length === 0) return;
        let fragmentIndex = 0;
        for (const value of jsonl.parseLineTolerant<unknown>(text, filePath)) {
          const record = validateTranscriptRecord(value).record;
          if (!record) continue;
          const seqNow = seq++;
          if (recordCount === 0 && !resumed && firstRecordUuid === null) {
            firstRecordUuid = record.uuid;
            firstRecordSessionId = record.sessionId ?? null;
            firstRecordTimestamp = record.timestamp ?? null;
            cwd = (record as unknown as ChatRecord).cwd ?? null;
            gitBranch = (record as unknown as ChatRecord).gitBranch ?? null;
          }
          recordCount++;
          if (record.sessionId !== sessionId) sessionMismatch = true;
          if (headRecords.length < PROMPT_SCAN_HEAD_RECORDS) {
            headRecords.push(record as unknown as ChatRecord);
          }

          const chatRecord = record as unknown as ChatRecord;
          const conversation = isTranscriptConversationRecord(record);
          if (
            conversation &&
            record.timestamp &&
            firstConversationStartTime === null
          ) {
            firstConversationStartTime = record.timestamp;
          }
          const sideTaskSource =
            record.type === 'system' &&
            record.subtype === 'session_source' &&
            isObjectRecord(record.systemPayload) &&
            record.systemPayload['sourceType'] === 'side_task';

          if (record.type === 'system' && record.subtype === 'goal_state') {
            const payload = parseGoalStateRecordPayloadV2(record.systemPayload);
            lastGoal = {
              matched: true,
              value: payload?.snapshot.goal?.objective,
              offset,
            };
          }
          // Head-window membership is file-global (the legacy path slices
          // the first 10 records of the whole file), never scan-local —
          // resumed syncs must not re-evaluate "headness" on appended rows.
          const globalRecordIndex = priorRecordCount + recordCount - 1;
          const inHeadWindow =
            !resumed && globalRecordIndex < PROMPT_SCAN_HEAD_RECORDS;
          if (
            inHeadWindow &&
            record.type === 'system' &&
            record.subtype === 'parent_session' &&
            headParentSessionId === undefined
          ) {
            const payload = record.systemPayload as
              | { parentSessionId?: unknown }
              | undefined;
            if (typeof payload?.parentSessionId === 'string') {
              headParentSessionId = payload.parentSessionId;
            }
          }
          if (record.type === 'system' && record.subtype === 'session_source') {
            const payload = record.systemPayload as
              | { sourceType?: unknown; sourceId?: unknown }
              | undefined;
            if (typeof payload?.sourceType === 'string') {
              const candidate = {
                sourceType: payload.sourceType,
                ...(typeof payload.sourceId === 'string'
                  ? { sourceId: payload.sourceId }
                  : {}),
              };
              // Head window: first source wins (legacy head path); later
              // records: remember the last one within the tail window.
              if (inHeadWindow && headSource.sourceType === undefined) {
                headSource = candidate;
              } else {
                tailSourceLast = { ...candidate, offset };
              }
            }
          }

          const turnResultPromptId =
            record.subtype === 'turn_result' &&
            isTurnResultRecordPayload(record.systemPayload)
              ? record.systemPayload.promptId
              : null;

          const fragmentRow: SyncedRecordRow = {
            seq: seqNow,
            uuid: record.uuid,
            parentUuid: record.parentUuid ?? null,
            type: record.type,
            subtype: record.subtype ?? null,
            timestamp: record.timestamp ?? null,
            offset,
            length,
            conversation,
            inherited: record.forkedFrom !== undefined,
            sideTaskSource,
            navKind: navigationKindForRecord(chatRecord) ?? null,
            assistantPreview: isAssistantPreviewCandidate(chatRecord),
            turnResultPromptId,
          };
          void fragmentIndex++;

          const existingIndex = rowIndexByUuid.get(record.uuid);
          if (existingIndex === undefined) {
            rowIndexByUuid.set(record.uuid, rows.length);
            rows.push(fragmentRow);
          } else if (existingIndex >= 0) {
            // Later fragment of an already-indexed uuid: merge navigation
            // columns into the first fragment row, same as buildIndex. The
            // fragment itself is still indexed (with empty nav columns) so
            // segment reads can re-aggregate every occurrence of the uuid.
            const target = rows[existingIndex];
            const merged = {
              ...chatRecord,
              type: target.type,
              subtype: target.subtype ?? undefined,
            } as ChatRecord;
            if (target.navKind === null) {
              target.navKind = navigationKindForRecord(merged) ?? null;
            }
            if (!target.assistantPreview) {
              target.assistantPreview = isAssistantPreviewCandidate(merged);
            }
            rows.push({
              ...fragmentRow,
              navKind: null,
              assistantPreview: false,
            });
          } else {
            // Fragment of a uuid indexed in an earlier scan window: merge
            // into the stored row in place.
            const priorSeq = -existingIndex - 1;
            const stored = this.db
              .prepare(
                'SELECT type, subtype, navKind, assistantPreview FROM records WHERE sessionId = ? AND seq = ?',
              )
              .get(sessionId, priorSeq) as
              | {
                  type: string;
                  subtype: string | null;
                  navKind: string | null;
                  assistantPreview: number;
                }
              | undefined;
            if (stored) {
              const merged = {
                ...chatRecord,
                type: stored.type,
                subtype: stored.subtype ?? undefined,
              } as ChatRecord;
              const navKind =
                stored.navKind ?? navigationKindForRecord(merged) ?? null;
              const assistantPreview =
                stored.assistantPreview === 1 ||
                isAssistantPreviewCandidate(merged);
              this.db
                .prepare(
                  'UPDATE records SET navKind = ?, assistantPreview = ? WHERE sessionId = ? AND seq = ?',
                )
                .run(navKind, assistantPreview ? 1 : 0, sessionId, priorSeq);
            }
            rows.push({
              ...fragmentRow,
              navKind: null,
              assistantPreview: false,
            });
          }
        }
      },
    );

    // Listing-label fields: prompt from the head records, title from the
    // shared tail-anchored helper, goal objective via the same resolution
    // policy SessionService.resolveGoalObjective implements.
    let resumedHeadRecords: ChatRecord[] | undefined;
    const headRecordsForResume = async (): Promise<ChatRecord[]> => {
      resumedHeadRecords ??= await readHeadChatRecords(filePath, sizeBytes);
      return resumedHeadRecords;
    };
    if (!resumed) {
      firstPrompt = extractFirstPromptFromRecords(headRecords);
    } else {
      const updatedHead = this.db
        .prepare('SELECT firstPrompt FROM sessions WHERE sessionId = ?')
        .get(sessionId) as { firstPrompt?: string } | undefined;
      firstPrompt = updatedHead?.firstPrompt ?? '';
      if (!firstPrompt) {
        // The sync that stored the empty prompt ran before the first user
        // prompt landed (a picker refresh racing session startup). Re-read
        // the head once so the catalog label converges with the scan path.
        firstPrompt = extractFirstPromptFromRecords(
          await headRecordsForResume(),
        );
      }
    }
    if (resumed) {
      // Creation metadata written AFTER the first sync (session startup
      // raced a listing) must still land — re-check the head only when the
      // stored row is missing it.
      const priorMeta = this.db
        .prepare(
          'SELECT parentSessionId, sourceType, sourceId FROM sessions WHERE sessionId = ?',
        )
        .get(sessionId) as
        | {
            parentSessionId?: string | null;
            sourceType?: string | null;
            sourceId?: string | null;
          }
        | undefined;
      if (!priorMeta?.parentSessionId || !priorMeta.sourceType) {
        for (const record of await headRecordsForResume()) {
          if (
            record.type === 'system' &&
            record.subtype === 'parent_session' &&
            headParentSessionId === undefined
          ) {
            const payload = record.systemPayload as
              | { parentSessionId?: unknown }
              | undefined;
            if (typeof payload?.parentSessionId === 'string') {
              headParentSessionId = payload.parentSessionId;
            }
          }
          if (
            record.type === 'system' &&
            record.subtype === 'session_source' &&
            headSource.sourceType === undefined
          ) {
            const payload = record.systemPayload as
              | { sourceType?: unknown; sourceId?: unknown }
              | undefined;
            if (typeof payload?.sourceType === 'string') {
              headSource = {
                sourceType: payload.sourceType,
                ...(typeof payload.sourceId === 'string'
                  ? { sourceId: payload.sourceId }
                  : {}),
              };
            }
          }
        }
      }
    }
    const titleInfo = readSessionTitleInfoFromFileSync(filePath);
    let goalObjective: string | null = null;
    if (!firstPrompt && !titleInfo.title) {
      const totalRecords =
        (resumed
          ? ((
              this.db
                .prepare(
                  'SELECT COUNT(*) AS c FROM records WHERE sessionId = ?',
                )
                .get(sessionId) as { c: number }
            ).c ?? 0)
          : 0) + rows.length;
      if (!resumed && totalRecords < PROMPT_SCAN_HEAD_RECORDS) {
        const recovery = recoverGoalFromRecords(headRecords);
        const objective =
          recovery.kind === 'v2'
            ? recovery.payload.snapshot.goal?.objective
            : recovery.kind === 'legacy'
              ? recovery.objective
              : undefined;
        goalObjective = objective ? truncatePromptForDisplay(objective) : null;
      } else if (
        lastGoal.matched &&
        lastGoal.offset >= sizeBytes - SOURCE_TAIL_WINDOW_BYTES
      ) {
        // Legacy probes only the last 64 KiB for the goal objective: a hit
        // beyond the tail window may belong to a cleared goal and is left
        // unlabelled there, so the sidecar must not label it either.
        goalObjective = lastGoal.value
          ? truncatePromptForDisplay(lastGoal.value)
          : null;
      } else if (resumed) {
        const priorGoal = this.db
          .prepare('SELECT goalObjective FROM sessions WHERE sessionId = ?')
          .get(sessionId) as { goalObjective?: string | null } | undefined;
        goalObjective = priorGoal?.goalObjective ?? null;
      }
    }

    const insertRecord = this.db.prepare(
      `INSERT INTO records(
        sessionId, seq, uuid, parentUuid, type, subtype, timestamp,
        offset, length, conversation, inherited, sideTaskSource,
        navKind, assistantPreview, turnResultPromptId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insertRecord.run(
        sessionId,
        row.seq,
        row.uuid,
        row.parentUuid,
        row.type,
        row.subtype,
        row.timestamp,
        row.offset,
        row.length,
        row.conversation ? 1 : 0,
        row.inherited ? 1 : 0,
        row.sideTaskSource ? 1 : 0,
        row.navKind,
        row.assistantPreview ? 1 : 0,
        row.turnResultPromptId,
      );
    }

    // Full-precision float mtime, same as the scan path: flooring would
    // widen the equal-mtime class that the strict `<` cursor drops.
    const mtimeMs = stats.mtimeMs;
    const previous = this.db
      .prepare(
        'SELECT startTime, firstPrompt, cwd, gitBranch, firstRecordUuid, firstRecordTimestamp, firstRecordSessionId, parentSessionId, sourceType, sourceId, customTitle, titleSource, goalObjective FROM sessions WHERE sessionId = ?',
      )
      .get(sessionId) as
      | (Partial<SessionIndexSessionRow> & {
          firstPrompt?: string;
          cwd?: string;
          gitBranch?: string;
          customTitle?: string;
          titleSource?: string;
          goalObjective?: string | null;
          parentSessionId?: string;
          sourceType?: string;
          sourceId?: string;
        })
      | undefined;

    // Source fallback mirrors SessionService.extractCreationMetadataFromFile:
    // only consulted when the head records carried no sourceType, and only a
    // session_source inside the last SOURCE_TAIL_WINDOW_BYTES qualifies.
    const tailAccepted =
      headSource.sourceType === undefined &&
      tailSourceLast !== undefined &&
      tailSourceLast.offset >= sizeBytes - SOURCE_TAIL_WINDOW_BYTES
        ? tailSourceLast
        : undefined;
    let sourceType: string | null = null;
    let sourceId: string | null = null;
    if (headSource.sourceType !== undefined) {
      sourceType = headSource.sourceType;
      sourceId = headSource.sourceId ?? null;
    } else if (tailAccepted !== undefined) {
      sourceType = tailAccepted.sourceType;
      sourceId = tailAccepted.sourceId ?? headSource.sourceId ?? null;
    }
    if (sourceType === null && resumed) {
      sourceType = previous?.sourceType ?? null;
      sourceId = previous?.sourceId ?? sourceId;
    }

    this.db
      .prepare(
        `INSERT INTO sessions(
          sessionId, fileName, mtimeMs, sizeBytes, startTime,
          firstRecordUuid, firstRecordTimestamp, firstRecordSessionId,
          firstPrompt, cwd, gitBranch,
          customTitle, titleSource, goalObjective, parentSessionId,
          sourceType, sourceId, recordCount, indexedBytes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sessionId) DO UPDATE SET
          fileName = excluded.fileName,
          mtimeMs = excluded.mtimeMs,
          sizeBytes = excluded.sizeBytes,
          startTime = COALESCE(sessions.startTime, excluded.startTime),
          firstRecordUuid = COALESCE(sessions.firstRecordUuid, excluded.firstRecordUuid),
          firstRecordTimestamp = COALESCE(sessions.firstRecordTimestamp, excluded.firstRecordTimestamp),
          firstRecordSessionId = COALESCE(sessions.firstRecordSessionId, excluded.firstRecordSessionId),
          firstPrompt = excluded.firstPrompt,
          cwd = COALESCE(sessions.cwd, excluded.cwd),
          gitBranch = COALESCE(sessions.gitBranch, excluded.gitBranch),
          customTitle = excluded.customTitle,
          titleSource = excluded.titleSource,
          goalObjective = excluded.goalObjective,
          parentSessionId = COALESCE(sessions.parentSessionId, excluded.parentSessionId),
          sourceType = COALESCE(excluded.sourceType, sessions.sourceType),
          sourceId = COALESCE(excluded.sourceId, sessions.sourceId),
          recordCount = excluded.recordCount,
          indexedBytes = excluded.indexedBytes,
          status = excluded.status`,
      )
      .run(
        sessionId,
        fileName,
        mtimeMs,
        sizeBytes,
        firstConversationStartTime,
        firstRecordUuid,
        firstRecordTimestamp,
        firstRecordUuid !== null
          ? firstRecordSessionId
          : (previous?.firstRecordSessionId ?? null),
        firstPrompt,
        firstRecordUuid !== null ? cwd : (previous?.cwd ?? null),
        firstRecordUuid !== null ? gitBranch : (previous?.gitBranch ?? null),
        titleInfo.title ?? null,
        titleInfo.source ?? null,
        goalObjective,
        headParentSessionId ?? null,
        sourceType,
        sourceId,
        priorRecordCount + rows.length,
        consumed,
        priorMismatch || sessionMismatch ? 'mismatch' : 'ok',
      );
  }

  catalogRows(): SessionIndexCatalogRow[] {
    return this.db
      .prepare(
        `SELECT sessionId, fileName, mtimeMs, sizeBytes, startTime,
                firstRecordUuid, firstRecordSessionId, firstPrompt,
                cwd, gitBranch, customTitle, titleSource, goalObjective,
                parentSessionId, sourceType, sourceId, recordCount,
                indexedBytes, status
         FROM sessions
         ORDER BY mtimeMs DESC, sessionId`,
      )
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          sessionId: r['sessionId'] as string,
          fileName: r['fileName'] as string,
          mtimeMs: r['mtimeMs'] as number,
          sizeBytes: r['sizeBytes'] as number,
          startTime: (r['startTime'] as string | null) ?? null,
          firstRecordUuid: (r['firstRecordUuid'] as string | null) ?? null,
          firstRecordSessionId:
            (r['firstRecordSessionId'] as string | null) ?? null,
          firstPrompt: (r['firstPrompt'] as string | null) ?? null,
          cwd: (r['cwd'] as string | null) ?? null,
          gitBranch: (r['gitBranch'] as string | null) ?? null,
          customTitle: (r['customTitle'] as string | null) ?? null,
          titleSource: (r['titleSource'] as string | null) ?? null,
          goalObjective: (r['goalObjective'] as string | null) ?? null,
          parentSessionId: (r['parentSessionId'] as string | null) ?? null,
          sourceType: (r['sourceType'] as string | null) ?? null,
          sourceId: (r['sourceId'] as string | null) ?? null,
          recordCount: r['recordCount'] as number,
          indexedBytes: r['indexedBytes'] as number,
          status: r['status'] === 'mismatch' ? 'mismatch' : 'ok',
        };
      }) as SessionIndexCatalogRow[];
  }

  catalogRowsAfterMtime(
    beforeMtimeMs: number | null,
    limit: number,
  ): SessionIndexCatalogRow[] {
    return this.db
      .prepare(
        `SELECT sessionId, fileName, mtimeMs, sizeBytes, startTime,
                firstRecordUuid, firstRecordSessionId, firstPrompt,
                cwd, gitBranch, customTitle, titleSource, goalObjective,
                parentSessionId, sourceType, sourceId, recordCount,
                indexedBytes, status
         FROM sessions
         WHERE (? IS NULL OR mtimeMs < ?)
         ORDER BY mtimeMs DESC, sessionId
         LIMIT ?`,
      )
      .all(beforeMtimeMs, beforeMtimeMs, limit)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          sessionId: r['sessionId'] as string,
          fileName: r['fileName'] as string,
          mtimeMs: r['mtimeMs'] as number,
          sizeBytes: r['sizeBytes'] as number,
          startTime: (r['startTime'] as string | null) ?? null,
          firstRecordUuid: (r['firstRecordUuid'] as string | null) ?? null,
          firstRecordSessionId:
            (r['firstRecordSessionId'] as string | null) ?? null,
          firstPrompt: (r['firstPrompt'] as string | null) ?? null,
          cwd: (r['cwd'] as string | null) ?? null,
          gitBranch: (r['gitBranch'] as string | null) ?? null,
          customTitle: (r['customTitle'] as string | null) ?? null,
          titleSource: (r['titleSource'] as string | null) ?? null,
          goalObjective: (r['goalObjective'] as string | null) ?? null,
          parentSessionId: (r['parentSessionId'] as string | null) ?? null,
          sourceType: (r['sourceType'] as string | null) ?? null,
          sourceId: (r['sourceId'] as string | null) ?? null,
          recordCount: r['recordCount'] as number,
          indexedBytes: r['indexedBytes'] as number,
          status: r['status'] === 'mismatch' ? 'mismatch' : 'ok',
        };
      }) as SessionIndexCatalogRow[];
  }

  recordSegmentsForUuids(
    sessionId: string,
    uuids: ReadonlySet<string>,
  ): Map<string, SessionIndexSegment[]> {
    const out = new Map<string, SessionIndexSegment[]>();
    if (uuids.size === 0) return out;
    const placeholders = [...uuids].map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT uuid, offset, length FROM records
         WHERE sessionId = ? AND uuid IN (${placeholders})
         ORDER BY seq`,
      )
      .all(sessionId, ...uuids) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const uuid = r['uuid'] as string;
      const list = out.get(uuid) ?? [];
      list.push({
        offset: r['offset'] as number,
        length: r['length'] as number,
      });
      out.set(uuid, list);
    }
    return out;
  }

  turnIndexCache(sessionId: string): SessionIndexTurnCache | null {
    const r = this.db
      .prepare(
        `SELECT indexedBytes, leafUuid, startTime, totalTurns, turnsJson
         FROM turns_cache WHERE sessionId = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    let turns: SessionIndexTurnHint[];
    try {
      turns = JSON.parse(r['turnsJson'] as string) as SessionIndexTurnHint[];
    } catch {
      return null;
    }
    return {
      indexedBytes: r['indexedBytes'] as number,
      leafUuid: r['leafUuid'] as string,
      startTime: (r['startTime'] as string | null) ?? null,
      totalTurns: r['totalTurns'] as number,
      turns,
    };
  }

  putTurnIndexCache(sessionId: string, cache: SessionIndexTurnCache): void {
    this.db
      .prepare(
        `INSERT INTO turns_cache(sessionId, indexedBytes, leafUuid, startTime, totalTurns, turnsJson)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET
           indexedBytes = excluded.indexedBytes,
           leafUuid = excluded.leafUuid,
           startTime = excluded.startTime,
           totalTurns = excluded.totalTurns,
           turnsJson = excluded.turnsJson`,
      )
      .run(
        sessionId,
        cache.indexedBytes,
        cache.leafUuid,
        cache.startTime,
        cache.totalTurns,
        JSON.stringify(cache.turns),
      );
  }

  recordRows(sessionId: string): SessionIndexRecordRow[] | null {
    const session = this.sessionRow(sessionId);
    if (!session || session.status !== 'ok') return null;
    return (
      this.db
        .prepare(
          `SELECT seq, uuid, parentUuid, type, subtype, timestamp, offset, length,
                  conversation, inherited, sideTaskSource, navKind,
                  assistantPreview, turnResultPromptId
           FROM records WHERE sessionId = ? ORDER BY seq`,
        )
        .all(sessionId) as Array<Record<string, unknown>>
    ).map((r) => ({
      seq: r['seq'] as number,
      uuid: r['uuid'] as string,
      parentUuid: (r['parentUuid'] as string | null) ?? null,
      type: r['type'] as string,
      subtype: (r['subtype'] as string | null) ?? null,
      timestamp: (r['timestamp'] as string | null) ?? null,
      offset: r['offset'] as number,
      length: r['length'] as number,
      conversation: r['conversation'] === 1,
      inherited: r['inherited'] === 1,
      sideTaskSource: r['sideTaskSource'] === 1,
      navKind:
        (r['navKind'] as SessionTranscriptNavigationTurnKind | null) ?? null,
      assistantPreview: r['assistantPreview'] === 1,
      turnResultPromptId: (r['turnResultPromptId'] as string | null) ?? null,
    }));
  }

  sessionRow(sessionId: string): SessionIndexSessionRow | null {
    const r = this.db
      .prepare(
        `SELECT sessionId, fileName, mtimeMs, sizeBytes, firstRecordUuid,
                firstRecordTimestamp, firstRecordSessionId, startTime,
                recordCount, indexedBytes, status
         FROM sessions WHERE sessionId = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      sessionId: r['sessionId'] as string,
      fileName: r['fileName'] as string,
      mtimeMs: r['mtimeMs'] as number,
      sizeBytes: r['sizeBytes'] as number,
      firstRecordUuid: (r['firstRecordUuid'] as string | null) ?? null,
      firstRecordSessionId:
        (r['firstRecordSessionId'] as string | null) ?? null,
      firstRecordTimestamp:
        (r['firstRecordTimestamp'] as string | null) ?? null,
      startTime: (r['startTime'] as string | null) ?? null,
      recordCount: r['recordCount'] as number,
      indexedBytes: r['indexedBytes'] as number,
      status: r['status'] === 'mismatch' ? 'mismatch' : 'ok',
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // closing after a failed open is best-effort
    }
  }
}

export function openSessionIndexStore(
  driver: SqliteDriver,
  projectDir: string,
): SessionIndexStore {
  return new SqliteSessionIndexStore(driver, projectDir);
}
