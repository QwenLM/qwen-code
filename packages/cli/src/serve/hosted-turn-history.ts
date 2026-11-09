/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { getApiHistoryPromptId } from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';

/**
 * Settlement comes from the journal. Only an interruption with committed model
 * work keeps its instruction; a bare abandoned input must not be replayed.
 */
export function excludedHostedPrompts(
  events: readonly ManagedSessionEvent[],
  records: readonly ChatRecord[],
): Set<string> {
  const committedWork = new Set(
    records
      .filter(
        (entry) => entry.type === 'assistant' || entry.type === 'tool_result',
      )
      .map((entry) => entry.daemonPromptId),
  );
  const excluded = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'turn.settled') continue;
    const turnId = event.payload['turnId'];
    if (typeof turnId !== 'string') continue;
    if (
      event.payload['outcome'] === 'error' ||
      (event.payload['outcome'] === 'cancelled' &&
        (event.payload['stopReason'] !== 'harness_interruption' ||
          !committedWork.has(turnId)))
    )
      excluded.add(turnId);
  }
  return excluded;
}

export function filterHostedTurnHistory(
  history: Content[],
  excludedPromptIds: ReadonlySet<string> | undefined,
): Content[] {
  let excluded = false;
  return history.filter((entry) => {
    const promptId = getApiHistoryPromptId(entry);
    // Compression marks prompts alone. Tool rounds and unmarked queued
    // guidance belong to that boundary until the next marked prompt.
    if (promptId !== undefined)
      excluded = excludedPromptIds?.has(promptId) ?? false;
    return !excluded;
  });
}
