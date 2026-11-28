/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for asking the user a question.
 *
 * Always asks — that is the tool — and hands the dialog a projection of the
 * input rather than the input itself, because a model that pre-fills `answers`
 * or `annotations` must not have them displayed as though the user had chosen
 * them.
 */

import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../rule-precedence.js';

export function createAskUserToolChecker(toolName: string): HostToolChecker {
  return {
    check(input: Record<string, unknown>): ToolPermissionResult {
      const { questions, metadata } = input;
      return {
        kind: 'ask',
        reason: {
          message: 'Answer questions?',
          attribution: {
            type: 'interaction',
            reason: 'the prompt is what this tool does',
          },
          decisionPoint: `${toolName}.interaction.ask`,
        },
        extra: {
          promptInput: {
            questions,
            ...(metadata === undefined ? {} : { metadata }),
          },
        },
      };
    },
  };
}
