/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  buildApiHistoryFromConversation,
  detectTurnInterruption,
  SessionService,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
  type ChatRecord,
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
    transcriptTailUuid(sessionId) {
      return readTranscriptTailUuid(
        sessionService.getSessionTranscriptPath(sessionId),
      );
    },
  };
}

/**
 * Byte window for the dispatch-marker read: only the trailing record
 * matters, so the hot admission path never reads (or JSON-parses) a whole
 * multi-megabyte transcript. A final record larger than the window (or a
 * torn tail) simply yields no marker — admission and reconciliation both
 * degrade to the marker-less evidence chain.
 */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * Uuid of the transcript's last record, or `undefined` without readable
 * evidence (missing file, empty file, torn/corrupt tail). Best-effort by
 * contract: any failure maps to "no marker", never to an admission error.
 */
export function readTranscriptTailUuid(
  transcriptPath: string,
): string | undefined {
  let contents: string;
  try {
    const size = statSync(transcriptPath).size;
    if (size === 0) return undefined;
    const windowBytes = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(windowBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buffer, 0, windowBytes, size - windowBytes);
    } finally {
      closeSync(fd);
    }
    contents = buffer.toString('utf8');
  } catch {
    return undefined;
  }
  const lines = contents.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    try {
      const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
      return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined;
    } catch {
      return undefined; // Torn or corrupt final line: no reliable marker.
    }
  }
  return undefined;
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
 * Attribution is guarded four ways (each mirrors a concrete wrong-terminal
 * probe; see the design doc): the dispatch marker (when admission recorded
 * the transcript tail uuid, the target must have written a visible record
 * beyond it — an identity check immune to clock skew), the temporal
 * evidence measured on the same projection the verdict uses, a compression
 * checkpoint after the target's admission voiding the evidence chain, and
 * under FIFO admission the visible tail being strictly newer than every
 * other prompt's settled terminal (a same-millisecond tail, and any tail
 * behind a `prompt_deadline_exceeded` terminal whose wedged turn may still
 * be writing, cannot be attributed).
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
  const snapshotLength = records.length;
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
  const messages = resumed.conversation.messages;
  // Dispatch marker evidence: when admission recorded the transcript tail
  // uuid, the target's turn must have written at least one visible record
  // beyond it (the transcript is append-only, so anything after the marker
  // postdates admission). This is an identity/ordering check immune to
  // clock skew; a marker missing from the projection, or present with no
  // visible write after it, fails closed.
  const admissionMarker = targetAdmission.tailUuid;
  let markerIndex = -1;
  if (admissionMarker !== undefined) {
    markerIndex = messages.findIndex(
      (record) => record.uuid === admissionMarker,
    );
    let wroteAfterMarker = false;
    for (let i = markerIndex + 1; i < messages.length; i++) {
      const record = messages[i];
      if (record === undefined || record.type === 'system') continue;
      if (!record.message || record.subtype === 'realtime_message') continue;
      wroteAfterMarker = true;
      break;
    }
    if (markerIndex < 0 || !wroteAfterMarker) return;
  }
  // Projection-consistent temporal evidence: only records that actually
  // enter the api history the verdict runs on can prove the target's turn
  // wrote anything. System records (ui_telemetry, custom_title, ...) stay
  // outside the projection, and a compression candidate replaces it wholesale
  // (mirrors SessionApiHistoryAccumulator, packages/core). Measuring the
  // last write on the raw stream instead would let evidence that the
  // verdict never sees pass the guard.
  let lastVisibleWriteMs = NaN;
  let compressedAfterAdmission = false;
  for (let idx = 0; idx < messages.length; idx++) {
    const record = messages[idx];
    const writeMs = Date.parse(record.timestamp);
    if (record.type === 'system') {
      if (isCompressionResetRecord(record)) {
        // Marker-bearing admissions order by position: anything past the
        // marker postdates admission, so a backward clock step cannot hide
        // a post-admission compression. Marker-less admissions fall back
        // to the wall clock.
        const afterAdmission =
          admissionMarker !== undefined
            ? idx > markerIndex
            : Number.isFinite(writeMs) && writeMs >= targetAdmission.at;
        if (afterAdmission) compressedAfterAdmission = true;
      }
      continue;
    }
    if (!record.message || record.subtype === 'realtime_message') continue;
    if (Number.isFinite(writeMs)) lastVisibleWriteMs = writeMs;
  }
  // FIFO evidence: under FIFO admission the target's turn can only start
  // after every other prompt settled, so any visible tail not strictly
  // newer than some other prompt's terminal belongs to that prompt's turn
  // — a queued prompt that never dispatched and a stale dangling left by a
  // restore path that skips reconciliation both fail here. Equality is
  // vetoed as well: both clocks are 1 ms-granularity `Date.now()` reads, so
  // a same-millisecond tail cannot be attributed with confidence.
  let lastOtherTerminalAt = 0;
  for (const record of records) {
    if (isPromptLedgerTerminalRecord(record) && record.promptId !== target) {
      // A `prompt_deadline_exceeded` terminal does not fence its turn's
      // writes: the deadline path releases the FIFO while the wedged agent
      // is explicitly allowed to keep streaming (DAEMON-003), so stale
      // writes postdating the terminal could be attributed to the target.
      if (record.code === 'prompt_deadline_exceeded') return;
      lastOtherTerminalAt = Math.max(lastOtherTerminalAt, record.at);
    }
  }
  if (
    compressedAfterAdmission ||
    !Number.isFinite(lastVisibleWriteMs) ||
    lastVisibleWriteMs <= targetAdmission.at ||
    lastVisibleWriteMs <= lastOtherTerminalAt
  ) {
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
  // TOCTOU fence: a prompt admitted while `loadSession` ran appended its
  // `in_flight` after the snapshot above, and the visible tail may now
  // belong to it — the verdict computed from the snapshot must not be
  // stamped onto the old dangling id. The ledger is append-only, so an
  // unchanged length proves no record landed during the window.
  let refetch: PromptLedgerRecord[];
  try {
    refetch = readPromptLedgerRecords(ledgerPath);
  } catch {
    return;
  }
  if (refetch.length !== snapshotLength) return;
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
 * Whether a system record resets the api history projection: a
 * `chat_compression` record carrying a `compressedHistory` payload (the
 * accumulator swaps the whole history for it). Kept inline instead of
 * importing `isApiHistoryCompressionCandidate` so this module stays inside
 * the cli package; the predicate mirrors that helper.
 */
function isCompressionResetRecord(record: ChatRecord): boolean {
  if (record.type !== 'system' || record.subtype !== 'chat_compression') {
    return false;
  }
  return Boolean(
    (record.systemPayload as { compressedHistory?: unknown } | undefined)
      ?.compressedHistory,
  );
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
