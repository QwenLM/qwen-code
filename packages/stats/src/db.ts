/**
 * SQLite database for qwen-code usage statistics.
 * Uses better-sqlite3 (synchronous, zero-config, Node.js native).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiRequestRecord, ToolCallRecord } from './types.js';

const QWEN_HOME = process.env['QWEN_HOME'] ?? `${process.env['HOME']}/.qwen`;
const DB_PATH = `${QWEN_HOME}/stats.db`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    initSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS api_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      folder TEXT,
      model TEXT,
      provider TEXT,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      ttft_ms INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      thoughts_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      is_error INTEGER DEFAULT 0,
      error_type TEXT,
      error_status INTEGER,
      prompt_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_timestamp ON api_requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_session ON api_requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_api_model ON api_requests(model);
    CREATE INDEX IF NOT EXISTS idx_api_folder ON api_requests(folder);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      folder TEXT,
      tool_name TEXT NOT NULL,
      model TEXT,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      success INTEGER DEFAULT 1,
      decision TEXT,
      prompt_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_timestamp ON tool_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name);

    CREATE TABLE IF NOT EXISTS sync_state (
      session_file TEXT PRIMARY KEY,
      last_offset INTEGER DEFAULT 0,
      last_synced_at INTEGER
    );
  `);
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

export function upsertApiRequest(record: ApiRequestRecord): void {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO api_requests
    (id, session_id, folder, model, provider, timestamp, duration_ms, ttft_ms,
     input_tokens, output_tokens, cached_tokens, thoughts_tokens, total_tokens,
     is_error, error_type, error_status, prompt_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.sessionId, record.folder ?? null, record.model ?? null, record.provider ?? null,
    record.timestamp, record.durationMs ?? null, record.ttftMs ?? null,
    record.inputTokens ?? null, record.outputTokens ?? null, record.cachedTokens ?? null,
    record.thoughtsTokens ?? null, record.totalTokens ?? null,
    record.isError ? 1 : 0, record.errorType ?? null, record.errorStatus ?? null, record.promptId ?? null,
  );
}

export function upsertToolCall(record: ToolCallRecord): void {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO tool_calls
    (id, session_id, folder, tool_name, model, timestamp, duration_ms, success, decision, prompt_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.sessionId, record.folder ?? null, record.toolName,
    record.model ?? null, record.timestamp, record.durationMs ?? null,
    record.success ? 1 : 0, record.decision ?? null, record.promptId ?? null,
  );
}

export function batchUpsertApiRequests(records: ApiRequestRecord[]): void {
  if (records.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO api_requests
     (id, session_id, folder, model, provider, timestamp, duration_ms, ttft_ms,
      input_tokens, output_tokens, cached_tokens, thoughts_tokens, total_tokens,
      is_error, error_type, error_status, prompt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = d.transaction((rows: ApiRequestRecord[]) => {
    for (const r of rows) {
      stmt.run(
        r.id, r.sessionId, r.folder ?? null, r.model ?? null, r.provider ?? null,
        r.timestamp, r.durationMs ?? null, r.ttftMs ?? null,
        r.inputTokens ?? 0, r.outputTokens ?? 0, r.cachedTokens ?? 0,
        r.thoughtsTokens ?? 0, r.totalTokens ?? 0,
        r.isError ? 1 : 0, r.errorType ?? null, r.errorStatus ?? null, r.promptId ?? null,
      );
    }
  });
  tx(records);
}

export function batchUpsertToolCalls(records: ToolCallRecord[]): void {
  if (records.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO tool_calls
     (id, session_id, folder, tool_name, model, timestamp, duration_ms, success, decision, prompt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = d.transaction((rows: ToolCallRecord[]) => {
    for (const r of rows) {
      stmt.run(
        r.id, r.sessionId, r.folder ?? null, r.toolName,
        r.model ?? null, r.timestamp, r.durationMs ?? null,
        r.success ? 1 : 0, r.decision ?? null, r.promptId ?? null,
      );
    }
  });
  tx(records);
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

export function getSyncOffset(sessionFile: string): number {
  const d = getDb();
  const row = d.prepare('SELECT last_offset FROM sync_state WHERE session_file = ?').get(sessionFile) as { last_offset: number } | undefined;
  return row?.last_offset ?? 0;
}

export function updateSyncState(sessionFile: string, offset: number): void {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO sync_state (session_file, last_offset, last_synced_at) VALUES (?, ?, ?)`).run(
    sessionFile, offset, Date.now(),
  );
}
