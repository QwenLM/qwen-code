/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContextUsageSnapshot } from './contextUsageCollector.js';
import { projectContextUsageForSdk } from './contextUsageProjection.js';

function snapshot(): ContextUsageSnapshot {
  return {
    model: 'test-model',
    tokenUsage: 25_000,
    rawContextWindowTokens: 100_000,
    autoCompactThresholdTokens: 80_000,
    autoCompactBufferTokens: 20_000,
    autoCompactEnabled: true,
    tokenStats: {
      toolRequests: new Map(),
      toolResults: new Map(),
      humanMessages: 0,
      assistantMessages: 0,
      thinkingTokens: 0,
      localCommandOutputs: 0,
      other: 0,
      attachments: new Map(),
      skillTokens: new Map(),
      duplicateFileReads: new Map(),
      total: 0,
    },
    systemPromptTokens: 10_000,
    toolSchemaTokens: 4_000,
    skillDetails: [
      { name: 'large', source: 'project', tokens: 300 },
      { name: 'small', source: 'user', tokens: 100 },
    ],
    skillFrontmatterTokens: 400,
    categories: [
      { type: 'system_prompt', tokens: 10_000, percentage: 10 },
      { type: 'skills', tokens: 400, percentage: 0.4 },
      { type: 'free_space', tokens: 55_000, percentage: 55 },
      { type: 'auto_compact', tokens: 20_000, percentage: 20 },
    ],
    duplicateFileReads: [
      { path: '/workspace/a.ts', count: 2, wastedTokens: 50 },
    ],
    session: {
      messageCount: 4,
      promptCount: 2,
      toolCalls: { total: 3, succeeded: 2, failed: 1 },
      linesChanged: { added: 9, removed: 2 },
    },
  };
}

describe('projectContextUsageForSdk', () => {
  it('projects percentages without exposing absolute token counts', () => {
    const response = projectContextUsageForSdk(snapshot());

    expect(response).toEqual({
      model: 'test-model',
      contextWindow: {
        usedPercentage: 25,
      },
      categories: [
        { type: 'system_prompt', percentage: 10 },
        { type: 'skills', percentage: 0.4 },
        { type: 'free_space', percentage: 55 },
        { type: 'auto_compact', percentage: 20 },
      ],
      autoCompact: {
        enabled: true,
        thresholdPercentage: 80,
      },
      skills: {
        count: 2,
        percentageOfContext: 0.4,
        items: [
          {
            name: 'large',
            source: 'project',
            percentageOfContext: 0.3,
          },
          {
            name: 'small',
            source: 'user',
            percentageOfContext: 0.1,
          },
        ],
      },
      duplicateFileReads: [
        {
          path: '/workspace/a.ts',
          count: 2,
        },
      ],
      session: {
        messageCount: 4,
        promptCount: 2,
        toolCalls: { total: 3, succeeded: 2, failed: 1 },
        linesChanged: { added: 9, removed: 2 },
      },
    });
    expect(response).not.toHaveProperty('tokenCountsAvailable');
    expect(response).not.toHaveProperty('gridRows');
    expect(response).not.toHaveProperty('messageBreakdown');
    expect(response).not.toHaveProperty('apiUsage');
  });
});
