/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Contract for the session-index sidecar: a durable, rebuildable index over
// the append-only JSONL transcripts. The JSONL files remain the sole
// authoritative store; any provider returned here may be deleted, corrupted,
// or disabled at any time and callers must still work (they fall back to
// file scanning). See docs/design/session-sqlite-sidecar.md.

import type { SessionTranscriptNavigationTurnKind } from './nav-hints.js';

export type SessionIndexMode = 'file' | 'sqlite';

export interface SessionIndexCatalogRow {
  sessionId: string;
  fileName: string;
  mtimeMs: number;
  sizeBytes: number;
  startTime: string | null;
  firstRecordUuid: string | null;
  /** The session id carried by the first record (differs for mismatched files). */
  firstRecordSessionId: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  customTitle: string | null;
  titleSource: string | null;
  goalObjective: string | null;
  parentSessionId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  recordCount: number;
  /** Byte checkpoint: the records index covers [0, indexedBytes) of the file. */
  indexedBytes: number;
  /** 'mismatch' when a record carries a foreign sessionId (legacy parity). */
  status: 'ok' | 'mismatch';
}

export interface SessionIndexRecordRow {
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

export interface SessionIndexSessionRow {
  sessionId: string;
  fileName: string;
  mtimeMs: number;
  sizeBytes: number;
  firstRecordUuid: string | null;
  firstRecordSessionId: string | null;
  firstRecordTimestamp: string | null;
  /** First conversation record's timestamp, mirroring buildIndex's startTime. */
  startTime: string | null;
  recordCount: number;
  indexedBytes: number;
  status: 'ok' | 'mismatch';
}

export interface SessionIndexSegment {
  offset: number;
  length: number;
}

/** One derived navigation turn, exactly as the transcript index computes it. */
export interface SessionIndexTurnHint {
  turnId: string;
  replayPosition: number;
  kind: 'prompt' | 'realtime' | 'scheduled';
  promptId?: string;
  finalAssistantRecordId?: string;
}

/**
 * Durable cache of one session's derived navigation turns, valid only for
 * the exact indexedBytes checkpoint it was computed from. Rebuilt whenever
 * the file moves past that checkpoint — never repaired, never merged.
 */
export interface SessionIndexTurnCache {
  indexedBytes: number;
  leafUuid: string;
  startTime: string | null;
  totalTurns: number;
  turns: SessionIndexTurnHint[];
}

/**
 * One sidecar per project directory. All query methods are synchronous
 * (node:sqlite is a synchronous API); sync methods are async because they
 * read JSONL files with cooperative I/O.
 */
export interface SessionIndexStore {
  /**
   * Reconcile the catalog with a chats directory: index new/changed files
   * (incremental from byte checkpoints), drop removed ones. No-op when the
   * previous sweep finished less than `minIntervalMs` ago. Returns the
   * number of files examined during the sweep, or -1 when skipped as fresh.
   */
  syncDirectory(chatsDir: string, minIntervalMs?: number): Promise<number>;
  /**
   * Reconcile one transcript file with the index (stat + incremental tail
   * scan; rewind-rebuild when the file shrank).
   */
  syncFile(filePath: string): Promise<void>;
  catalogRows(): SessionIndexCatalogRow[];
  /**
   * Catalog rows whose mtimeMs is strictly below `beforeMtimeMs` (or from the
   * newest when null), newest-first, at most `limit` rows.
   */
  catalogRowsAfterMtime(
    beforeMtimeMs: number | null,
    limit: number,
  ): SessionIndexCatalogRow[];
  /**
   * Full record metadata for one session in file order, or null when the
   * session is unknown or flagged 'mismatch'.
   */
  recordRows(sessionId: string): SessionIndexRecordRow[] | null;
  /** Byte segments of every line carrying one of `uuids`, grouped by uuid. */
  recordSegmentsForUuids(
    sessionId: string,
    uuids: ReadonlySet<string>,
  ): Map<string, SessionIndexSegment[]>;
  turnIndexCache(sessionId: string): SessionIndexTurnCache | null;
  putTurnIndexCache(sessionId: string, cache: SessionIndexTurnCache): void;
  sessionRow(sessionId: string): SessionIndexSessionRow | null;
  close(): void;
}
