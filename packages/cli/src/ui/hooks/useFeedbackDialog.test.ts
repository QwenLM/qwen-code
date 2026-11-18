/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { meetsMinimumSessionRequirements } from './useFeedbackDialog.js';
import type {
  SessionStatsState,
  SessionMetrics,
} from '../contexts/SessionContext.js';

const statsWith = (overrides: {
  userPromptCount: number;
  promptCount: number;
  toolCalls?: number;
}): SessionStatsState =>
  ({
    sessionId: 'feedback-gate',
    sessionStartTime: new Date(),
    lastPromptTokenCount: 0,
    promptCount: overrides.promptCount,
    userPromptCount: overrides.userPromptCount,
    metrics: {
      tools: { totalCalls: overrides.toolCalls ?? 0 },
    } as unknown as SessionMetrics,
  }) as unknown as SessionStatsState;

describe('meetsMinimumSessionRequirements', () => {
  it('reads the user-visible userPromptCount, not the mint counter promptCount', () => {
    // Background mints pushed promptCount far past the user-turn count. The
    // gate must key on userPromptCount: 3 user turns stays below the threshold
    // even though the mint counter reads 100.
    expect(
      meetsMinimumSessionRequirements(
        statsWith({ userPromptCount: 3, promptCount: 100 }),
      ),
    ).toBe(false);
    // 6 user turns crosses the threshold regardless of the mint counter.
    expect(
      meetsMinimumSessionRequirements(
        statsWith({ userPromptCount: 6, promptCount: 6 }),
      ),
    ).toBe(true);
  });

  it('still admits a session on tool calls alone', () => {
    expect(
      meetsMinimumSessionRequirements(
        statsWith({ userPromptCount: 0, promptCount: 0, toolCalls: 11 }),
      ),
    ).toBe(true);
    expect(
      meetsMinimumSessionRequirements(
        statsWith({ userPromptCount: 0, promptCount: 0, toolCalls: 10 }),
      ),
    ).toBe(false);
  });
});
