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
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  CreateSubSessionInfo,
  CreateSubSessionResult,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { writeStderrLine } from '../utils/stdioHelpers.js';

const log = createDebugLogger('SUB_SESSION');

/** Per-caller ceiling on concurrent in-flight sub-sessions. A `first-turn`
 * request holds a slot until its turn finishes; parallel tool calls from one
 * caller must not spawn unbounded sub-sessions. Over the cap the request is
 * rejected (surfaced as the tool's error), never silently dropped. */
export const MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER = 5;

/**
 * Ceiling on concurrent in-flight sub-sessions across ALL callers of this
 * workspace's launcher.
 *
 * The per-caller cap is keyed on `callerSessionId`, and the daemon can only
 * authenticate that id as "a session on this channel" — every session of a
 * workspace shares ONE child process, so nothing at the transport can prove
 * *which* of them issued the call. A child running attacker code could rotate
 * ids to open a fresh bucket per launch, or charge them to a sibling. This
 * bound does not depend on the id being honest: it holds whichever bucket the
 * launch is charged to.
 */
export const MAX_CONCURRENT_SUB_SESSIONS_TOTAL = 20;

/** Wall-clock ceiling for `first-turn`: a hung sub-session turn must not block
 * the caller forever. On timeout we return whatever text accumulated so far. */
const FIRST_TURN_TIMEOUT_MS = 5 * 60_000;

/** Wall-clock ceiling for the sent-mode background drain. Generous enough for
 * long-running sub-sessions but prevents a hung turn from permanently consuming
 * a concurrency slot (the idle reaper may not fire if the sub-session is still
 * "actively" running from the daemon's perspective). */
const SENT_MODE_DRAIN_TIMEOUT_MS = 30 * 60_000;

/** Cap on returned first-turn text so a runaway sub-session can't flood the
 * caller's context. Excess is dropped with a truncation marker. */
const MAX_RESULT_CHARS = 32_000;

/** Cap on the session display name (a label, not the full prompt). */
const MAX_NAME_LENGTH = 60;

/** How many spawned sub-session ids the depth-1 gate remembers. Far above any
 * plausible live sub-session count (`maxSessions` defaults to 20), so eviction
 * only ever discards long-reaped sessions. */
const MAX_TRACKED_SPAWNED_SESSIONS = 1024;

export interface SubSessionLauncher {
  /** The `onCreateSubSession` callback wired into the bridge. Returns a Promise
   * the child's tool awaits. */
  launch(info: CreateSubSessionInfo): Promise<CreateSubSessionResult>;
  /** Stop accepting new sub-sessions (daemon shutdown). Idempotent. */
  stop(): void;
}

export interface CreateSubSessionLauncherOptions {
  getBridge: () => AcpSessionBridge | undefined;
  boundWorkspace: string;
  /** Per-request `first-turn` wall-clock timeout; defaults to
   * {@link FIRST_TURN_TIMEOUT_MS}. Exposed for tests. */
  firstTurnTimeoutMs?: number;
  /** Sent-mode background-drain ceiling; defaults to
   * {@link SENT_MODE_DRAIN_TIMEOUT_MS}. Exposed for tests. */
  sentModeDrainTimeoutMs?: number;
}

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

