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
}

/**
 * Build the pump's `onSessionIdle` handler: when a session's active prompt
 * finishes (the pump detects the `hasActivePrompt` true→false edge), read its
 * recent turns, ask the gateway's own model for next-step suggestions, and — only
 * if any survive parsing — publish an `idle_suggestions` frame on the owner-event
 * bus. NEVER touches the daemon session (option B: no synthetic prompt, no
 * transcript pollution, no viewer noise).
 *
 * The returned function is SYNCHRONOUS and fire-and-forget: it kicks off the async
 * work and returns immediately so it never blocks the pump's reconcile tick, and
 * the whole async body is self-catching so a model/IO failure degrades to silence
 * (no frame) and can never throw into `runLoop`. Empty tail or empty parse → no
 * frame (the UI shows nothing rather than an empty chip row).
 */
export function createIdleSuggestionHandler(
  deps: IdleSuggestionDeps,
): (sessionId: string, workspaceCwd: string) => void {
  const resolveDir = deps.resolveDir ?? ((cwd: string) => resolveChatsDir(cwd));
  const readTurns = deps.readTurns ?? readRecentTurns;
  const now = deps.now ?? Date.now;

  return (sessionId: string, workspaceCwd: string): void => {
    // The ENABLED gate is the sole thing standing between an operator who merely
    // has model creds in their env and transcript egress — check it FIRST, before
    // any disk read or model call, so a disabled feature has ZERO side effects.
    if (!deps.getConfig().enabled) return;
    if (!workspaceCwd) return; // no resolvable chats dir → nothing to read.
    void (async () => {
      try {
        const chatsDir = resolveDir(workspaceCwd);
        // Read the (cheap, bounded) tail BEFORE consuming the rate-limit budget,
        // so the hourly budget is spent on genuine model calls, not empty-tail
        // idle edges.
        const turns = await readTurns(chatsDir, sessionId);
        if (turns.length === 0) return;
        // Per-session rate limit (token-bucket ≈ rolling hour). Cap is read live
        // from config so a hot-reload of maxSuggestionsPerHour takes effect on the
        // next check. tryConsume is atomic, so two rapid edges can't double-spend
        // a single token. Empty bucket → skip + a DEDUPED audit (firstDrop).
        const cfg = deps.getConfig();
        if (deps.limiter) {
          const { allowed, firstDrop } = deps.limiter.tryConsume(
            sessionId,
            cfg.maxSuggestionsPerHour,
            now(),
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
        }
        const suggestions = await generateSuggestions({
          turns,
          chat: deps.chat,
          max: cfg.maxSuggestions,
          timeoutMs: deps.timeoutMs,
        });
        if (suggestions.length === 0) return;
        deps.bus.publish({ type: 'idle_suggestions', sessionId, suggestions });
        // Count-only: never the suggestion text or any transcript content.
        void deps.audit?.record({
          action: 'idle_suggested',
          target: sessionId,
          detail: { count: suggestions.length },
        });
      } catch {
        // Enrichment: any failure degrades to silence, never throws into the pump.
      }
    })();
  };
}
