/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';
import {
  isPromptLedgerTerminalRecord,
  readPromptLedgerRecords,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import type { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';

const LEDGER_TAIL_BYTES = 64 * 1024;
const TERMINAL_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SHUTDOWN_INTERRUPTION_CODES = new Set(['daemon_shutdown', 'daemon_lost']);

export const DEFAULT_RESTART_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_RESTART_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RESTART_RECOVERY_ITEMS = 200;

export interface RestartRecoveryItem {
  sessionId: string;
  /** ISO timestamp of the newest ledger record for this session. */
  lastActivityAt: string;
  /**
   * `in_flight` for a crash before the terminal was persisted, otherwise the
   * terminal's `code` (`daemon_shutdown`, `daemon_lost`, ...), or
   * `interrupted` when the terminal carries no code.
   */
  interruption: string;
}

export interface RestartRecoveryScanResult {
  items: RestartRecoveryItem[];
  truncated: boolean;
}

export type RestartRecoveryState =
  | {
      kind: 'interrupted';
      interruption: string;
      lastActivityAt: string;
    }
  | { kind: 'settled' }
  | { kind: 'missing' };

export interface ScanRestartRecoveriesInput {
  sessionService: Pick<SessionService, 'getPromptLedgerPath'>;
  sessionIds: readonly string[];
  /** Only entries at or after this timestamp are returned. */
  sinceMs: number;
}

/**
 * Classifies one session from the newest record of its prompt ledger.
 *
 * `settled` covers a completed, cancelled, or unrelated errored turn and any
 * record older than `sinceMs`. `missing` means there is no readable evidence;
 * the caller must not guess an outcome from it.
 */
export function readRestartRecoveryState(
  ledgerPath: string,
  sinceMs?: number,
): RestartRecoveryState {
  let records: PromptLedgerRecord[];
  try {
    records = readPromptLedgerRecords(ledgerPath, {
      tailBytes: LEDGER_TAIL_BYTES,
    });
  } catch {
    return { kind: 'missing' };
  }
  const last = records[records.length - 1];
  if (last === undefined) return { kind: 'missing' };
  // `at` is only checked for finiteness by the ledger reader; a value
  // outside the Date range cannot produce an ISO timestamp.
  if (!Number.isFinite(last.at) || Math.abs(last.at) > 8.64e15) {
    return { kind: 'missing' };
  }
  if (sinceMs !== undefined && last.at < sinceMs) return { kind: 'settled' };
  if (isPromptLedgerTerminalRecord(last)) {
    const code = last.code;
    const interruptedByShutdown =
      last.terminal === 'error' &&
      typeof code === 'string' &&
      SHUTDOWN_INTERRUPTION_CODES.has(code);
    if (last.terminal !== 'interrupted' && !interruptedByShutdown) {
      return { kind: 'settled' };
    }
    return {
      kind: 'interrupted',
      interruption:
        typeof code === 'string' && TERMINAL_CODE_PATTERN.test(code)
          ? code
          : 'interrupted',
      lastActivityAt: new Date(last.at).toISOString(),
    };
  }
  return {
    kind: 'interrupted',
    interruption: 'in_flight',
    lastActivityAt: new Date(last.at).toISOString(),
  };
}

/**
 * Lists sessions whose newest prompt did not end in a settled turn.
 *
 * Reads only the bounded tail of each prompt ledger. The ledger is written at
 * admission and at every terminal, so the newest record is enough to tell a
 * crash (`in_flight`), an interrupted turn, or a settled turn apart. Sessions
 * with no readable evidence are skipped rather than guessed.
 */
export function scanRestartRecoveries({
  sessionService,
  sessionIds,
  sinceMs,
}: ScanRestartRecoveriesInput): RestartRecoveryScanResult {
  const items: RestartRecoveryItem[] = [];
  for (const sessionId of sessionIds) {
    const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(ledgerPath).mtimeMs;
    } catch {
      continue;
    }
    // The ledger is append-only, so its mtime bounds every record in it.
    if (mtimeMs < sinceMs) continue;

    const state = readRestartRecoveryState(ledgerPath, sinceMs);
    if (state.kind !== 'interrupted') continue;

    items.push({
      sessionId,
      lastActivityAt: state.lastActivityAt,
      interruption: state.interruption,
    });
  }

  items.sort(
    (left, right) =>
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
  );
  const truncated = items.length > MAX_RESTART_RECOVERY_ITEMS;
  return {
    items: truncated ? items.slice(0, MAX_RESTART_RECOVERY_ITEMS) : items,
    truncated,
  };
}
