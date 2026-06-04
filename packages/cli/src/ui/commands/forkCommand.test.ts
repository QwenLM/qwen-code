/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { forkCommand } from './forkCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{{${k}}}`, v),
        key,
      );
    }
    return key;
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({ debug: () => undefined }),
  ToolNames: { AGENT: 'agent' },
}));

describe('forkCommand', () => {
  let mockContext: CommandContext;
  let mockExecute: ReturnType<typeof vi.fn>;
  let mockBuild: ReturnType<typeof vi.fn>;
  let mockGetTool: ReturnType<typeof vi.fn>;

  const historyWithTurn = [
    { role: 'user' as const, parts: [{ text: 'hello' }] },
    { role: 'model' as const, parts: [{ text: 'hi there' }] },
  ];

  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getGeminiClient: () => ({ getHistory: () => historyWithTurn }),
    getModel: () => 'test-model',
    getToolRegistry: () => ({ getTool: mockGetTool }),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute = vi.fn().mockResolvedValue({ llmContent: 'launched' });
    mockBuild = vi.fn().mockReturnValue({ execute: mockExecute });
    mockGetTool = vi.fn().mockReturnValue({ build: mockBuild });
    mockContext = createMockCommandContext({
      services: { config: createConfig() },
    });
  });

  it('has correct metadata', () => {
    expect(forkCommand.name).toBe('fork');
    expect(forkCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(forkCommand.description).toBeTruthy();
  });

  it('returns usage error when no directive is provided', async () => {
    const result = await forkCommand.action!(mockContext, '   ');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a directive. Usage: /fork <directive>',
    });
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns error when config is not available', async () => {
    const noConfig = createMockCommandContext({
      services: { config: null },
    });
    const result = await forkCommand.action!(noConfig, 'do something');
    expect(result).toMatchObject({
      messageType: 'error',
      content: 'Config is not available.',
    });
  });

  it('refuses to fork while a response/tool call is in progress', async () => {
    const busy = createMockCommandContext({
      services: { config: createConfig() },
      ui: { isIdleRef: { current: false } },
    });
    const result = await forkCommand.action!(busy, 'do something');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(String((result as { content: string }).content)).toContain(
      'in progress',
    );
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('refuses to fork before the first conversation turn', async () => {
    const fresh = createMockCommandContext({
      services: {
        config: createConfig({
          getGeminiClient: () => ({ getHistory: () => [] }),
        }),
      },
    });
    const result = await forkCommand.action!(fresh, 'do something');
    expect(result).toMatchObject({
      messageType: 'error',
      content: 'Cannot fork before the first conversation turn.',
    });
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('errors when the agent tool is unavailable', async () => {
    mockGetTool.mockReturnValue(undefined);
    const result = await forkCommand.action!(mockContext, 'do something');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(String((result as { content: string }).content)).toContain(
      'agent tool',
    );
  });

  it('launches a background fork via the Agent tool and returns immediately', async () => {
    const result = await forkCommand.action!(
      mockContext,
      'review the current code',
    );

    // Fetches the Agent tool by its registered name.
    expect(mockGetTool).toHaveBeenCalledWith('agent');

    // Builds a background fork: full directive as prompt, run_in_background,
    // no subagent_type (→ implicit FORK_AGENT).
    expect(mockBuild).toHaveBeenCalledTimes(1);
    const builtParams = mockBuild.mock.calls[0][0];
    expect(builtParams.prompt).toBe('review the current code');
    expect(builtParams.run_in_background).toBe(true);
    expect(builtParams.subagent_type).toBeUndefined();
    expect(builtParams.description).toBeTruthy();

    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Immediate, non-blocking confirmation.
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
  });

  it('truncates an overlong directive for the panel label', async () => {
    const long = 'x'.repeat(200);
    await forkCommand.action!(mockContext, long);
    const builtParams = mockBuild.mock.calls[0][0];
    expect(builtParams.prompt).toBe(long); // full directive preserved
    expect(builtParams.description.length).toBeLessThanOrEqual(60); // label truncated
  });

  it('surfaces an error when the launch throws', async () => {
    mockExecute.mockRejectedValue(new Error('concurrency cap reached'));
    const result = await forkCommand.action!(mockContext, 'do something');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(String((result as { content: string }).content)).toContain(
      'concurrency cap reached',
    );
  });

  it('surfaces an error when the launch fails without throwing (e.g. concurrency cap)', async () => {
    // The Agent tool does not reject on a failed background launch — it
    // resolves with a result whose display status is 'failed'.
    mockExecute.mockResolvedValue({
      llmContent: 'Cannot start background agent: maximum (10) reached.',
      returnDisplay: { status: 'failed' },
    });
    const result = await forkCommand.action!(mockContext, 'do something');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(String((result as { content: string }).content)).toContain(
      'maximum (10) reached',
    );
  });

  it('treats a non-failed result as a successful launch', async () => {
    mockExecute.mockResolvedValue({
      llmContent: 'Background agent launched successfully.',
      returnDisplay: { status: 'background' },
    });
    const result = await forkCommand.action!(mockContext, 'do something');
    expect(result).toMatchObject({ messageType: 'info' });
  });
});
