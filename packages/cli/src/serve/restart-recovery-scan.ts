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
  type PromptLedgerTerminalRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import type { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';

const LEDGER_TAIL_BYTES = 64 * 1024;
const TERMINAL_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const LIFECYCLE_INTERRUPTION_CODES = new Set([
  'daemon_shutdown',
  'daemon_lost',
  'channel_closed',
]);

export const DEFAULT_RESTART_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_RESTART_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RESTART_RECOVERY_ITEMS = 200;

export interface RestartRecoveryItem {
  sessionId: string;
  /** ISO timestamp of the newest ledger record in the scan tail. */
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
  /** Maximum returned items; callers may enumerate before their own filtering. */
  limit?: number;
  /**
   * Optional memory-only live check. A session with an active or queued prompt
   * is running now, not interrupted by a restart, so it is omitted.
   */
  isSessionLiveActive?: (sessionId: string) => boolean;
}

/**
 * Classifies one session from the latest record of each prompt in its ledger.
 *
 * A session with any prompt still `in_flight` is interrupted even when another
 * prompt's terminal was appended later. Otherwise the newest terminal decides.
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
  let newestInFlight: PromptLedgerRecord | undefined;
  let newestTerminal: PromptLedgerTerminalRecord | undefined;
  let newestAt = -Infinity;
  const seenPromptIds = new Set<string>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (seenPromptIds.has(record.promptId)) continue;
    seenPromptIds.add(record.promptId);
    // `at` is only checked for finiteness by the ledger reader; a value
    // outside the Date range cannot produce an ISO timestamp.
    if (!Number.isFinite(record.at) || Math.abs(record.at) > 8.64e15) {
      continue;
    }
    newestAt = Math.max(newestAt, record.at);
    if (!isPromptLedgerTerminalRecord(record)) {
      newestInFlight ??= record;
    } else {
      newestTerminal ??= record;
    }
  }

  if (newestAt === -Infinity) return { kind: 'missing' };
  if (sinceMs !== undefined && newestAt < sinceMs) return { kind: 'settled' };

  if (newestInFlight !== undefined) {
    return {
      kind: 'interrupted',
      interruption: 'in_flight',
      lastActivityAt: new Date(newestAt).toISOString(),
    };
  }
  if (newestTerminal === undefined) return { kind: 'missing' };

  const code = newestTerminal.code;
  const interruptedByLifecycle =
    newestTerminal.terminal === 'error' &&
    typeof code === 'string' &&
    LIFECYCLE_INTERRUPTION_CODES.has(code);
  if (newestTerminal.terminal !== 'interrupted' && !interruptedByLifecycle) {
    return { kind: 'settled' };
  }
  return {
    kind: 'interrupted',
    interruption:
      typeof code === 'string' && TERMINAL_CODE_PATTERN.test(code)
        ? code
        : 'interrupted',
    lastActivityAt: new Date(newestAt).toISOString(),
  };
}

/**
 * Lists sessions with a prompt whose latest ledger record did not settle.
 *
 * Reads only the bounded tail of each prompt ledger. The ledger is written at
 * admission and at every terminal, so reducing it by prompt id tells a crash
 * (`in_flight`), an interrupted turn, or a settled turn apart. Sessions with
 * no readable evidence are skipped rather than guessed.
 */
export function scanRestartRecoveries({
  sessionService,
  sessionIds,
  sinceMs,
  limit = MAX_RESTART_RECOVERY_ITEMS,
  isSessionLiveActive,
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
    if (isSessionLiveActive?.(sessionId)) continue;

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
  const truncated = items.length > limit;
  return {
    items: truncated ? items.slice(0, limit) : items,
    truncated,
  };
}
