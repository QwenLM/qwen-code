/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OwnerEventBus } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';
import type { PushRateLimiter } from '../webpush/rateLimiter.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import type { ChatTransport } from './chatTransport.js';
import type { IdleConfig } from './config.js';
import { generateSuggestions, type TurnText } from './suggester.js';
import { readRecentTurns } from './transcriptTail.js';

/**
 * Explicit opt-in gate for idle suggestions (proposal `add-idle-suggestions`).
 * The feature is OFF by default even when suggestion credentials happen to be
 * present in the environment — so a workstation that merely has `OPENAI_API_KEY`
 * set never starts shipping transcript content to the model on every idle edge.
 * The operator must turn it on deliberately. (Slice 3 replaces this env flag with
 * `idle.yaml` + a per-session `/suggest on|off` toggle.)
 */
export function resolveIdleEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env['QWEN_RC_IDLE_SUGGESTIONS'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** What the handler needs; `resolveDir`/`readTurns`/`now` are injectable for tests. */
export interface IdleSuggestionDeps {
  /** The gateway's own model transport (resolved coherent endpoint, cycle 89). */
  chat: ChatTransport;
  /** Owner-event bus the `idle_suggestions` frame is published to (cycle 49). */
  bus: OwnerEventBus;
  /**
   * Live config accessor — read at FIRE TIME, so a hot-reload (later slice) of
   * `enabled`/`maxSuggestions*` takes effect on the next idle edge with no
   * rebuild. `enabled` is the SOLE egress guard now (the handler is built
   * whenever model creds resolve), so it is checked before any other work.
   */
  getConfig: () => IdleConfig;
  /** Optional audit sink — count-only `idle_suggested` / `idle_suggest_rate_limited`. */
  audit?: AuditRecorder;
  /**
   * Per-session rolling-hour limiter (reuses the push limiter). Cap is read
   * per-call from config, so editing `maxSuggestionsPerHour` takes effect on the
   * next check. Absent → no cap.
   */
  limiter?: PushRateLimiter;
  /** Clock (epoch ms) for the limiter; default `Date.now`. */
  now?: () => number;
  /** Per-call model timeout in ms (default the transport's own). */
  timeoutMs?: number;
  /** Resolve a workspace cwd → its chats dir. Default: the daemon-exact resolver. */
  resolveDir?: (cwd: string) => string;
  /** Read recent turns from a chats dir. Default: the bounded tail reader. */
  readTurns?: (chatsDir: string, sessionId: string) => Promise<TurnText[]>;
  /**
   * Per-session override accessor (the `/suggest on|off` toggle store). Returns
   * `false` to DISABLE idle suggestions for a session, `true`/`undefined` to
   * follow the global default. It can only NARROW: an override never widens past
   * the global `enabled` egress gate (a write-scoped client must not be able to
   * start transcript egress on a workstation whose operator hasn't opted in).
   */
  getSessionEnabled?: (sessionId: string) => boolean | undefined;
  /**
   * Suggestions TTL in seconds: the `expiresAt` field of the published frame is
   * set to `now + suggestionsTtlSec * 1000`. Default: 1800 (30 minutes).
   */
  suggestionsTtlSec?: number;
}

/** The handle returned by {@link createIdleSuggestionHandler}. */
export interface IdleSuggestionHandle {
  /**
   * The pump's `onSessionIdle` callback: fire-and-forget, synchronous, never
   * throws. Cancels any in-flight suggestion generation for the session first
   * (to avoid publishing a stale frame for a session that is already active again)
   * then kicks off a new round.
   */
  onSessionIdle: (sessionId: string, workspaceCwd: string) => void;
  /**
   * Cancel any in-flight suggestion generation for `sessionId`. Call this when a
   * NEW prompt starts for the session (the `hasActivePrompt` false→true edge) so
   * we never publish suggestions that are stale relative to an ongoing prompt.
   * Safe to call with an unknown / already-cancelled session id (no-op).
   */
  cancelForSession: (sessionId: string) => void;
}

/** Default TTL for the `expiresAt` field: 30 minutes. */
const DEFAULT_SUGGESTIONS_TTL_SEC = 1800;

/**
 * Build the pump's `onSessionIdle` handler: when a session's active prompt
 * finishes (the pump detects the `hasActivePrompt` true→false edge), read its
 * recent turns, ask the gateway's own model for next-step suggestions, and — only
 * if any survive parsing — publish an `idle_suggestions` frame on the owner-event
 * bus. NEVER touches the daemon session (option B: no synthetic prompt, no
 * transcript pollution, no viewer noise).
 *
 * The returned `onSessionIdle` is SYNCHRONOUS and fire-and-forget: it kicks off
 * the async work and returns immediately so it never blocks the pump's reconcile
 * tick. The whole async body is self-catching so a model/IO failure degrades to
 * silence (no frame) and can never throw into `runLoop`. Empty tail or empty parse
 * → no frame (the UI shows nothing rather than an empty chip row).
 *
 * AbortController: a per-session `AbortController` is created for each fired
 * round and stored in `inFlight`. `cancelForSession` (called when a new prompt
 * starts) aborts the controller immediately, so the model call is cancelled and
 * no stale frame is published. A new idle edge creates a fresh controller.
 *
 * SSE payload fields (spec-alignment):
 *  - `expiresAt`: ISO-8601 timestamp = `now + suggestionsTtlSec * 1000`.
 *  - `rateLimitState`: `{ remaining, max }` snapshotted after consuming a budget
 *    slot (or from the full cap when no limiter is wired).
 */
export function createIdleSuggestionHandler(
  deps: IdleSuggestionDeps,
): IdleSuggestionHandle {
  const resolveDir = deps.resolveDir ?? ((cwd: string) => resolveChatsDir(cwd));
  const readTurns = deps.readTurns ?? readRecentTurns;
  const now = deps.now ?? Date.now;
  const ttlSec = deps.suggestionsTtlSec ?? DEFAULT_SUGGESTIONS_TTL_SEC;

  /** Per-session in-flight AbortController — cancelled on prompt start. */
  const inFlight = new Map<string, AbortController>();

  function cancelForSession(sessionId: string): void {
    const ctrl = inFlight.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      inFlight.delete(sessionId);
    }
  }

  function onSessionIdle(sessionId: string, workspaceCwd: string): void {
    // Per-session opt-out (`/suggest off`): an explicit `false` disables this
    // session regardless of the global default. Checked first so a disabled
    // session has ZERO side effects. An override of `true`/undefined falls
    // through to the global gate — it can NARROW but never widen.
    if (deps.getSessionEnabled?.(sessionId) === false) return;
    // The ENABLED gate is the sole thing standing between an operator who merely
    // has model creds in their env and transcript egress — check it FIRST, before
    // any disk read or model call, so a disabled feature has ZERO side effects.
    // A per-session `true` override can NEVER bypass this (egress stays operator-
    // gated via idle.yaml; the toggle only narrows).
    if (!deps.getConfig().enabled) return;
    if (!workspaceCwd) return; // no resolvable chats dir → nothing to read.

    // Cancel any previous in-flight generation (prompt may have restarted and
    // we got a new idle edge before the old model call resolved).
    cancelForSession(sessionId);

    const ctrl = new AbortController();
    inFlight.set(sessionId, ctrl);

    void (async () => {
      try {
        const chatsDir = resolveDir(workspaceCwd);
        // Read the (cheap, bounded) tail BEFORE consuming the rate-limit budget,
        // so the hourly budget is spent on genuine model calls, not empty-tail
        // idle edges.
        const turns = await readTurns(chatsDir, sessionId);
        if (ctrl.signal.aborted) return;
        if (turns.length === 0) return;
        // Per-session rate limit (token-bucket ≈ rolling hour). Cap is read live
        // from config so a hot-reload of maxSuggestionsPerHour takes effect on the
        // next check. tryConsume is atomic, so two rapid edges can't double-spend
        // a single token. Empty bucket → skip + a DEDUPED audit (firstDrop).
        const cfg = deps.getConfig();
        let remaining = cfg.maxSuggestionsPerHour;
        if (deps.limiter) {
          const nowMs = now();
          const { allowed, firstDrop } = deps.limiter.tryConsume(
            sessionId,
            cfg.maxSuggestionsPerHour,
            nowMs,
          );
          if (!allowed) {
            if (firstDrop) {
              void deps.audit?.record({
                action: 'idle_suggest_rate_limited',
                target: sessionId,
              });
            }
            return;
          }
          // Snapshot remaining AFTER consuming the slot.
          remaining = deps.limiter.remaining(
            sessionId,
            cfg.maxSuggestionsPerHour,
            nowMs,
          );
        }
        if (ctrl.signal.aborted) return;
        const suggestions = await generateSuggestions({
          turns,
          chat: deps.chat,
          max: cfg.maxSuggestions,
          signal: ctrl.signal,
          timeoutMs: deps.timeoutMs,
        });
        if (ctrl.signal.aborted) return;
        if (suggestions.length === 0) return;
        const nowMs = now();
        const expiresAt = new Date(nowMs + ttlSec * 1000).toISOString();
        deps.bus.publish({
          type: 'idle_suggestions',
          sessionId,
          suggestions,
          expiresAt,
          rateLimitState: { remaining, max: cfg.maxSuggestionsPerHour },
        });
        // Count-only: never the suggestion text or any transcript content.
        void deps.audit?.record({
          action: 'idle_suggested',
          target: sessionId,
          detail: { count: suggestions.length },
        });
      } catch {
        // Enrichment: any failure degrades to silence, never throws into the pump.
      } finally {
        // Remove our controller only if it's still the current one (another call
        // may have already replaced it with a newer controller).
        if (inFlight.get(sessionId) === ctrl) {
          inFlight.delete(sessionId);
        }
      }
    })();
  }

  return { onSessionIdle, cancelForSession };
}
