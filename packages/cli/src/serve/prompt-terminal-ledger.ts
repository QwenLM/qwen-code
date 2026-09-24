/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  buildSessionHistoryFromConversation,
  detectTurnInterruption,
  effectiveHistoryEnd,
  SessionService,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
  type ChatRecord,
  type ResumedSessionData,
  type SlashCommandRecordPayload,
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
  let lastVisibleNonSystem: ChatRecord | undefined;
  let compressedAfterAdmission = false;
  let localCommandCompleted = false;
  // Marker-bearing admissions order by position: anything past the marker
  // postdates admission, so a backward clock step cannot hide a
  // post-admission write. Marker-less admissions fall back to the wall clock.
  const admissionAt = targetAdmission.at;
  const isAfterAdmission = (idx: number, writeMs: number): boolean =>
    admissionMarker !== undefined
      ? idx > markerIndex
      : Number.isFinite(writeMs) && writeMs >= admissionAt;
  for (let idx = 0; idx < messages.length; idx++) {
    const record = messages[idx];
    const writeMs = Date.parse(record.timestamp);
    if (record.type === 'system') {
      if (isCompressionResetRecord(record)) {
        if (isAfterAdmission(idx, writeMs)) compressedAfterAdmission = true;
      } else if (
        !localCommandCompleted &&
        isAfterAdmission(idx, writeMs) &&
        isLocalSlashCommandResult(record, lastVisibleNonSystem)
      ) {
        // A LOCALLY handled slash command (`/help`, `/docs`, `/export md`, ...)
        // completes without ever reaching the model: `Session.prompt()` records
        // the prompt as an ordinary user message, the command writes a
        // `system` / `slash_command` `phase: 'result'` record, and
        // `SessionApiHistoryAccumulator` pops the user entry back out of the
        // projection (session-api-history.test.ts asserts the projection is
        // `[]` for exactly these commands). The verdict below therefore reads
        // `none` while the last visible non-system write is still
        // `type: 'user'` — the result record is the only completion evidence
        // this shape has, so recognise it here instead of leaving the promptId
        // permanently `unknown` (the ledger is append-only and
        // `settledPromptIds` filters it, so nothing would ever resolve it).
        localCommandCompleted = true;
      }
      continue;
    }
    if (!record.message || record.subtype === 'realtime_message') continue;
    // Entering the projection is necessary but not sufficient: the record also
    // has to be the target turn's OWN write. A system-injected background
    // notification is not — `createNotificationRecord`
    // (packages/core/src/services/chatRecordingService.ts) stamps
    // `provenance: 'system'` on a user-role record the daemon persists BEFORE
    // the automatic turn runs, and it does enter the projection. Counting one
    // as evidence lets a notification-only post-admission tail pass
    // attribution for a prompt that never dispatched, and what the classifier
    // then sees is whatever the PREVIOUS turn left behind once the
    // notification is trimmed: a dangling `functionCall` there upgrades the
    // verdict, so a wrong `interrupted / daemon_lost` terminal is appended.
    // (When the previous turn ended in model text instead, the tail reads
    // `none` and the provenance-bound completion guard below vetoes the shape
    // on its own — so this skip is what keeps the ATTRIBUTION direction
    // honest, not what prevents that second shape.) Everything a prompt's own
    // turn writes is `real_user` / `assistant_output` / `tool_result`
    // (`createBaseRecord`), so this skip can only veto the notification/cron
    // family. The verdict's tail is deliberately NOT trimmed here — the
    // classifier owns that trim (`effectiveHistoryEnd` below).
    if (record.provenance === 'system') continue;
    if (Number.isFinite(writeMs)) lastVisibleWriteMs = writeMs;
    lastVisibleNonSystem = record;
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
  const { apiHistory, completedToolCallIds } =
    buildSessionHistoryFromConversation(resumed.conversation);
  // Trim BEFORE windowing: the bounded tail has to be cut from the
  // classifiable projection, not from the raw one. Slicing first lets a run of
  // trailing system-injected notifications fill the entire window — they are
  // unbounded, since `#persistDaemonBackgroundNotification` (packages/core
  // Session.ts) persists each one on enqueue and
  // `MAX_BACKGROUND_NOTIFICATION_QUEUE` bounds the PENDING queue, not the
  // persisted records. An all-notification window leaves the classifiable tail
  // empty while the attribution loop above, which walks the WHOLE transcript
  // rather than the window, still reports the model entry as the last visible
  // non-system write: detection reads `none` (`boundary >= end` with
  // `end === 0`), the id-less guard below has nothing to upgrade, and the
  // provenance-bound guard accepts that `assistant` tail — stamping
  // `completed` for a prompt that died mid tool-run. Cost is unchanged: the
  // window still holds at most TURN_INTERRUPTION_HISTORY_TAIL_COUNT entries.
  const classifiableEnd = effectiveHistoryEnd(apiHistory);
  const historyTail = apiHistory.slice(
    Math.max(0, classifiableEnd - TURN_INTERRUPTION_HISTORY_TAIL_COUNT),
    classifiableEnd,
  );
  const verdict = detectTurnInterruption(historyTail, completedToolCallIds);
  // Id-less tool-call guard: `detectTurnInterruption` ignores functionCalls
  // without an id (they cannot be paired on the wire), but reconciliation
  // needs no wire pairing — a model tail holding ANY functionCall means the
  // daemon died mid tool-run, so upgrade the verdict to interrupted
  // (`interrupted_turn` semantics).
  //
  // The guard reads the SAME tail the verdict read, which the trim-first
  // window above now guarantees by construction: no trailing notification can
  // hide the model entry from this guard while detection trims it away, the
  // both-miss-at-once shape that stamped a mid-tool-run death `completed`.
  const interrupted =
    verdict.kind !== 'none' || tailHoldsAnyFunctionCall(historyTail);
  // Provenance-bound completion guard. A `none` verdict rests on the
  // classifier's TEXT-SHAPE trim, which cannot tell a real prompt whose whole
  // text happens to be an envelope (pasted out of a transcript, or forwarded
  // verbatim by a channel/SDK client — `createBaseRecord` stamps it
  // `provenance: 'real_user'`, so the attribution loop above counts it as the
  // target's own write) from a system-injected one. Trimming that entry
  // exposes the PREVIOUS turn's model text as the tail, so `verdict.kind` is
  // `none` and `tailHoldsAnyFunctionCall` is false, and a `completed`
  // terminal would be synthesized for a prompt the model never answered —
  // then served by every later load, because the ledger is append-only and
  // `settledPromptIds` filters it. Only a model-facing write by the target's
  // own turn can certify completion, so bind the stamp to the authoritative
  // `provenance` signal instead of to the shape-derived verdict.
  //
  // `tool_result` is accepted alongside `assistant` for the GOAL-BOUNDARY
  // shape only. `boundary >= end` in `detectTurnInterruption` requires the
  // closing call id to be in `completedToolCallIds`, and that set has exactly
  // two producers — the `goal_turn_end` branch and the compression payload,
  // both in `packages/core/src/services/session-api-history.ts`. An ordinary
  // closed tool pair never reaches this guard: it classifies as
  // `interrupted_prompt` and takes the interrupted path above.
  //
  // A LOCALLY handled slash command is the one user-role tail that does prove
  // completion, and it is recognised from its own authoritative record (the
  // `slash_command` result the attribution loop matched above), not from the
  // shape of any text.
  const lastVisibleNonSystemType = lastVisibleNonSystem?.type;
  if (
    !interrupted &&
    lastVisibleNonSystemType !== 'assistant' &&
    lastVisibleNonSystemType !== 'tool_result' &&
    !localCommandCompleted
  ) {
    // Fail closed: a user-role tail with no local-command result cannot prove
    // the turn completed. The veto is silent — reconciliation runs in the
    // serve daemon, which binds no debug-log session (no `runWithDebugLogSession`
    // or `sessionIdContext` binding exists in `packages/cli/src/serve` or
    // `packages/acp-bridge`, and the agent child that constructs Configs is a
    // separate spawned process), so a `debug()` call here would be dropped
    // before writing. The observable consequence is the ledger itself: no
    // record is appended, so this promptId keeps reporting `unknown`.
    return;
  }
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
 * Whether `record` is the result half of a LOCALLY handled slash command
 * whose input is `previous`: the exact shape `SessionApiHistoryAccumulator`
 * pops out of the api history projection
 * (`packages/core/src/services/session-api-history.ts`). The payload is read
 * through core's exported `SlashCommandRecordPayload` (a type-only barrel
 * import, like `ChatRecord` above), so renaming or retyping any field named
 * below is a compile error here instead of a silent `undefined` comparison
 * that would leave `localCommandCompleted` false forever — and, the ledger
 * being append-only, every later load of that session reporting `unknown`.
 *
 * The CONDITIONS stay mirrored rather than shared: sharing them means exporting
 * a predicate from core and handing it the accumulator's notion of `previous`
 * (`lastMaterialRecord`, which does NOT skip `provenance: 'system'` records and
 * is cleared after a pop), whereas this loop passes `lastVisibleNonSystem`
 * (which skips them and is never cleared) — wiring the wrong one through would
 * make a notification-interleaved ordering pop in one module and not the
 * other. Drift is asymmetric, and only one direction is safe: if the
 * accumulator STOPS popping a shape, that shape's user entry stays in the
 * projection, the verdict classifies it, and this predicate's answer no longer
 * matters. If it STARTS popping one, or relaxes a condition, the projection
 * loses the user entry while this mirror returns false, so the completion guard
 * vetoes and that command's promptId stays `unknown` — a MISSING terminal, the
 * failure this module is allowed to have, never a wrong one.
 */
function isLocalSlashCommandResult(
  record: ChatRecord,
  previous: ChatRecord | undefined,
): boolean {
  if (record.subtype !== 'slash_command') return false;
  const payload = record.systemPayload as SlashCommandRecordPayload | undefined;
  const items = payload?.outputHistoryItems;
  const parts = previous?.message?.parts;
  const first = parts?.[0];
  return (
    payload?.phase === 'result' &&
    payload.sentToModel !== true &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => item['type'] === 'assistant') &&
    previous?.type === 'user' &&
    previous.subtype === undefined &&
    previous.message?.role === 'user' &&
    parts?.length === 1 &&
    first !== undefined &&
    typeof first.text === 'string' &&
    Object.keys(first).length === 1 &&
    first.text === payload.rawCommand
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
