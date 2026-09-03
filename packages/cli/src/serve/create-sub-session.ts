/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-host handler for sub-session spawn requests.
 *
 * A child sends a `create-sub-session` `extMethod` request UP to the daemon (see
 * `BridgeOptions.onCreateSubSession`) — either from the `create_sub_session` tool
 * inside an agent turn, or from the ACP session's `isolated` scheduled-task
 * dispatch. This handler spawns a FRESH top-level sub-session, runs the prompt in
 * it (`spawnOrAttach` thread scope → `sendPrompt`), and RETURNS a result.
 *
 * Completion modes:
 *  - `'sent'`      — dispatch the prompt and return `{ sessionId }` immediately;
 *                    the sub-session keeps running and is idle-reaped later.
 *                    A background event-stream subscription holds the concurrency
 *                    slot until the turn finishes (or `stop()` aborts it), so the
 *                    per-caller cap stays meaningful for fire-and-forget runs.
 *                    Live Voice launchers additionally deliver a completion
 *                    notification to the parent session, triggering an automatic
 *                    follow-up turn. Other callers retain fire-and-forget behavior.
 *  - `'first-turn'`— subscribe to the sub-session's event stream, accumulate its
 *                    `agent_message_chunk` text until `turn_complete`/`turn_error`
 *                    (correlated on `promptId`), and return it. `sendPrompt`'s
 *                    promise only carries `stopReason` (no text), so the result
 *                    must come from the stream. `stop()` aborts the subscription
 *                    via a composed `AbortSignal`; the sub-session's turn itself
 *                    is NOT cancelled (sendPrompt has no abort seam) and will
 *                    complete or be idle-reaped independently.
 *
 * The sub-session is fire-and-forget w.r.t. lifecycle: it is NOT kept resident,
 * so once idle the bridge's reaper closes it; its transcript persists.
 */

