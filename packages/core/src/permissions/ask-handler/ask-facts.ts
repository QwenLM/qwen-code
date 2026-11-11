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
export interface AskMetrics {
  /** Which of the host's racers answered the prompt. */
  winnerParty?: string;
}

/** One session's ask facts, keyed by tool call id. */
export interface AskMetricsStore {
  /** Record, or merge into what is already recorded for that tool call. */
  record(toolCallId: string, metrics: AskMetrics): void;
  /** Read and clear. Undefined when nothing was recorded. */
  consume(toolCallId: string): AskMetrics | undefined;
  /** Read without clearing — for observers that run before the consumer. */
  peek(toolCallId: string): AskMetrics | undefined;
  /** Drop everything recorded. */
  clear(): void;
}

const MAX_TRACKED = 2000;

export function createAskMetricsStore(): AskMetricsStore {
  const byToolCall = new Map<string, AskMetrics>();
  return {
    record(toolCallId: string, metrics: AskMetrics): void {
      if (!toolCallId) return;
      const existing = byToolCall.get(toolCallId);
      byToolCall.set(toolCallId, existing ? { ...existing, ...metrics } : metrics);
      // Bound the map: a long session must not grow it without limit.
      if (byToolCall.size > MAX_TRACKED) {
        const oldest = byToolCall.keys().next().value;
        if (oldest !== undefined && oldest !== toolCallId) {
          byToolCall.delete(oldest);
        }
      }
    },
    consume(toolCallId: string): AskMetrics | undefined {
      const metrics = byToolCall.get(toolCallId);
      if (metrics) byToolCall.delete(toolCallId);
      return metrics;
    },
    peek(toolCallId: string): AskMetrics | undefined {
      return byToolCall.get(toolCallId);
    },
    clear(): void {
      byToolCall.clear();
    },
  };
}
