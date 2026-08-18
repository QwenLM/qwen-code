/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildApiHistoryFromConversation,
  detectTurnInterruption,
  SessionService,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
  type ResumedSessionData,
} from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  danglingInFlightPromptIds,
  isPromptLedgerTerminalRecord,
  readPromptLedgerRecords,
  recentPromptTerminalRecords,
  type PromptLedgerInFlightRecord,
  type PromptLedgerRecord,
  type PromptLedgerTerminalRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import type { PromptLedgerSink } from '@qwen-code/acp-bridge/bridgeOptions';
import type { BridgeRestoredSession } from '@qwen-code/acp-bridge/bridgeTypes';

/**
 * Serve-layer assembly of the bridge's ledger sink: the bridge only calls
 * `appendSync`, and this module owns the path layout via `SessionService`
 * (the ledger lives beside the transcript in the session storage dir).
 */
export function createPromptLedgerSink(
  workspaceCwd: string,
  sessionRuntimeBaseDir: string,
): PromptLedgerSink {
  const sessionService = new SessionService(workspaceCwd, {
    runtimeBaseDir: sessionRuntimeBaseDir,
  });
  return {
    appendSync(sessionId, record) {
      appendPromptLedgerRecord(
        sessionService.getPromptLedgerPath(sessionId),
        record,
      );
    },
  };
}

/**
 * Close the loop for prompts left `in_flight` by a daemon that died before
 * publishing (and persisting) their terminal. Called on the cold
 * `POST /session/:id/load` path after `bridge.loadSession` returned:
 *
 * - dangling detection on the ledger (a prompt with `in_flight` and no
 *   terminal);
 * - `detectTurnInterruption` on the transcript tail decides the outcome;
 * - the verdict is appended back to the ledger so the response (and every
 *   later load) sees it.
 *
 * Fail-closed invariant: when the outcome cannot be attributed with
 * confidence, nothing is appended and the prompt stays "unknown" — a
 * wrong terminal is never synthesized.
 */
export async function reconcileDanglingPromptTerminals(
  sessionService: SessionService,
  sessionId: string,
): Promise<void> {
  const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
  let records: PromptLedgerRecord[];
  try {
    records = readPromptLedgerRecords(ledgerPath);
  } catch {
    return; // Unreadable ledger: no evidence, fail-closed.
  }
  const dangling = danglingInFlightPromptIds(records);
  if (dangling.length === 0) return;
  // `detectTurnInterruption` judges the transcript's LAST turn, so only the
  // most recent dangling prompt can be attributed; earlier queued prompts
  // stay unknown by design
  // (see docs/design/2026-08-19-prompt-terminal-ledger-design.md).
  const target = dangling[dangling.length - 1];
  if (target === undefined) return;
  // Attribution guard: the transcript tail reflects the most recently
  // ADMITTED prompt, i.e. the prompt behind the ledger's last `in_flight`
  // record (under FIFO admission/settle order this is `target` itself —
  // the guard only fires on anomalous interleavings, where no verdict can
  // be attributed).
  let lastInFlight: PromptLedgerInFlightRecord | undefined;
  for (const record of records) {
    if (!isPromptLedgerTerminalRecord(record)) lastInFlight = record;
  }
  if (lastInFlight === undefined || lastInFlight.promptId !== target) return;
  let resumed: ResumedSessionData | undefined;
  try {
    resumed = await sessionService.loadSession(sessionId);
  } catch {
    return; // Degraded transcript: fail-closed.
  }
  if (resumed === undefined) return;
  const apiHistory = buildApiHistoryFromConversation(resumed.conversation);
  const verdict = detectTurnInterruption(
    apiHistory.slice(-TURN_INTERRUPTION_HISTORY_TAIL_COUNT),
  );
  const record: PromptLedgerTerminalRecord =
    verdict.kind === 'none'
      ? {
          v: 1,
          promptId: target,
          terminal: 'completed',
          stopReason: 'reconstructed_from_transcript',
          at: Date.now(),
        }
      : {
          v: 1,
          promptId: target,
          terminal: 'interrupted',
          code: 'daemon_lost',
          at: Date.now(),
        };
  try {
    appendPromptLedgerRecord(ledgerPath, record);
  } catch {
    // Best-effort: the dangling prompt stays unknown.
  }
}

/**
 * The most recent ledger terminals for the load response, or `undefined`
 * when there is no ledger evidence (field omitted entirely — old clients
 * and no-ledger sessions see the exact pre-existing response shape).
 */
export function readRecentPromptTerminals(
  sessionService: SessionService,
  sessionId: string,
): PromptLedgerTerminalRecord[] | undefined {
  try {
    const terminals = recentPromptTerminalRecords(
      readPromptLedgerRecords(sessionService.getPromptLedgerPath(sessionId)),
    );
    return terminals.length > 0 ? terminals : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach `promptTerminals` to a load response. Kept as a wrapper (rather
 * than mutating the bridge's `BridgeRestoredSession` type) so the serve
 * layer owns this response extension alone.
 */
export function withPromptTerminals<T extends BridgeRestoredSession>(
  session: T,
  terminals: readonly PromptLedgerTerminalRecord[] | undefined,
): T | (T & { promptTerminals: PromptLedgerTerminalRecord[] }) {
  if (terminals === undefined || terminals.length === 0) return session;
  return { ...session, promptTerminals: [...terminals] };
}
