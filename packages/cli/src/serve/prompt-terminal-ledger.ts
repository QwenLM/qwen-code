/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
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
  // Fail closed on multiple dangling prompts. Under FIFO admission the
  // visible transcript tail belongs to the OLDEST running prompt, but with
  // several prompts dangling the tail's owner cannot be verified (the
  // queued ones never wrote a turn): synthesizing a terminal for any of
  // them — including the newest — could attribute an earlier prompt's turn
  // to the wrong id. They all stay `unknown`
  // (see docs/design/2026-08-19-prompt-terminal-ledger-design.md).
  if (dangling.length > 1) return;
  const target = dangling[0];
  if (target === undefined) return;
  // Attribution guard: skip the in_flight records of prompts that settled
  // (a terminal record exists for them) and require the last remaining
  // in_flight record to be target's own admission. In `[A if, B if,
  // B cancelled]` (B queued then cancelled while A still ran) the tail
  // belongs to A even though B's in_flight is the later record — the naive
  // "last in_flight must match target" guard wrongly vetoed A with B's
  // settled in_flight.
  const settledPromptIds = new Set(
    records.filter(isPromptLedgerTerminalRecord).map((r) => r.promptId),
  );
  let targetAdmission: PromptLedgerInFlightRecord | undefined;
  for (const record of records) {
    if (
      !isPromptLedgerTerminalRecord(record) &&
      !settledPromptIds.has(record.promptId)
    ) {
      targetAdmission = record;
    }
  }
  if (targetAdmission === undefined || targetAdmission.promptId !== target) {
    return;
  }
  let resumed: ResumedSessionData | undefined;
  try {
    resumed = await sessionService.loadSession(sessionId);
  } catch {
    return; // Degraded transcript: fail-closed.
  }
  if (resumed === undefined) return;
  // Temporal evidence: the transcript's last write must postdate target's
  // admission (at or after the in_flight `at`). A dangling prompt that
  // never produced a transcript write (still queued when the daemon died)
  // leaves the tail owned by an earlier settled turn — fail closed instead
  // of attributing that turn to the target. `ChatRecord.timestamp` is the
  // record's creation time, so any record written under the target's turn
  // satisfies the check.
  const messages = resumed.conversation.messages;
  const lastMessage = messages[messages.length - 1];
  const lastWriteMs =
    lastMessage === undefined ? NaN : Date.parse(lastMessage.timestamp);
  if (!Number.isFinite(lastWriteMs) || lastWriteMs < targetAdmission.at) {
    return;
  }
  const apiHistory = buildApiHistoryFromConversation(resumed.conversation);
  const historyTail = apiHistory.slice(-TURN_INTERRUPTION_HISTORY_TAIL_COUNT);
  const verdict = detectTurnInterruption(historyTail);
  // Id-less tool-call guard: `detectTurnInterruption` ignores functionCalls
  // without an id (they cannot be paired on the wire), but reconciliation
  // needs no wire pairing — a model tail holding ANY functionCall means the
  // daemon died mid tool-run, so upgrade the verdict to interrupted
  // (`interrupted_turn` semantics).
  const interrupted =
    verdict.kind !== 'none' || tailHoldsAnyFunctionCall(historyTail);
  const record: PromptLedgerTerminalRecord = interrupted
    ? {
        v: 1,
        promptId: target,
        terminal: 'interrupted',
        code: 'daemon_lost',
        at: Date.now(),
      }
    : {
        v: 1,
        promptId: target,
        terminal: 'completed',
        stopReason: 'reconstructed_from_transcript',
        at: Date.now(),
      };
  try {
    appendPromptLedgerRecord(ledgerPath, record);
  } catch {
    // Best-effort: the dangling prompt stays unknown.
  }
}

/**
 * Whether the history tail's last entry is a model turn holding at least
 * one `functionCall` part (id or not). See the id-less tool-call guard in
 * {@link reconcileDanglingPromptTerminals}.
 */
function tailHoldsAnyFunctionCall(history: Content[]): boolean {
  const last = history[history.length - 1];
  if (last?.role !== 'model') return false;
  return (last.parts ?? []).some((part) => part.functionCall !== undefined);
}

/**
 * Tail byte window for load-response reads. Records are ~150 bytes and the
 * response caps at 64 terminals, so 256 KiB holds hundreds of terminals even
 * with in_flight lines interleaved — the response is the full trailing
 * window for any realistic session while the per-load hot path never reads
 * (or JSON-parses) a whole multi-megabyte ledger. Sessions whose ledger
 * outgrows the window return a best-effort subset, which the response
 * contract already allows.
 */
const RECENT_TERMINALS_TAIL_BYTES = 256 * 1024;

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
      readPromptLedgerRecords(sessionService.getPromptLedgerPath(sessionId), {
        tailBytes: RECENT_TERMINALS_TAIL_BYTES,
      }),
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
