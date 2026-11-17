/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionConditionField } from './conditions.js';

/**
 * Structural view over Config used to snapshot the `session.*` condition
 * namespace. Every member is optional so partial/stub configs (tests,
 * embedders that skip initialization) simply yield fewer fields — which
 * the condition evaluator reads as `unavailable`, never as zero.
 */
export interface SessionConditionConfigView {
  getContentGeneratorConfig?: () => { contextWindowSize?: number } | undefined;
  /** May throw (GeminiClient.getChat throws before initialization). */
  getGeminiClient?: () =>
    | { getChat?: () => { getLastPromptTokenCount(): number } }
    | undefined;
}

/**
 * Snapshot the `session.*` condition namespace (policy design §8.3)
 * BEFORE fixed-policy execution. The snapshot is taken once per media
 * delivery and stays constant across every pass of that delivery
 * (preprocessing and transport-guard alike).
 *
 * - `contextWindowTokens`: the active model's context window, read from
 *   `contentGeneratorConfig.contextWindowSize` — the post-initialization
 *   authority for the resolved window size.
 * - `promptTokenCount`: the CURRENT chat's last reported prompt token
 *   count (`GeminiChat.getLastPromptTokenCount()`), per-chat by design —
 *   a subagent's media must be judged against the subagent's own context,
 *   never a global UI telemetry counter.
 * - `reservedOutputTokens`: `omni.processing.limits.reservedOutputTokens`.
 * - `availableContextTokens`:
 *   `max(0, contextWindowTokens − promptTokenCount − reservedOutputTokens)`,
 *   computed only when both inputs are known — a partial subtraction must
 *   surface as `unavailable`, never as a permissive large number.
 */
export function buildSessionConditionNamespace(
  config: SessionConditionConfigView,
  reservedOutputTokens: number,
): Partial<Record<SessionConditionField, number>> {
  const session: Partial<Record<SessionConditionField, number>> = {
    reservedOutputTokens,
  };

  const windowSize = config.getContentGeneratorConfig?.()?.contextWindowSize;
  const contextWindowTokens =
    typeof windowSize === 'number' &&
    Number.isFinite(windowSize) &&
    windowSize > 0
      ? windowSize
      : undefined;
  if (contextWindowTokens !== undefined) {
    session.contextWindowTokens = contextWindowTokens;
  }

  let promptTokenCount: number | undefined;
  try {
    const count = config
      .getGeminiClient?.()
      ?.getChat?.()
      ?.getLastPromptTokenCount();
    // 0 is legitimate (nothing sent yet on this chat); negative or
    // non-finite values are stub garbage and read as absent.
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      promptTokenCount = count;
    }
  } catch {
    // Chat not initialized: the field stays absent (→ unavailable).
  }
  if (promptTokenCount !== undefined) {
    session.promptTokenCount = promptTokenCount;
  }

  if (contextWindowTokens !== undefined && promptTokenCount !== undefined) {
    session.availableContextTokens = Math.max(
      0,
      contextWindowTokens - promptTokenCount - reservedOutputTokens,
    );
  }
  return session;
}
