/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import {
  AuthType,
  type ContentGenerator,
} from '../../core/contentGenerator.js';
import { LoggingContentGenerator } from '../../core/loggingContentGenerator/loggingContentGenerator.js';
import { TurnBudget } from '../../core/turn-budget.js';
import { uiTelemetryService } from '../../telemetry/uiTelemetry.js';
import { subagentNameContext } from '../../utils/subagentNameContext.js';
import { WorkflowBudgetImpl } from './workflow-budget.js';

// The turn budget is only as good as the ledger it reads. This drives the real
// logging generator — the one every provider is wrapped in, and the one a
// subagent's per-agent view is built with — and checks that a main-loop call
// and a subagent call both land in the session's total that a `+500k` workflow
// budget is measured against. Nothing on the telemetry path is mocked.
describe('workflow turn budget ledger', () => {
  it("counts the main loop's and a subagent's output tokens against the turn", async () => {
    const sessionId = `ledger-${randomUUID()}`;
    const turns = new TurnBudget();
    const config = {
      getSessionId: () => sessionId,
      getTurnBudget: () => turns,
      getContentGeneratorConfig: () => ({
        model: 'qwen-ledger',
        authType: AuthType.USE_OPENAI,
      }),
      getAuthType: () => AuthType.USE_OPENAI,
      getWorkingDir: () => process.cwd(),
      getTelemetryIncludeSensitiveSpanAttributes: () => false,
      getTelemetryLogPromptsEnabled: () => false,
      getTelemetrySensitiveSpanAttributeMaxLength: () => 1024,
      getTelemetryUserId: () => undefined,
      getUserMemory: () => '',
      getAutoMemoryPrompt: () => '',
      getAutoCompactThreshold: () => undefined,
      getToolRegistry: () => ({ getTool: () => undefined }),
      getSkillManager: () => null,
      getUsageStatisticsEnabled: () => false,
      getChatRecordingService: () => undefined,
    } as unknown as Config;

    let nextOutputTokens = 0;
    const wrapped = {
      generateContent: async () => {
        const response = new GenerateContentResponse();
        response.responseId = randomUUID();
        response.modelVersion = 'qwen-ledger';
        response.usageMetadata = {
          promptTokenCount: 10,
          candidatesTokenCount: nextOutputTokens,
          totalTokenCount: 10 + nextOutputTokens,
        };
        response.candidates = [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            index: 0,
          },
        ];
        return response;
      },
      generateContentStream: async () => {
        throw new Error('not used');
      },
      countTokens: async () => ({ totalTokens: 0 }),
      embedContent: async () => ({}),
    } as unknown as ContentGenerator;
    const generator = new LoggingContentGenerator(wrapped, config, {
      model: 'qwen-ledger',
      authType: AuthType.USE_OPENAI,
    });
    const call = async (outputTokens: number, promptId: string) => {
      nextOutputTokens = outputTokens;
      await generator.generateContent(
        {
          model: 'qwen-ledger',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        promptId,
      );
    };

    // Spent before the turn: not this turn's.
    await call(1_000, 'earlier-turn');
    turns.beginTurn({
      promptId: 'turn',
      sessionId,
      budget: 500_000,
      directiveText: '+500k',
      outputTokensAtTurnStart:
        uiTelemetryService.getTotalOutputTokens(sessionId),
    });
    const budget = WorkflowBudgetImpl.fromConfig(config, {});

    await call(300, 'turn');
    await subagentNameContext.run('reviewer', () => call(700, 'turn'));

    expect(budget.source).toBe('directive');
    expect(budget.spent()).toBe(1_000);
    expect(budget.remaining()).toBe(499_000);
    // The run's own agents reported nothing through `recordSpent`: the whole
    // 1000 is turn spend, and none of it is mistaken for this run's.
    expect(budget.runSpent()).toBe(0);
  });
});
