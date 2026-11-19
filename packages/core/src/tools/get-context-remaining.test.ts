/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { describe, expect, it, vi } from 'vitest';
import { GetContextRemainingTool } from './get-context-remaining.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

function configWithChat(
  snapshot?: {
    promptTokens: number;
    promptTokensIsEstimated: boolean;
    outputTokens: number;
    contextWindowTokens: number;
  },
  options?: {
    sessionTokenLimit?: number;
    autoCompactThreshold?: number;
    historyLength?: number;
    throwOnClient?: boolean;
  },
) {
  const chat = snapshot
    ? {
        getContextUsageSnapshot: () => snapshot,
        getHistory: () =>
          Array.from({ length: options?.historyLength ?? 0 }, () => ({})),
      }
    : undefined;
  const llmClient = chat ? { getChat: () => chat } : undefined;
  return {
    getLlmClient: vi.fn(() => {
      if (options?.throwOnClient) {
        throw new Error('no client yet');
      }
      return llmClient;
    }),
    getAutoCompactThreshold: vi
      .fn()
      .mockReturnValue(options?.autoCompactThreshold),
    getSessionTokenLimit: vi.fn().mockReturnValue(options?.sessionTokenLimit),
  } as unknown as Config;
}

async function runTool(config: Config): Promise<string> {
  const tool = new GetContextRemainingTool(config);
  const result = await tool.buildAndExecute(
    {} as never,
    new AbortController().signal,
  );
  return result.llmContent as string;
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
    expect(text).toContain('Remaining window headroom: 64000 tokens');
    // The real ladder: min(0.85*128K, 128K-20K-13K) = 95,000 — the
    // absolute cap branch wins on every common window size.
    expect(text).toContain('Auto-compaction level: 95000 tokens');
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

  it('honors a user autoCompactThreshold override (#17320 C2)', async () => {
    const tool = new GetContextRemainingTool({
      getLlmClient: vi.fn().mockReturnValue({
        getChat: () => ({
          getContextUsageSnapshot: () => ({
            promptTokens: 50_000,
            promptTokensIsEstimated: false,
            outputTokens: 1_000,
            contextWindowTokens: 128_000,
          }),
        }),
      }),
      // 0.5 * 128K = 64,000 < the absolute cap (95,000): the pct branch wins.
      getAutoCompactThreshold: vi.fn().mockReturnValue(0.5),
    } as unknown as Config);
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('Auto-compaction level: 64000 tokens');
  });

  it('degrades to an error message without an active chat', async () => {
    const tool = new GetContextRemainingTool(configWithChat());
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('No active chat session.');
  });

  it('degrades the same way when getLlmClient throws (R1-6 M5)', async () => {
    const text = await runTool(
      configWithChat(undefined, { throwOnClient: true }),
    );
    expect(text).toContain('No active chat session.');
  });

  it('rounds the auto-compaction level so the model never sees fractions (#17320 R4-4)', async () => {
    // 0.5 * 127,999 = 63,999.5 — the pct branch wins over the absolute cap.
    const text = await runTool(
      configWithChat(
        {
          promptTokens: 10_000,
          promptTokensIsEstimated: false,
          outputTokens: 500,
          contextWindowTokens: 127_999,
        },
        { autoCompactThreshold: 0.5 },
      ),
    );
    expect(text).toContain('Auto-compaction level: 64000 tokens');
    expect(text).not.toContain('63999.5');
    expect(text).not.toContain('63999');
  });

  it('reports headroom to the ladder, not just to the window (#17320 R4-2)', async () => {
    // 128K window, used 61,000: ladder at 95,000 → 34,000 until compaction.
    const text = await runTool(
      configWithChat({
        promptTokens: 59_000,
        promptTokensIsEstimated: false,
        outputTokens: 2_000,
        contextWindowTokens: 128_000,
      }),
    );
    expect(text).toContain('34000 until auto-compaction');
  });

  it('names the session limit when it binds tighter than the ladder (round-3 Low)', async () => {
    // Ladder 95,000 but the enforced bound is the 50,000 session limit:
    // the headline distance must be 9,000, not the ladder's 54,000.
    const text = await runTool(
      configWithChat(
        {
          promptTokens: 39_000,
          promptTokensIsEstimated: false,
          outputTokens: 2_000,
          contextWindowTokens: 128_000,
        },
        { sessionTokenLimit: 50_000 },
      ),
    );
    expect(text).toContain('9000 until the session token limit (50000)');
    expect(text).toContain(
      'Session token limit: 50000 tokens — the enforced bound, not the window',
    );
  });

  it('omits the session-limit line when none is configured', async () => {
    const text = await runTool(
      configWithChat({
        promptTokens: 10_000,
        promptTokensIsEstimated: false,
        outputTokens: 1_000,
        contextWindowTokens: 128_000,
      }),
    );
    expect(text).not.toContain('Session token limit');
    expect(text).toContain('until auto-compaction');
  });

  it('keeps the ladder, not the window, as the default binding bound', async () => {
    // Ladder 95,000 < limit 200,000: the ladder binds and is named.
    const text = await runTool(
      configWithChat(
        {
          promptTokens: 10_000,
          promptTokensIsEstimated: false,
          outputTokens: 1_000,
          contextWindowTokens: 128_000,
        },
        { sessionTokenLimit: 200_000 },
      ),
    );
    expect(text).toContain('until auto-compaction');
    expect(text).not.toContain('until the session token limit');
  });

  it('does not call a history-carrying session fresh after a model switch (#17320 F2)', async () => {
    // Counts reset when the route switches; history carries over. The tool
    // must not claim a fresh session and a fully free window.
    const text = await runTool(
      configWithChat(
        {
          promptTokens: 0,
          promptTokensIsEstimated: true,
          outputTokens: 0,
          contextWindowTokens: 128_000,
        },
        { historyLength: 6 },
      ),
    );
    expect(text).toContain(
      'no measurement on this model route yet — switching the model resets the counters while the conversation history carries over',
    );
    expect(text).not.toContain('fresh session');
  });

  it('calls a truly empty session fresh (R1-6 M4)', async () => {
    const text = await runTool(
      configWithChat({
        promptTokens: 0,
        promptTokensIsEstimated: true,
        outputTokens: 0,
        contextWindowTokens: 128_000,
      }),
    );
    expect(text).toContain('no measurement yet');
    expect(text).toContain('fresh session');
  });

  it('advises that screenshots can trigger compaction before the ladder (#17320 R4-5)', async () => {
    const text = await runTool(
      configWithChat({
        promptTokens: 10_000,
        promptTokensIsEstimated: false,
        outputTokens: 1_000,
        contextWindowTokens: 128_000,
      }),
    );
    expect(text).toContain('screenshots');
    expect(text).toContain('wrap up current work');
  });

  it('ships a complete description naming every reported field', () => {
    const tool = new GetContextRemainingTool(configWithChat());
    // Ends with a period (no orphaned fragment, F4) and names the
    // session-token limit clause added with it.
    expect(tool.description.endsWith('.')).toBe(true);
    expect(tool.description).toContain('session-token');
    expect(tool.description).not.toContain('request_compaction');
  });
});
