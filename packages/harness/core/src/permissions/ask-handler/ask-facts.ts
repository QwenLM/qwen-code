/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-tool-call side channel for presenter-owned ask settlement facts.
 *
 * The decision says an ask ran and how it landed, but not which of the host's
 * own racers — the prompt, a PermissionRequest hook, or a recheck — answered
 * it. The presenter records that here, keyed by tool call id; the execution
 * gate consumes it.
 *
 * Session-scoped: a process-shared map could attribute one session's facts to
 * another's same tool call id.
 */

/** Presenter-side ask facts the decision cannot carry. */
export interface AskFacts {
  /** Which of the host's racers answered the prompt. */
  winnerParty?: string;
}

/** One session's ask facts, keyed by tool call id. */
export interface AskFactsStore {
  /** Record, or merge into what is already recorded for that tool call. */
  record(toolCallId: string, stats: AskFacts): void;
  /** Read without clearing — for observers that run before the consumer. */
  peek(toolCallId: string): AskFacts | undefined;
  consume(toolCallId: string): AskFacts | undefined;
  /** Drop everything recorded. */
  clear(): void;
}

const MAX_TRACKED = 2000;

export function createAskFactsStore(): AskFactsStore {
  const byToolCall = new Map<string, AskFacts>();
  return {
    record(toolCallId: string, stats: AskFacts): void {
      if (!toolCallId) return;
      const existing = byToolCall.get(toolCallId);
      byToolCall.set(toolCallId, existing ? { ...existing, ...stats } : stats);
      // Bound the map: a long session must not grow it without limit.
      if (byToolCall.size > MAX_TRACKED) {
        const oldest = byToolCall.keys().next().value;
        if (oldest !== undefined && oldest !== toolCallId) {
          byToolCall.delete(oldest);
        }
      }
    },
    peek(toolCallId: string): AskFacts | undefined {
      return byToolCall.get(toolCallId);
    },
    consume(toolCallId: string): AskFacts | undefined {
      const facts = byToolCall.get(toolCallId);
      byToolCall.delete(toolCallId);
      return facts;
    },
    clear(): void {
      byToolCall.clear();
    },
  };
}
