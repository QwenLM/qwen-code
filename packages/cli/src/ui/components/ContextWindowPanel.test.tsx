/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config, SessionMetrics } from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { ContextWindowPanel } from './ContextWindowPanel.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getRawContextWindowSize: () => 100_000,
    getSummaryReserveTokens: () => 10_000,
    getAutoCompactThresholdForContextWindow: () => 80_000,
    calculateTokenWarningStateForContextWindow: () => ({
      isAboveWarningThreshold: false,
      isAboveErrorThreshold: false,
      isAtBlockingLimit: false,
    }),
    getDisplayString: (_session: Config, model: string) => model,
  };
});

const metrics = {
  models: {},
  tools: {
    totalCalls: 4,
    totalSuccess: 3,
    totalFail: 1,
    totalDurationMs: 10,
    totalDecisions: {
      accept: 0,
      reject: 0,
      modify: 0,
      auto_accept: 0,
    },
    byName: {},
  },
  files: { totalLinesAdded: 12, totalLinesRemoved: 5 },
} as SessionMetrics;

const sessionStats: SessionStatsState = {
  sessionId: 'context-window-panel-test',
  sessionStartTime: new Date(0),
  promptCount: 2,
  lastPromptTokenCount: 25_000,
  metrics,
};

const props = {
  model: 'context-fixture-model',
  tokenUsage: 25_000,
  messageCount: 6,
  tokenStats: {
    toolRequests: new Map([['Read', 300]]),
    toolResults: new Map([['Read', 700]]),
    humanMessages: 2_000,
    assistantMessages: 3_000,
    thinkingTokens: 500,
    localCommandOutputs: 200,
    other: 100,
    attachments: new Map(),
    skillTokens: new Map(),
    duplicateFileReads: new Map([
      ['/workspace/src/a.ts', { count: 3, tokens: 240 }],
    ]),
    total: 6_600,
  },
  systemPromptTokens: 4_000,
  toolSchemaTokens: 2_000,
  skillDetails: [
    { name: 'large-skill', source: 'project' as const, tokens: 300 },
    { name: 'small-skill', source: 'user' as const, tokens: 100 },
  ],
  skillFrontmatterTokens: 400,
  promptBuild: {
    blocks: [{ type: 'text' as const, text: 'rendered prompt' }],
    source: 'default' as const,
    bundle: 'full' as const,
  },
  sessionStats,
  onClose: vi.fn(),
};

describe('ContextWindowPanel', () => {
  it('keeps both tabs and the TUI skill-share denominator stable', async () => {
    const { lastFrame, stdin, waitUntilReady } = await renderWithProviders(
      <ContextWindowPanel {...props} />,
    );

    const contextFrame = lastFrame() ?? '';
    expect(contextFrame).toMatchSnapshot('context-window-tab');

    stdin.write('\t');
    await waitUntilReady();

    const skillsFrame = lastFrame() ?? '';
    expect(skillsFrame).toContain('large-skill — 75%');
    expect(skillsFrame).toContain('small-skill — 25%');
    expect(skillsFrame).toMatchSnapshot('skills-tab');
  });

  it('reports the prompt as unavailable before the first build', async () => {
    const { lastFrame } = await renderWithProviders(
      <ContextWindowPanel {...props} promptBuild={undefined} />,
    );

    expect(lastFrame() ?? '').toContain('Prompt: unavailable');
  });

  it('counts attachments but not local command output as messages', async () => {
    const { lastFrame } = await renderWithProviders(
      <ContextWindowPanel
        {...props}
        tokenStats={{
          ...props.tokenStats,
          humanMessages: 0,
          assistantMessages: 0,
          thinkingTokens: 0,
          localCommandOutputs: 40_000,
          other: 0,
          attachments: new Map([['file', 1_000]]),
          total: 1_000,
        }}
      />,
    );

    expect(lastFrame() ?? '').toMatch(/Messages:\s+1%/);
  });

  it('limits autocompact to the space remaining above used context', async () => {
    const { lastFrame } = await renderWithProviders(
      <ContextWindowPanel {...props} tokenUsage={90_000} />,
    );

    expect(lastFrame() ?? '').toMatch(/Autocompact\s+10%/);
  });
});
