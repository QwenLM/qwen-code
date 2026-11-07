/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionRequest } from '../adapters/types.js';
import { isAskUserQuestionToolName } from '../constants/toolNames.js';

/**
 * True when a pending permission is an AskUserQuestion prompt (it carries a
 * `questions` array, and either no tool name or the AskUserQuestion tool name)
 * rather than a normal tool-call approval. Shared by the single-session App and
 * the split-view ChatPane so the two never drift.
 */
export function isAskUserPermission(
  request: PermissionRequest | null,
): boolean {
  if (
    !request?.rawInput?.questions ||
    !Array.isArray(request.rawInput.questions)
  ) {
    return false;
  }
  if (!request.toolName) return true;
  return isAskUserQuestionToolName(request.toolName);
}

/**
 * Language-neutral snapshot of a pending AskUserQuestion payload — numbered
 * questions with their option labels and descriptions — for embedding in the
 * side-task details prompt. Malformed entries are skipped rather than throwing:
 * the payload crosses the daemon wire and is not schema-validated here.
 */
export function formatAskUserQuestions(
  rawInput: Record<string, unknown> | undefined,
): string {
  const questions = Array.isArray(rawInput?.questions)
    ? rawInput.questions
    : [];
  const parts: string[] = [];
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { question, options, multiSelect } = entry as {
      question?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (typeof question !== 'string' || !question.trim()) continue;
    // Selection semantics matter to the explanation (options may combine);
    // the marker keeps the snapshot self-contained without prose.
    const lines = [
      `[${parts.length + 1}] ${question.trim()}${multiSelect === true ? ' [multiSelect]' : ''}`,
    ];
    if (Array.isArray(options)) {
      for (const option of options) {
        if (typeof option !== 'object' || option === null) continue;
        const { label, description } = option as {
          label?: unknown;
          description?: unknown;
        };
        if (typeof label !== 'string' || !label.trim()) continue;
        lines.push(
          typeof description === 'string' && description.trim()
            ? `- ${label.trim()}: ${description.trim()}`
            : `- ${label.trim()}`,
        );
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