function subSessionName(label: string): string {
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
  return `🧵 ${short}`;
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
  const { getBridge, boundWorkspace } = opts;
  const firstTurnTimeoutMs = opts.firstTurnTimeoutMs ?? FIRST_TURN_TIMEOUT_MS;
  const sentModeDrainTimeoutMs =
    opts.sentModeDrainTimeoutMs ?? SENT_MODE_DRAIN_TIMEOUT_MS;
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
    // and each gets its own 5-slot bucket — so without this a sub-session can
    // spawn 5 more, each of which spawns 5 more (5ⁿ), exhausting `maxSessions`
    // from one prompt. `callerSessionId` is required and authenticated at the
    // bridge (`ownsSession`), so it can neither be forged nor omitted to
    // sidestep this gate or the per-caller cap below.
    if (spawnedSessionIds.has(info.callerSessionId)) {
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
    if (current >= MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER) {
      throw new Error(
        `Too many concurrent sub-sessions for this session ` +
          `(cap ${MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER}); wait for one to finish.`,
      );
    }
    // Forge-proof backstop: the per-caller cap above trusts `callerSessionId`,
    // this one does not. See MAX_CONCURRENT_SUB_SESSIONS_TOTAL.
    if (inflightTotal >= MAX_CONCURRENT_SUB_SESSIONS_TOTAL) {
      throw new Error(
        `Too many concurrent sub-sessions in this workspace ` +
          `(cap ${MAX_CONCURRENT_SUB_SESSIONS_TOTAL}); wait for one to finish.`,
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
    // we close this session so it isn't orphaned (the slot was consumed and
    // the prompt may have been dispatched, but launch() reports failure).
    let spawnedSessionId: string | undefined;

    try {
      const sub = await bridge.spawnOrAttach({
        workspaceCwd: boundWorkspace,
        sessionScope: 'thread', // force a fresh top-level session, never attach
        // Record the caller as the sub-session's parent so the UI can link it
        // back. Persisted into the sub-session's transcript at spawn time.
        parentSessionId: info.callerSessionId,
        ...(info.model ? { modelServiceId: info.model } : {}),
      });
      spawnedSessionId = sub.sessionId;
      const sessionId = sub.sessionId;
      rememberSpawned(sessionId);

      try {
        bridge.updateSessionMetadata(sessionId, {
          displayName: subSessionName(info.name ?? info.prompt),
        });
      } catch (err) {
        log.debug('sub-session: updateSessionMetadata failed', sessionId, err);
      }

      // Capture the event cursor BEFORE dispatching so subscriptions can replay
      // every chunk of the turn (no early-chunk loss). Called unconditionally
      // — even sent mode needs it for the background drain that holds the
      // concurrency slot; hardcoding 0 would work on a fresh bus but is
      // load-bearing and subtle, so always ask the bridge.
      const lastEventId = bridge.getSessionLastEventId(sessionId);

      const promptId = randomUUID();
      const turn = bridge.sendPrompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: info.prompt }],
        } as Parameters<AcpSessionBridge['sendPrompt']>[1],
        undefined,
        { promptId },
      );
      // The result comes from the event stream (turn_error surfaces failures);
      // swallow the promise so it can't raise an unhandled rejection, but log
      // the error so dispatch failures are not invisible.
      void turn.catch((err) => {
        log.debug('sub-session: sendPrompt rejected', sessionId, String(err));
      });

      if (info.completion === 'sent') {
        // Hold the concurrency slot until the sub-session's turn finishes
        // (or the daemon shuts down via stop(), or a wall-clock ceiling is
        // reached). Without this the cap is a no-op for sent mode — the
        // fire-and-forget path returns immediately and the slot releases
        // before the sub-session has done any work, letting a looping
        // isolated task exhaust the daemon's session pool.
        const drainAc = new AbortController();
        // Recorded in the timer, not read off `drainAc.signal.aborted`: the
        // `finally` below aborts that controller on every exit path, so the
        // signal cannot tell a 30-minute hang from a clean drain.
        let drainTimedOut = false;
        const drainTimer = setTimeout(() => {
          drainTimedOut = true;
          drainAc.abort();
        }, sentModeDrainTimeoutMs);
        if (typeof drainTimer.unref === 'function') drainTimer.unref();
        const drainSignal = AbortSignal.any([stopAc.signal, drainAc.signal]);
        void (async () => {
          try {
            // Race the turn promise against the drain: if sendPrompt rejects
            // (API 429, network timeout), the turn will never emit
            // turn_complete/turn_error, so abort the drain immediately.
            const turnSettled = turn.then(
              () => 'ok' as const,
              () => 'rejected' as const,
            );
            const drainDone = (async () => {
              for await (const e of bridge.subscribeEvents(sessionId, {
                lastEventId,
                signal: drainSignal,
              })) {
                if (e.type === 'turn_complete' || e.type === 'turn_error') {
                  const d = e.data as { promptId?: string };
                  if (d?.promptId === promptId) break;
                }
              }
              return 'drained' as const;
            })();
            await Promise.race([turnSettled, drainDone]);
          } catch (err) {
            // AbortError from stop()/timeout or bus closure is expected.
            // Other errors (bus corruption, internal bridge failures) are
            // real and should surface — don't silently swallow them.
            if (
              !(err instanceof Error && err.name === 'AbortError') &&
              !(stopAc.signal.aborted || drainAc.signal.aborted)
            ) {
              log.debug(
                'sub-session: sent-mode drain error',
                sessionId,
                String(err),
              );
            }
          } finally {
            clearTimeout(drainTimer);
            if (drainTimedOut) {
              // The slot is about to be freed while the sub-session is very
              // likely still running (`sendPrompt` has no abort seam), so it
              // keeps burning a bridge session and model quota with nobody
              // watching. `log.debug` is a no-op unless a debug log session is
              // active — this has to reach stderr or it leaves no trace at all.
              writeStderrLine(
                `qwen serve: sub-session ${sessionId} drain timed out after ` +
                  `${Math.round(sentModeDrainTimeoutMs / 60_000)}min; releasing its ` +
                  `concurrency slot (the sub-session may still be running)`,
              );
            }
            drainAc.abort();
            // Use releaseOnce (not raw release) — if spawn succeeded but the
            // outer catch also fires release, using raw release would double-
            // free the slot.
            releaseOnce();
          }
        })();
        return { sessionId };
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
        return { sessionId, result, stopReason };
      } finally {
        releaseOnce();
      }
    } catch (err) {
      // Spawn/admission failure — surface it as the tool's error.
      releaseOnce();
      // If the spawn succeeded but a later step failed (e.g. sendPrompt threw
      // synchronously), close the orphaned session so it doesn't leak a slot
      // in the bridge's session pool while this launch reports failure.
      if (spawnedSessionId !== undefined) {
        // Both guards are load-bearing. `.catch()` swallows the async
        // rejection; the try/catch contains a SYNCHRONOUS throw. We are already
        // inside the catch block, so an escaping throw here would replace `err`
        // — the real launch failure — with the cleanup failure.
        try {
          void bridge.closeSession(spawnedSessionId).catch(() => {});
        } catch (closeErr) {
          log.debug(
            'sub-session: closeSession threw',
            spawnedSessionId,
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
