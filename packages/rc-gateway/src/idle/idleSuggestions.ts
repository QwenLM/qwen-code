/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OwnerEventBus } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import type { ChatTransport } from './chatTransport.js';
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

/** What the handler needs; `resolveDir`/`readTurns` are injectable for tests. */
export interface IdleSuggestionDeps {
  /** The gateway's own model transport (resolved coherent endpoint, cycle 89). */
  chat: ChatTransport;
  /** Owner-event bus the `idle_suggestions` frame is published to (cycle 49). */
  bus: OwnerEventBus;
  /** Optional audit sink — records a count-only `idle_suggested` row. */
  audit?: AuditRecorder;
  /** Max suggestions to request/emit (default 3). */
  max?: number;
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
  const max = deps.max ?? 3;

  return (sessionId: string, workspaceCwd: string): void => {
    if (!workspaceCwd) return; // no resolvable chats dir → nothing to read.
    void (async () => {
      try {
        const chatsDir = resolveDir(workspaceCwd);
        const turns = await readTurns(chatsDir, sessionId);
        if (turns.length === 0) return;
        const suggestions = await generateSuggestions({
          turns,
          chat: deps.chat,
          max,
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
