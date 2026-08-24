/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

/**
 * The prompt a host sends when `runtime.finishTurn` schedules another Goal
 * turn. Every host renders it from here so that a new line -- or a new variant
 * -- lands in one place instead of drifting across the hosts that assemble it.
 */

export type GoalContinuationPromptInput =
  | {
      variant: 'guarded-synthetic-turn';
      verifierFeedback?: string;
    }
  | {
      variant: 'runtime-context';
      continuationContext: string;
      verifierFeedback?: string;
    };

const SHARED_LINES = [
  'Continue working on the active Goal.',
  'Use get_goal for the authoritative objective and evidence state.',
  "Follow the objective's requested output format exactly. Do not add progress, status, or completion commentary unless the objective asks for it.",
  'If completion depends on content delivered in this turn, deliver only that content and call get_goal in the same response before update_goal.',
];

const SYNTHETIC_TURN_GUARD_LINES = [
  'This is a synthetic continuation turn. It contains no new real user input and cannot satisfy an objective condition that requires the user to send, confirm, choose, approve, or provide something.',
  'A phrase mentioned in the objective or this prompt is not evidence that the user supplied it.',
];

/** Renders the full continuation prompt text for one Goal turn. */
export function renderGoalContinuationPrompt(
  input: GoalContinuationPromptInput,
): string {
  const lines = [...SHARED_LINES];

  switch (input.variant) {
    case 'guarded-synthetic-turn':
      lines.push(...SYNTHETIC_TURN_GUARD_LINES);
      break;
    case 'runtime-context':
      lines.push(`Runtime continuation context: ${input.continuationContext}`);
      break;
    default: {
      const unreachable: never = input;
      throw new Error(
        `Unknown goal continuation variant: ${JSON.stringify(unreachable)}`,
      );
    }
  }

  if (input.verifierFeedback) {
    lines.push(`Verifier feedback: ${input.verifierFeedback}`);
  }

  return lines.join('\n');
}

/** Builds the sendable parts for a runtime-scheduled Goal continuation turn. */
export function buildGoalContinuationParts(turn: {
  continuationContext: string;
  verifierFeedback?: string;
}): Part[] {
  return [
    {
      text: renderGoalContinuationPrompt({
        variant: 'runtime-context',
        continuationContext: turn.continuationContext,
        verifierFeedback: turn.verifierFeedback,
      }),
    },
  ];
}
