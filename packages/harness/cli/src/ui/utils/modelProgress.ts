/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThoughtSummary, I18nService } from '@qwen-code/core';

export const MODEL_PROGRESS_LABEL = {
  generating: 'Generating...',
  thinking: 'Thinking...',
} as const;

/**
 * Maps the current model stream to the fixed progress phase shown in the TUI.
 * Thought contents remain in history and are never used as status copy.
 */
export function getModelProgressLabel(
  thought: ThoughtSummary | null,
  get: I18nService['get'],
): string {
  const hasActiveReasoning = Boolean(
    thought && (thought.subject.trim() || thought.description.trim()),
  );
  return get(
    hasActiveReasoning ? 'status.model.thinking' : 'status.model.generating',
  );
}

export function isModelProgressLabel(
  value: string | undefined,
  get: I18nService['get'],
): boolean {
  return (
    value === MODEL_PROGRESS_LABEL.generating ||
    value === MODEL_PROGRESS_LABEL.thinking ||
    value === get('status.model.generating') ||
    value === get('status.model.thinking')
  );
}
