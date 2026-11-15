/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { describe, expect, it, vi } from 'vitest';
import { GetContextRemainingTool } from './get-context-remaining.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

function configWithChat(snapshot?: {
  promptTokens: number;
  promptTokensIsEstimated: boolean;
  outputTokens: number;
  contextWindowTokens: number;
}) {
  const chat = snapshot
    ? { getContextUsageSnapshot: () => snapshot }
    : undefined;
  const llmClient = chat ? { getChat: () => chat } : undefined;
  return {
    getLlmClient: vi.fn().mockReturnValue(llmClient),
  } as unknown as Config;
}

describe('GetContextRemainingTool', () => {
  it('names and registers under the tool registry constants', () => {
    expect(GetContextRemainingTool.Name).toBe(ToolNames.GET_CONTEXT_REMAINING);
    expect(ToolDisplayNames.GET_CONTEXT_REMAINING).toBe('GetContextRemaining');
  });

  it('reports window, used, remaining, and the auto-compaction level', async () => {
    const tool = new GetContextRemainingTool(
      configWithChat({
        promptTokens: 60_000,
        promptTokensIsEstimated: false,
        outputTokens: 4_000,
        contextWindowTokens: 128_000,
      }),
    );
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    const text = result.llmContent as string;
    expect(text).toContain('Context window: 128000 tokens');
    expect(text).toContain('Used: 64000 tokens');
    expect(text).toContain('Remaining: 64000 tokens');
    // 85% of the window is where the auto ladder sits.
    expect(text).toContain('near 108800 tokens');
    // API-reported counts carry no estimate marker.
    expect(text).not.toContain('estimated');
  });

  it('flags locally estimated counts', async () => {
    const tool = new GetContextRemainingTool(
      configWithChat({
        promptTokens: 10_000,
        promptTokensIsEstimated: true,
        outputTokens: 500,
        contextWindowTokens: 32_000,
      }),
    );
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('(estimated');
  });

  it('degrades to an error message without an active chat', async () => {
    const tool = new GetContextRemainingTool(configWithChat());
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('No active chat session.');
  });
});
