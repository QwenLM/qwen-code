/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';

/**
 * Per-session append-only ledger of prompt terminal outcomes.
 *
 * The daemon's turn terminal events (`turn_complete` / `turn_error`) are
 * synthesized at the SSE layer and never persisted, so after a daemon
 * restart a cold `POST /session/:id/load` replay carries no terminal
 * evidence and clients keyed on `promptId` can only answer "unknown". This
 * ledger closes that gap with a small sidecar JSONL file stored next to the
 * session transcript: one `in_flight` record when a prompt is admitted, one
 * terminal record when its formal terminal publishes (including the
 * close/kill/channel-crash/daemon-shutdown flushes).
 *
 * Records deliberately carry no prompt content — only ids, state, and
 * timestamps (privacy boundary; see
 * docs/design/2026-08-19-prompt-terminal-ledger-design.md).
 * This module is intentionally dependency-free beyond `node:fs`: the bridge
 * only writes; reads and reconciliation live in the serve layer.
 */

export interface PromptLedgerInFlightRecord {
  v: 1;
  promptId: string;
  state: 'in_flight';
  at: number;
  /**
   * Dispatch marker: uuid of the transcript's last record at admission.
   * The transcript is append-only, so any record after this marker was
   * written after admission — reconciliation requires at least one visible
   * write beyond it before attributing an outcome (an identity check immune
   * to clock skew; absent for records written before the marker existed).
   */
  tailUuid?: string;
}

export type PromptLedgerTerminalState =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted';

export interface PromptLedgerTerminalRecord {
  v: 1;
  promptId: string;
  terminal: PromptLedgerTerminalState;
  /** Machine-readable cause: `daemon_shutdown`, `channel_closed`, `daemon_lost`, ... */
  code?: string;
  stopReason?: string;
  at: number;
}

export type PromptLedgerRecord =
  | PromptLedgerInFlightRecord
  | PromptLedgerTerminalRecord;

export function isPromptLedgerTerminalRecord(
  record: PromptLedgerRecord,
): record is PromptLedgerTerminalRecord {
  return 'terminal' in record;
}

/** Append one record as a JSON line. Synchronous by design: the
 * daemon-shutdown flush must land before process exit. Throws on I/O
 * failure; callers own the best-effort policy. */
export function appendPromptLedgerRecord(
  filePath: string,
  record: PromptLedgerRecord,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  sealTornTailSync(filePath);
  // Owner-only at creation (mode applies only to the creating call):
  // the ledger holds per-prompt activity metadata and must follow the
  // transcript's 0o600 convention rather than the umask default.
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Seal a torn tail left by a crash mid-append: when the file is non-empty
 * and its last byte is not a newline, the next append would fuse with the
 * truncated line and the reader would drop BOTH records (the fused line
 * fails JSON parsing). A leading newline keeps the torn fragment droppable
 * and the new record intact. Missing files need no seal.
 */
function sealTornTailSync(filePath: string): void {
  let stats: Stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stats.size === 0) return;
  const fd = openSync(filePath, 'r');
  try {
    const lastByte = Buffer.alloc(1);
    const bytesRead = readSync(fd, lastByte, 0, 1, stats.size - 1);
    if (bytesRead === 1 && lastByte[0] !== 0x0a) {
      appendFileSync(filePath, '\n', 'utf8');
    }
  } finally {
    closeSync(fd);
  }
}

function coercePromptLedgerRecord(
  value: unknown,
): PromptLedgerRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const promptId = record['promptId'];
  const at = record['at'];
  if (record['v'] !== 1 || typeof promptId !== 'string') return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (record['state'] === 'in_flight') {
    const tailUuid = record['tailUuid'];
    return {
      v: 1,
      promptId,
      state: 'in_flight',
      ...(typeof tailUuid === 'string' && tailUuid.length > 0
        ? { tailUuid }
        : {}),
      at,
    };
  }
  const terminal = record['terminal'];
  if (
    terminal !== 'completed' &&
    terminal !== 'cancelled' &&
    terminal !== 'error' &&
    terminal !== 'interrupted'
  ) {
    return undefined;
  }
  const code = record['code'];
  const stopReason = record['stopReason'];
  return {
    v: 1,
    promptId,
    terminal,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof stopReason === 'string' ? { stopReason } : {}),
    at,
  };
}

/** Options for {@link readPromptLedgerRecords}. */
export interface ReadPromptLedgerOptions {
  /**
   * Read at most this many trailing bytes instead of the whole file. The
   * first line of the window is dropped (the window start can tear a line
   * in half), so callers must size the window for the records they need.
   * Used by the per-request load path to avoid reading and parsing the
   * entire ledger of a long session.
   */
  tailBytes?: number;
}

/**
 * Read all records in file order. A torn tail (crash mid-append) or any
 * malformed line is dropped rather than fatal: the ledger is advisory
 * evidence, and reconciliation treats "unreadable" the same as "absent"
 * (fail-closed). Only ENOENT maps to an empty ledger; other I/O errors
 * propagate to the caller.
 *
 * With `options.tailBytes`, files larger than the window are read from the
 * tail only; the first line inside the window is always dropped because the
 * window start may fall mid-line.
 */
export function readPromptLedgerRecords(
  filePath: string,
  options?: ReadPromptLedgerOptions,
): PromptLedgerRecord[] {
  let contents: string;
  let dropFirstLine = false;
  try {
    const tailBytes = options?.tailBytes;
    if (tailBytes === undefined) {
      contents = readFileSync(filePath, 'utf8');
    } else {
      const size = statSync(filePath).size;
      if (size <= tailBytes) {
        contents = readFileSync(filePath, 'utf8');
      } else {
        const fd = openSync(filePath, 'r');
        try {
          const buffer = Buffer.alloc(tailBytes);
          const bytesRead = readSync(
            fd,
            buffer,
            0,
            tailBytes,
            size - tailBytes,
          );
          // A UTF-8 sequence torn at the window start is replaced with
          // U+FFFD by toString; that torn first line is dropped below anyway.
          contents = buffer.subarray(0, bytesRead).toString('utf8');
          dropFirstLine = true;
        } finally {
          closeSync(fd);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: PromptLedgerRecord[] = [];
  const lines = contents.split('\n');
  for (let i = dropFirstLine ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = coercePromptLedgerRecord(parsed);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/**
 * promptIds whose latest record is still `in_flight` (no terminal followed),
 * in first-appearance order. Later records supersede earlier ones for the
 * same promptId, so a reconciliation append or a duplicate write is
 * naturally idempotent on the read side.
 */
export function danglingInFlightPromptIds(
  records: readonly PromptLedgerRecord[],
): string[] {
  const latest = new Map<string, PromptLedgerRecord>();
  for (const record of records) {
    latest.set(record.promptId, record);
  }
  const dangling: string[] = [];
  for (const [promptId, record] of latest) {
    if (!isPromptLedgerTerminalRecord(record)) dangling.push(promptId);
  }
  return dangling;
}

/** Cap for terminal records embedded in a load response. */
const PROMPT_TERMINALS_RESPONSE_LIMIT = 64;

/** The most recent terminal records (file order), up to the response cap. */
export function recentPromptTerminalRecords(
  records: readonly PromptLedgerRecord[],
): PromptLedgerTerminalRecord[] {
  const terminals = records.filter(isPromptLedgerTerminalRecord);
  return terminals.length <= PROMPT_TERMINALS_RESPONSE_LIMIT
    ? terminals
    : terminals.slice(-PROMPT_TERMINALS_RESPONSE_LIMIT);
}