import { randomUUID } from 'node:crypto';
import {
  createDebugLogger,
  escapeXml,
  SessionService,
  Storage,
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import type {
  AcpSessionBridge,
  BridgeBackgroundNotification,
  BridgeSession,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  CreateSubSessionInfo,
  CreateSubSessionResult,
} from '@qwen-code/acp-bridge/bridgeOptions';
import {
  isReservedStandaloneSessionSourceType,
  isScheduledTaskRunSource,
} from '@qwen-code/acp-bridge/sessionSource';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { StandaloneSessionService } from './conversations/standalone-session-service.js';
import { createSessionOrganizationService } from './session-organization-helpers.js';

type StandaloneSubSessionService = Pick<
  StandaloneSessionService,
  'createChildWithInitialPrompt' | 'resume' | 'continueSession' | 'delete'
>;

const log = createDebugLogger('SUB_SESSION');

/** Default per-caller ceiling on concurrent in-flight sub-sessions. A
 * `first-turn` request holds a slot until its turn finishes; parallel tool
 * calls from one caller must not spawn unbounded sub-sessions. Over the cap
 * the request is rejected (surfaced as the tool's error), never silently
 * dropped. Overridable via `serve.maxConcurrentSubSessionsPerCaller`. */
export const MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER = 16;

/**
 * Default ceiling on concurrent in-flight sub-sessions across ALL callers of
 * this workspace's launcher.
 *
 * The per-caller cap is keyed on `callerSessionId`, and the daemon can only
 * authenticate that id as "a session on this channel" — every session of a
 * workspace shares ONE child process, so nothing at the transport can prove
 * *which* of them issued the call. A child running attacker code could rotate
 * ids to open a fresh bucket per launch, or charge them to a sibling. This
 * bound does not depend on the id being honest: it holds whichever bucket the
 * launch is charged to. Overridable via
 * `serve.maxConcurrentSubSessionsTotal`.
 *
 * The default is kept below the bridge's default `maxSessions` (32): a finished sub-session
 * stays registered (idle) for up to `sessionIdleTimeoutMs`, so a total cap at
 * the session-table limit would make the next fan-out wave fail at bridge
 * admission instead of this cap, and starve interactive sessions of slots.
 */
export const MAX_CONCURRENT_SUB_SESSIONS_TOTAL = 24;

/** Wall-clock ceiling for `first-turn`: a hung sub-session turn must not block
 * the caller forever. On timeout we return whatever text accumulated so far. */
const FIRST_TURN_TIMEOUT_MS = 5 * 60_000;

/** Wall-clock ceiling for the sent-mode background drain. Generous enough for
 * long-running sub-sessions but prevents a hung turn from permanently consuming
 * a concurrency slot (the idle reaper may not fire if the sub-session is still
 * "actively" running from the daemon's perspective). */
const SENT_MODE_DRAIN_TIMEOUT_MS = 30 * 60_000;

/** Recovery only applies while this daemon process still owns the sent-mode
 * drain. A daemon restart loses that in-memory drain, so there is no completion
 * to redeliver until sent workers themselves gain a durable job registry. */
const RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS = 30 * 60_000;

const SENT_COMPLETION_DELIVERY_RETRY_MS = 100;
const SENT_COMPLETION_DELIVERY_MAX_RETRY_MS = 30_000;

/** Cap on returned first-turn text so a runaway sub-session can't flood the
 * caller's context. Excess is dropped with a truncation marker. */
const MAX_RESULT_CHARS = 32_000;

/** Agent-side validation applies to the fully serialized model text. */
const MAX_SENT_COMPLETION_MODEL_TEXT_CHARS = 32_768;

const SENT_COMPLETION_RESULT_TRUNCATION_MARKER = '\n[…result truncated]';

/** Cap on the session display name (a label, not the full prompt). */
const MAX_NAME_LENGTH = 60;

/** How many spawned sub-session ids the depth-1 gate remembers. Far above any
 * plausible live sub-session count (`maxSessions` defaults to 32), so eviction
 * only ever discards long-reaped sessions. */
export const MAX_TRACKED_SPAWNED_SESSIONS = 1024;

export interface SubSessionLauncher {
  /** The `onCreateSubSession` callback wired into the bridge. Returns a Promise
   * the child's tool awaits. */
  launch(info: CreateSubSessionInfo): Promise<CreateSubSessionResult>;
  /** Stop accepting new sub-sessions (daemon shutdown). Idempotent. */
  stop(): void;
}

export interface CreateSubSessionLauncherOptions {
  getBridge: () => AcpSessionBridge | undefined;
  getStandaloneSessionService?: () => StandaloneSubSessionService | undefined;
  boundWorkspace: string;
  runtimeBaseDir?: string;
  /** Return sent-mode completions to the parent as automatic follow-up turns.
   * Enabled only for the Live conversation runtime. */
  notifySentCompletion?: boolean;
  isolatedWorkspace?: {
    materializeDirectory(sessionId: string): Promise<string>;
    discardEmptyDirectory(sessionId: string): Promise<unknown>;
  };
  /** Per-request `first-turn` wall-clock timeout; defaults to
   * {@link FIRST_TURN_TIMEOUT_MS}. Exposed for tests. */
  firstTurnTimeoutMs?: number;
  /** Sent-mode background-drain ceiling; defaults to
   * {@link SENT_MODE_DRAIN_TIMEOUT_MS}. Exposed for tests. */
  sentModeDrainTimeoutMs?: number;
  /** Per-caller concurrency cap; defaults to
   * {@link MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER}. */
  maxConcurrentPerCaller?: number;
  /** Workspace-wide concurrency cap; defaults to
   * {@link MAX_CONCURRENT_SUB_SESSIONS_TOTAL}. */
  maxConcurrentTotal?: number;
}

type IsolatedWorkspace = NonNullable<
  CreateSubSessionLauncherOptions['isolatedWorkspace']
>;

/** A readable, control-char-free session name (the bridge's title guard rejects
 * control chars, silently dropping an unsanitized rename). Prefixed with a
 * thread glyph so sub-sessions are recognizable in the list. */
// Unicode Bidi_Control marks — ALM (U+061C), LRM/RLM (U+200E/200F), the
// embedding/override set (U+202A..U+202E), and the isolates (U+2066..U+2069): a
// Trojan-Source-style reordering defense for the session list, mirroring the
// scheduled-task session namer. Built from a string (not a literal regex) so no
// invisible control chars appear in the source.
const BIDI_CONTROL_MARKS = new RegExp(
  '[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

function subSessionName(label: string, includeThreadGlyph = true): string {
  const cleaned = stripTerminalControlSequences(label)
    .replace(BIDI_CONTROL_MARKS, '')
    .trim()
    .replace(/\s+/g, ' ');
  let short = cleaned;
  if (cleaned.length > MAX_NAME_LENGTH) {
    let cut = MAX_NAME_LENGTH - 1;
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
    short = `${cleaned.slice(0, cut)}…`;
  }
  return includeThreadGlyph ? `🧵 ${short}` : short;
}

function sentCompletionStatus(
  stopReason: string,
): 'completed' | 'failed' | 'cancelled' {
  if (stopReason === 'end_turn') return 'completed';
  if (stopReason === 'cancelled' || stopReason === 'shutdown') {
    return 'cancelled';
  }
  return 'failed';
}

function truncateCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return `${codePoints.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function escapeXmlWithinBudget(value: string, budget: number): string {
  if (budget <= 0) return '';
  const escapedCodePoints: string[] = [];
  let length = 0;
  let truncated = false;
  for (const codePoint of value) {
    const escaped = escapeXml(codePoint);
    if (length + escaped.length > budget) {
      truncated = true;
      break;
    }
    escapedCodePoints.push(escaped);
    length += escaped.length;
  }
  if (!truncated) return escapedCodePoints.join('');

  while (
    escapedCodePoints.length > 0 &&
    length + SENT_COMPLETION_RESULT_TRUNCATION_MARKER.length > budget
  ) {
    length -= escapedCodePoints.pop()!.length;
  }
  return `${escapedCodePoints.join('')}${
    SENT_COMPLETION_RESULT_TRUNCATION_MARKER.length <= budget - length
      ? SENT_COMPLETION_RESULT_TRUNCATION_MARKER
      : ''
  }`;
}

function buildSentCompletionNotification(
  sessionId: string,
  label: string,
  result: string,
  stopReason: string,
) {
  const status = sentCompletionStatus(stopReason);
  const boundedStopReason = truncateCodePoints(stopReason, 128);
  const statusText =
    status === 'completed'
      ? 'completed'
      : status === 'cancelled'
        ? 'was cancelled'
        : `failed (${boundedStopReason})`;
  const sessionLink = `[🧵 ${sessionId.slice(0, 8)}](qwen-session://${sessionId})`;
  const safeResult =
    result.trim() || `No text output (stopReason: ${stopReason}).`;
  const modelSessionId = truncateCodePoints(sessionId, 256);
  const modelLabel = truncateCodePoints(label, 256);
  const modelTextPrefix = [
    '<task-notification>',
    `<task-id>${escapeXml(modelSessionId)}</task-id>`,
    `<status>${status}</status>`,
    `<summary>Sub-session &quot;${escapeXml(modelLabel)}&quot; ${escapeXml(statusText)}.</summary>`,
    `<session-link>qwen-session://${escapeXml(modelSessionId)}</session-link>`,
    '<result>',
  ].join('');
  const modelTextSuffix = '</result></task-notification>';
  const resultBudget = Math.max(
    0,
    MAX_SENT_COMPLETION_MODEL_TEXT_CHARS -
      modelTextPrefix.length -
      modelTextSuffix.length,
  );
  const modelText = `${modelTextPrefix}${escapeXmlWithinBudget(
    safeResult,
    resultBudget,
  )}${modelTextSuffix}`;
  return {
    displayText: `Sub-session ${sessionLink} ${statusText}.`,
    modelText,
    taskId: sessionId,
    status,
    kind: 'agent' as const,
  };
}

function isBackgroundNotificationForTask(
  event: { type: string; data: unknown },
  taskId: string,
): boolean {
  if (event.type !== 'session_update') return false;
  const update = (
    event.data as
      | {
          update?: {
            _meta?: {
              source?: unknown;
              backgroundTask?: { taskId?: unknown };
            };
          };
        }
      | null
      | undefined
  )?.update;
  return (
    update?._meta?.source === 'background_notification' &&
    update._meta.backgroundTask?.taskId === taskId
  );
}

async function awaitRecoveredParentNotification(
  bridge: AcpSessionBridge,
  sessionId: string,
  notification: BridgeBackgroundNotification,
  lastEventId: number,
  eventEpoch: string,
  stopSignal: AbortSignal,
): Promise<boolean> {
  const timeoutAc = new AbortController();
  const timer = setTimeout(
    () => timeoutAc.abort(),
    RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS,
  );
  if (typeof timer.unref === 'function') timer.unref();
  const signal = AbortSignal.any([stopSignal, timeoutAc.signal]);
  let observedOwnNotification = false;

  try {
    for await (const event of bridge.subscribeEvents(sessionId, {
      lastEventId,
      epoch: eventEpoch,
      signal,
    })) {
      if (isBackgroundNotificationForTask(event, notification.taskId)) {
        observedOwnNotification = true;
      } else if (
        observedOwnNotification &&
        event.type === 'background_notification_turn_complete'
      ) {
        return true;
      }
    }
  } finally {
    clearTimeout(timer);
    timeoutAc.abort();
  }

  return false;
}

async function waitForSentCompletionRetry(
  signal: AbortSignal,
  attempt: number,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const delay = Math.min(
    SENT_COMPLETION_DELIVERY_RETRY_MS * 2 ** attempt,
    SENT_COMPLETION_DELIVERY_MAX_RETRY_MS,
  );
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function awaitSentCompletionAcceptance(
  bridge: AcpSessionBridge,
  parentSessionId: string,
  notification: BridgeBackgroundNotification,
  stopSignal: AbortSignal,
  deadline: number,
): Promise<'accepted' | 'missing'> {
  let lastError: unknown;
  let attempt = 0;
  while (!stopSignal.aborted) {
    try {
      const acknowledgement = await bridge.enqueueBackgroundNotification(
        parentSessionId,
        notification,
      );
      if (acknowledgement.accepted) return 'accepted';
    } catch (error) {
      if (error instanceof SessionNotFoundError) return 'missing';
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Parent ${parentSessionId} did not durably accept completion for sub-session ${notification.taskId}.`,
        lastError === undefined ? undefined : { cause: lastError },
      );
    }
    await waitForSentCompletionRetry(stopSignal, attempt);
    attempt += 1;
  }
  throw stopSignal.reason;
}

async function deliverSentCompletion(
  bridge: AcpSessionBridge,
  boundWorkspace: string,
  parentSessionId: string,
  notification: BridgeBackgroundNotification,
  stopSignal: AbortSignal,
  isolatedWorkspace?: IsolatedWorkspace,
  standaloneService?: StandaloneSubSessionService,
): Promise<void> {
  const deadline = Date.now() + RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS;
  const initialDelivery = await awaitSentCompletionAcceptance(
    bridge,
    parentSessionId,
    notification,
    stopSignal,
    deadline,
  );
  if (initialDelivery === 'accepted') return;

  if (standaloneService) {
    await standaloneService.resume(parentSessionId);
    let ownerBridge: AcpSessionBridge | undefined;
    let ownerSessionId = '';
    let lastEventId = 0;
    let eventEpoch = '';
    const recoveredDelivery = await standaloneService.continueSession(
      parentSessionId,
      async (runtime, canonicalSessionId) => {
        ownerBridge = runtime.bridge;
        ownerSessionId = canonicalSessionId;
        lastEventId = runtime.bridge.getSessionLastEventId(canonicalSessionId);
        eventEpoch = runtime.bridge.getSessionEventEpoch(canonicalSessionId);
        return awaitSentCompletionAcceptance(
          runtime.bridge,
          canonicalSessionId,
          notification,
          stopSignal,
          deadline,
        );
      },
    );
    if (recoveredDelivery === 'missing' || !ownerBridge || !ownerSessionId) {
      throw new SessionNotFoundError(parentSessionId);
    }
    void awaitRecoveredParentNotification(
      ownerBridge,
      ownerSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal,
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `did not reach an end-turn boundary; leaving recovery attachment for ` +
              `the idle reaper`,
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `could not be observed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
    return;
  }

  let restoredParent: BridgeSession | undefined;
  // Materialize before restore so the first synchronous operation after the
  // bridge registers the parent can reserve its prompt queue for relocation.
  // That keeps a concurrently arriving prompt behind the cwd change.
  const isolatedCwd = isolatedWorkspace
    ? await isolatedWorkspace.materializeDirectory(parentSessionId)
    : undefined;
  let materializedDirectoryUnused = isolatedCwd !== undefined;
  try {
    restoredParent = await bridge.resumeSession({
      sessionId: parentSessionId,
      workspaceCwd: boundWorkspace,
    });
    if (isolatedCwd !== undefined) {
      if (
        restoredParent.hasActivePrompt === true &&
        restoredParent.currentCwd !== isolatedCwd
      ) {
        throw new Error(
          'Active restored parent is outside its isolated conversation directory.',
        );
      }
      if (restoredParent.hasActivePrompt === true) {
        materializedDirectoryUnused = false;
      }
      if (restoredParent.hasActivePrompt !== true) {
        // Once relocation begins, retain the directory if the bridge throws: a
        // caller-facing timeout does not cancel the queued cwd change.
        materializedDirectoryUnused = false;
        const changed = await bridge.changeSessionCwd(parentSessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: 'live-conversation',
        });
        if (changed.newCwd !== isolatedCwd) {
          materializedDirectoryUnused = true;
          throw new Error(
            'Restored parent workspace directory relocation was rejected.',
          );
        }
        restoredParent.currentCwd = changed.newCwd;
      }
    }
    const lastEventId = bridge.getSessionLastEventId(parentSessionId);
    const eventEpoch = bridge.getSessionEventEpoch(parentSessionId);
    const recoveredDelivery = await awaitSentCompletionAcceptance(
      bridge,
      parentSessionId,
      notification,
      stopSignal,
      deadline,
    );
    if (recoveredDelivery === 'missing') {
      throw new SessionNotFoundError(parentSessionId);
    }

    // Keep the recovery registration until the ordinary idle reaper removes it.
    // `background_notification_turn_complete` is emitted just before the child
    // finishes its notification-drain cleanup, and another worker completion may
    // already be queued behind it. An immediate detach can therefore close the
    // only restored parent underneath either operation. The bridge reaper ignores
    // stale client registrations and provides the bounded cleanup path here.
    void awaitRecoveredParentNotification(
      bridge,
      parentSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal,
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `did not reach an end-turn boundary; leaving recovery attachment for ` +
              `the idle reaper`,
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `could not be observed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  } catch (error) {
    let recoveredParentClosed = false;
    if (restoredParent !== undefined) {
      try {
        if (restoredParent.hasActivePrompt === true) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId,
            );
          }
        } else if (restoredParent.attached) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId,
            );
          }
        } else {
          recoveredParentClosed = await bridge.killSession(
            restoredParent.sessionId,
            { requireZeroAttaches: true },
          );
        }
      } catch {
        recoveredParentClosed = false;
      }
    }
    if (
      isolatedWorkspace &&
      isolatedCwd !== undefined &&
      (recoveredParentClosed || materializedDirectoryUnused)
    ) {
      await isolatedWorkspace
        .discardEmptyDirectory(parentSessionId)
        .catch(() => {});
    }
    throw error;
  }
}

/** Accumulate the sub-session's first-turn text from its event stream, stopping
 * at `turn_complete`/`turn_error` for `promptId` (or a wall-clock timeout, or
 * an external shutdown signal from `stop()`). */
async function awaitFirstTurn(
  bridge: AcpSessionBridge,
  sessionId: string,
  promptId: string,
  lastEventId: number,
  timeoutMs: number,
  stopSignal?: AbortSignal,
): Promise<{ result: string; stopReason: string }> {
  const ac = new AbortController();
  // `ac.signal.aborted` cannot report whether the deadline passed: the `finally`
  // below aborts unconditionally to tear the subscription down, so by the time
  // the stopReason is computed the signal is always aborted. Record the timer
  // firing separately, or a stream that closes early (bridge teardown, WS drop)
  // is misreported as a 5-minute wall-clock timeout.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  // Compose: the subscription ends on timeout OR daemon shutdown, whichever
  // fires first. Without this, stop() cannot interrupt a first-turn await and
  // shutdown hangs for up to timeoutMs (5 min default).
  const composed = stopSignal
    ? AbortSignal.any([ac.signal, stopSignal])
    : ac.signal;

  let acc = '';
  let truncated = false;
  let stopReason: string | undefined;

  const appendChunk = (text: string): void => {
    if (truncated) return;
    if (acc.length + text.length > MAX_RESULT_CHARS) {
      // Surrogate-pair-safe: if the cut lands on a high surrogate, back up
      // one code unit so we don't emit a lone leading surrogate.
      let cut = Math.max(0, MAX_RESULT_CHARS - acc.length);
      if (cut > 0) {
        const code = text.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      }
      acc += text.slice(0, cut);
      truncated = true;
    } else {
      acc += text;
    }
  };

  try {
    for await (const e of bridge.subscribeEvents(sessionId, {
      lastEventId,
      signal: composed,
    })) {
      if (e.type === 'session_update') {
        const d = e.data as {
          update?: { sessionUpdate?: string; content?: { text?: string } };
        };
        if (
          d?.update?.sessionUpdate === 'agent_message_chunk' &&
          typeof d.update.content?.text === 'string'
        ) {
          appendChunk(d.update.content.text);
        }
      } else if (e.type === 'turn_complete') {
        const d = e.data as { promptId?: string; stopReason?: string };
        if (d?.promptId === promptId) {
          stopReason = d.stopReason ?? 'end_turn';
          break;
        }
      } else if (e.type === 'turn_error') {
        const d = e.data as { promptId?: string; message?: string };
        if (d?.promptId === promptId) {
          stopReason = 'error';
          if (d.message && !truncated) {
            const suffix = `${acc ? '\n' : ''}[turn error] ${d.message}`;
            if (acc.length + suffix.length <= MAX_RESULT_CHARS) {
              acc += suffix;
            } else {
              truncated = true;
            }
          }
          break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort(); // tear down the subscription on any exit
  }

  if (stopReason === undefined) {
    // Distinguish shutdown (stop() called) from timeout from bus-closure so the
    // caller can tell the difference between "daemon is going away", "the
    // sub-session turn didn't finish in time", and "the event stream ended
    // before the turn did".
    stopReason = stopSignal?.aborted
      ? 'shutdown'
      : timedOut
        ? 'timeout'
        : 'incomplete';
  }
  if (truncated) acc += '\n[…output truncated]';
  return { result: acc, stopReason };
}

export function createSubSessionLauncher(
  opts: CreateSubSessionLauncherOptions,
): SubSessionLauncher {
  const {
    getBridge,
    getStandaloneSessionService,
    boundWorkspace,
    runtimeBaseDir,
    notifySentCompletion = false,
    isolatedWorkspace,
  } = opts;
  const firstTurnTimeoutMs = opts.firstTurnTimeoutMs ?? FIRST_TURN_TIMEOUT_MS;
  const sentModeDrainTimeoutMs =
    opts.sentModeDrainTimeoutMs ?? SENT_MODE_DRAIN_TIMEOUT_MS;
  const maxConcurrentPerCaller =
    opts.maxConcurrentPerCaller ?? MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER;
  // Clamped to the tracked-id set size so the in-flight population can never
  // exceed it. This bounds concurrency, not the depth-1 gate: ids leave
  // `spawnedSessionIds` only by FIFO eviction past that cap (finished ids are
  // never removed), so once cumulative spawns pass it a still-alive id can
  // still be evicted and the gate degrades to best-effort.
  const maxConcurrentTotal = Math.min(
    opts.maxConcurrentTotal ?? MAX_CONCURRENT_SUB_SESSIONS_TOTAL,
    MAX_TRACKED_SPAWNED_SESSIONS,
  );
  const inflight = new Map<string, number>();
  // Ids of the sub-sessions this launcher spawned — the depth-1 gate reads it.
  // Insertion-ordered and evicted FIFO past the cap so a long-lived daemon
  // can't accumulate ids forever; an evicted id belongs to a sub-session old
  // enough to have been idle-reaped long ago.
  const spawnedSessionIds = new Set<string>();
  // Shared AbortController — stop() aborts it, tearing down every active
  // subscription (first-turn awaits AND sent-mode background drains). This
  // prevents shutdown from waiting up to 5 min per in-flight session.
  const stopAc = new AbortController();

  // Sum of `inflight`, tracked separately so the workspace-wide cap holds even
  // when a caller opens a fresh bucket per launch.
  let inflightTotal = 0;

  const release = (key: string): void => {
    const n = (inflight.get(key) ?? 1) - 1;
    if (n <= 0) inflight.delete(key);
    else inflight.set(key, n);
    inflightTotal = Math.max(0, inflightTotal - 1);
  };

  const rememberSpawned = (sessionId: string): void => {
    spawnedSessionIds.add(sessionId);
    while (spawnedSessionIds.size > MAX_TRACKED_SPAWNED_SESSIONS) {
      const oldest = spawnedSessionIds.values().next().value;
      if (oldest === undefined) break;
      spawnedSessionIds.delete(oldest);
    }
  };

  const launch = async (
    info: CreateSubSessionInfo,
  ): Promise<CreateSubSessionResult> => {
    if (stopAc.signal.aborted) {
      throw new Error(
        'The daemon is shutting down; cannot create a sub-session.',
      );
    }
    const bridge = getBridge();
    if (!bridge) {
      throw new Error('Session bridge is not available.');
    }

    // Depth-1 gate. Every daemon session wires a spawner, sub-sessions included,
    // and each gets its own bucket — so without this a sub-session can spawn
    // more, each of which spawns more (capⁿ), exhausting `maxSessions` from
    // one prompt. `callerSessionId` is required and authenticated at the
    // bridge (`ownsSession`), so it can neither be forged nor omitted to
    // sidestep this gate or the per-caller cap below.
    // The in-memory set catches children created by this launcher. The
    // persisted parent lineage catches the same child after a daemon restart,
    // when the launcher set is empty but the restored bridge entry has been
    // re-seeded from its transcript metadata.
    const caller = bridge.getSessionSummary(info.callerSessionId);
    const standalone = isReservedStandaloneSessionSourceType(caller.sourceType);
    const standaloneService = standalone
      ? getStandaloneSessionService?.()
      : undefined;
    if (standalone && !standaloneService) {
      throw new Error('Standalone session service is unavailable.');
    }
    if (
      spawnedSessionIds.has(info.callerSessionId) ||
      caller.parentSessionId !== undefined
    ) {
      throw new Error(
        'A sub-session cannot create further sub-sessions (nesting is capped ' +
          'at one level).',
      );
    }

    // Per-caller concurrency key. Always a real, bridge-authenticated session
    // id: an anonymous fallback (a per-launch UUID) would give every call its
    // own bucket, which is the same as having no cap at all.
    const key = info.callerSessionId;
    const current = inflight.get(key) ?? 0;
    if (current >= maxConcurrentPerCaller) {
      throw new Error(
        `Too many concurrent sub-sessions for this session ` +
          `(cap ${maxConcurrentPerCaller}); wait for one to finish.`,
      );
    }
    // Forge-proof backstop: the per-caller cap above trusts `callerSessionId`,
    // this one does not. See MAX_CONCURRENT_SUB_SESSIONS_TOTAL.
    if (inflightTotal >= maxConcurrentTotal) {
      throw new Error(
        `Too many concurrent sub-sessions in this workspace ` +
          `(cap ${maxConcurrentTotal}); wait for one to finish.`,
      );
    }
    inflight.set(key, current + 1);
    inflightTotal += 1;
    // Per-acquire idempotent release: prevents double-free when an error
    // propagates through both the inner finally (first-turn path) and the
    // outer catch. Without this, each failure loosens the cap by one slot;
    // repeated failures drive the counter below the real in-flight count
    // and over-admit concurrent sub-sessions past the documented cap.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release(key);
    };
    // Set after a successful spawnOrAttach; if a later step fails the launch
    // we roll this session back so it isn't orphaned (the slot was consumed and
    // the prompt may have been dispatched, but launch() reports failure).
    let spawnedSession: BridgeSession | undefined;
    let promptDispatched = false;

    try {
      const promptId = randomUUID();
      let lastEventId!: number;
      let turn!: ReturnType<AcpSessionBridge['sendPrompt']>;
      let promptAdmission: Promise<void> | undefined;
      let sub: BridgeSession;
      if (standalone) {
        const created = await standaloneService!.createChildWithInitialPrompt(
          {
            sessionId: randomUUID(),
            parentSessionId: info.callerSessionId,
            promptId,
            ...(info.model ? { modelServiceId: info.model } : {}),
          },
          info.prompt,
        );
        sub = created.session;
        lastEventId = created.initialPrompt.lastEventId;
        turn = created.initialPrompt.turn;
        promptDispatched = true;
      } else {
        sub = await bridge.spawnOrAttach({
          workspaceCwd: boundWorkspace,
          sessionScope: 'thread', // force a fresh top-level session, never attach
          // Record the caller as the sub-session's parent so the UI can link it
          // back. Persisted into the sub-session's transcript at spawn time.
          parentSessionId: info.callerSessionId,
          ...(info.sourceType ? { sourceType: info.sourceType } : {}),
          ...(info.sourceId ? { sourceId: info.sourceId } : {}),
          ...(info.model ? { modelServiceId: info.model } : {}),
        });
      }
      spawnedSession = sub;
      const sessionId = sub.sessionId;
      if (info.model && sub.modelApplied === false) {
        if (standalone) {
          try {
            await standaloneService!.delete([sessionId]);
          } catch (cleanupError) {
            log.debug(
              'sub-session: standalone model-selection rollback failed',
              sessionId,
              cleanupError,
            );
          }
        }
        throw new Error(`sub-session model selection failed: ${info.model}`);
      }
      if (isolatedWorkspace && !standalone) {
        const isolatedCwd =
          await isolatedWorkspace.materializeDirectory(sessionId);
        const changed = await bridge.changeSessionCwd(sessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: 'live-conversation',
        });
        if (changed.newCwd !== isolatedCwd) {
          throw new Error(
            'Sub-session workspace directory relocation was rejected.',
          );
        }
      }
      rememberSpawned(sessionId);

      try {
        bridge.updateSessionMetadata(sessionId, {
          // A per-run scheduled task child is titled like its manual-run
          // sibling (see the scheduled-task route): flat, no thread glyph.
          displayName: subSessionName(
            info.name ?? info.prompt,
            !isScheduledTaskRunSource(info),
          ),
          titleSource: 'auto',
        });
      } catch (err) {
        log.debug('sub-session: updateSessionMetadata failed', sessionId, err);
      }

      if (!standalone) {
        lastEventId = bridge.getSessionLastEventId(sessionId);
        let markPromptAdmitted!: () => void;
        promptAdmission = new Promise<void>((resolve) => {
          markPromptAdmitted = resolve;
        });
        turn = bridge.sendPrompt(
          sessionId,
          {
            sessionId,
            prompt: [{ type: 'text', text: info.prompt }],
          } as Parameters<AcpSessionBridge['sendPrompt']>[1],
          undefined,
          { promptId, onPromptAdmitted: markPromptAdmitted },
        );
        promptDispatched = true;
      }

      // The result comes from the event stream (turn_error surfaces failures);
      // swallow the promise so it can't raise an unhandled rejection, but log
      // the error so dispatch failures are not invisible.
      void turn.catch((err) => {
        log.debug('sub-session: sendPrompt rejected', sessionId, String(err));
      });

      if (isScheduledTaskRunSource(info) && promptAdmission) {
        await Promise.race([
          promptAdmission,
          turn.then(
            () => undefined,
            (err) =>
              Promise.reject(
                new Error(
                  `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
              ),
          ),
        ]);
      }

      if (info.groupId) {
        try {
          const assign = () =>
            createSessionOrganizationService(
              boundWorkspace,
            ).updateSessionOrganization(sessionId, {
              groupId: info.groupId,
              color: null,
            });
          if (runtimeBaseDir) {
            await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, assign);
          } else {
            await assign();
          }
          bridge.markSessionCatalogChanged();
        } catch (error) {
          writeStderrLine(
            `qwen serve: scheduled-task session ${sessionId} could not be assigned to group ${info.groupId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (info.completion === 'sent') {
        // Hold the concurrency slot until the sub-session's turn finishes
        // (or the daemon shuts down via stop(), or a wall-clock ceiling is
        // reached). Without this the cap is a no-op for sent mode — the
        // fire-and-forget path returns immediately and the slot releases
        // before the sub-session has done any work, letting a looping
        // isolated task exhaust the daemon's session pool.
        const drainAc = new AbortController();
        const drainSignal = AbortSignal.any([stopAc.signal, drainAc.signal]);
        void (async () => {
          try {
            let notification:
              | ReturnType<typeof buildSentCompletionNotification>
              | undefined;
            try {
              const turnError: Promise<never> = turn.then(
                () => new Promise<never>(() => {}),
                (err) =>
                  Promise.reject(
                    new Error(
                      `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                  ),
              );
              const completion = await Promise.race([
                awaitFirstTurn(
                  bridge,
                  sessionId,
                  promptId,
                  lastEventId,
                  sentModeDrainTimeoutMs,
                  drainSignal,
                ),
                turnError,
              ]);
              if (stopAc.signal.aborted) return;
              if (completion.stopReason === 'timeout') {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} drain timed out after ` +
                    `${Math.round(sentModeDrainTimeoutMs / 60_000)}min; releasing its ` +
                    `concurrency slot (the sub-session may still be running)`,
                );
              }
              if (notifySentCompletion) {
                notification = buildSentCompletionNotification(
                  sessionId,
                  subSessionName(info.name ?? info.prompt),
                  completion.result,
                  completion.stopReason,
                );
              }
            } catch (err) {
              if (stopAc.signal.aborted) return;
              if (!notifySentCompletion) return;
              const message = err instanceof Error ? err.message : String(err);
              notification = buildSentCompletionNotification(
                sessionId,
                subSessionName(info.name ?? info.prompt),
                message,
                'error',
              );
            }
            if (!notification) return;
            try {
              await deliverSentCompletion(
                bridge,
                boundWorkspace,
                info.callerSessionId,
                notification,
                stopAc.signal,
                isolatedWorkspace,
                standaloneService,
              );
            } catch (notificationError) {
              if (!stopAc.signal.aborted) {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} completion could not be returned to parent ${info.callerSessionId}: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                );
              }
            }
          } finally {
            drainAc.abort();
            // Use releaseOnce (not raw release) — if spawn succeeded but the
            // outer catch also fires release, using raw release would double-
            // free the slot.
            releaseOnce();
          }
        })();
        return {
          sessionId,
          ...(sub.parentSessionPersisted !== undefined
            ? { parentSessionPersisted: sub.parentSessionPersisted }
            : {}),
        };
      }

      // first-turn: hold the slot synchronously until the turn completes.
      // stopAc.signal is composed inside awaitFirstTurn so stop() aborts
      // the subscription (stopReason: 'shutdown'). Also race against the
      // sendPrompt promise — if it rejects (API 429, network timeout, auth
      // failure), turn_complete/turn_error never fire and the caller would
      // otherwise wait the full timeout.
      try {
        const turnError: Promise<never> = turn.then(
          () => new Promise<never>(() => {}), // never resolves on success
          (err) =>
            Promise.reject(
              new Error(
                `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
        );
        const firstTurn = awaitFirstTurn(
          bridge,
          sessionId,
          promptId,
          lastEventId,
          firstTurnTimeoutMs,
          stopAc.signal,
        );
        const { result, stopReason } = await Promise.race([
          firstTurn,
          turnError,
        ]);
        return {
          sessionId,
          result,
          stopReason,
          ...(sub.parentSessionPersisted !== undefined
            ? { parentSessionPersisted: sub.parentSessionPersisted }
            : {}),
        };
      } finally {
        releaseOnce();
      }
    } catch (err) {
      // Spawn/admission failure — surface it as the tool's error.
      releaseOnce();
      // If the spawn succeeded but a later step failed (e.g. sendPrompt threw
      // synchronously), roll back the orphaned session so it doesn't leak a slot
      // in the bridge's session pool while this launch reports failure.
      if (spawnedSession !== undefined && isolatedWorkspace && !standalone) {
        let sessionClosed = false;
        try {
          if (spawnedSession.attached) {
            if (spawnedSession.clientId) {
              await bridge.detachClient(
                spawnedSession.sessionId,
                spawnedSession.clientId,
              );
            }
          } else {
            sessionClosed = await bridge.killSession(spawnedSession.sessionId, {
              requireZeroAttaches: true,
            });
          }
        } catch (cleanupError) {
          log.debug(
            'sub-session: isolated session rollback failed',
            spawnedSession.sessionId,
            cleanupError,
          );
        }
        if (sessionClosed) {
          if (!promptDispatched) {
            try {
              const transcriptRemoved = await new SessionService(
                boundWorkspace,
              ).removeSession(spawnedSession.sessionId);
              if (transcriptRemoved) bridge.markSessionCatalogChanged();
            } catch (cleanupError) {
              log.debug(
                'sub-session: isolated transcript cleanup failed',
                spawnedSession.sessionId,
                cleanupError,
              );
            }
          }
          try {
            await isolatedWorkspace.discardEmptyDirectory(
              spawnedSession.sessionId,
            );
          } catch (cleanupError) {
            log.debug(
              'sub-session: isolated workspace cleanup failed',
              spawnedSession.sessionId,
              cleanupError,
            );
          }
        }
      } else if (spawnedSession !== undefined && !standalone) {
        // Both guards are load-bearing. `.catch()` swallows the async
        // rejection; the try/catch contains a SYNCHRONOUS throw. We are already
        // inside the catch block, so an escaping throw here would replace `err`
        // — the real launch failure — with the cleanup failure.
        try {
          void bridge.closeSession(spawnedSession.sessionId).catch(() => {});
        } catch (closeErr) {
          log.debug(
            'sub-session: closeSession threw',
            spawnedSession.sessionId,
            closeErr,
          );
        }
      }
      writeStderrLine(
        `qwen serve: create_sub_session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  return {
    launch,
    stop: () => {
      stopAc.abort(); // tears down every active subscription → releases slots
    },
  };
}
