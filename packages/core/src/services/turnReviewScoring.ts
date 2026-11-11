/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message as TranscriptMessage } from '../protocol/transcript/message.js';

export type TurnReviewScoreState = {
  totalUserTextLength: number;
  turnCount: number;
  toolCallCount: number;
  uniqueToolCount: number;
};

export type TurnReviewScoreConfig = {
  reviewThreshold: number;
  textLengthScoreUnit: number;
  textLengthScoreCap: number;
  toolCountScoreUnit: number;
  toolCountScoreCap: number;
  toolDiversityThreshold: number;
  toolDiversityScoreCap: number;
  turnScore: number;
};

export const DEFAULT_TURN_REVIEW_SCORE_CONFIG: Readonly<TurnReviewScoreConfig> =
  {
    reviewThreshold: 5,
    textLengthScoreUnit: 50,
    textLengthScoreCap: 3,
    toolCountScoreUnit: 5,
    toolCountScoreCap: 2,
    toolDiversityThreshold: 3,
    toolDiversityScoreCap: 2,
    turnScore: 1,
  };

export function scoreTurnReview(
  state: TurnReviewScoreState,
  config: TurnReviewScoreConfig = DEFAULT_TURN_REVIEW_SCORE_CONFIG,
): number {
  let score = 0;
  score += Math.min(
    Math.floor(state.totalUserTextLength / config.textLengthScoreUnit),
    config.textLengthScoreCap,
  );
  score += state.turnCount * config.turnScore;
  score += Math.min(
    Math.floor(state.toolCallCount / config.toolCountScoreUnit),
    config.toolCountScoreCap,
  );
  if (state.uniqueToolCount >= config.toolDiversityThreshold) {
    score += Math.min(
      state.uniqueToolCount - config.toolDiversityThreshold + 1,
      config.toolDiversityScoreCap,
    );
  }
  return score;
}

export function collectCompletedToolUseNames(
  messages: readonly TranscriptMessage[],
): { toolCallCount: number; toolNames: string[] } {
  const toolUseNamesById = new Map<string, string>();
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        toolUseNamesById.set(block.id, block.name);
      }
    }
  }

  let toolCallCount = 0;
  const toolNames: string[] = [];
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue;
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue;
      toolCallCount += 1;
      const toolName = toolUseNamesById.get(block.tool_use_id);
      if (toolName) toolNames.push(toolName);
    }
  }
  return { toolCallCount, toolNames };
}
