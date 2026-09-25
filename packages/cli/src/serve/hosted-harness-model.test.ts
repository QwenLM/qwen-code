/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCliConfig } from '../config/config.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

const state = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock('../config/settings.js', () => ({
  loadSettings: () => ({ merged: {} }),
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(async () => state.config),
}));

const input = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  cwd: '/workspace',
  history: [],
  prompt: 'hello',
  promptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function config(events: Array<{ type: LlmEventType; value?: unknown }>) {
  const tools = new Set(['run_shell_command']);
  const unregisterTool = vi.fn((name: string) => tools.delete(name));
  const setTools = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const setHistory = vi.fn();
  state.config = {
    initialize: vi.fn(async () => undefined),
    getModelsConfig: () => ({ getCurrentAuthType: () => 'test-auth' }),
    refreshAuth: vi.fn(async () => undefined),
    getToolRegistry: () => ({
      warmAll: vi.fn(async () => undefined),
      getAllTools: () => [...tools].map((name) => ({ name })),
      unregisterTool,
      getFunctionDeclarations: () => [...tools],
    }),
    getLlmClient: () => ({
      setTools,
      getChat: () => ({ setHistory }),
      async *sendMessageStream() {
        for (const event of events) yield event;
      },
    }),
    getModel: () => 'test-model',
    shutdown,
  };
  return { unregisterTool, setTools, shutdown, setHistory };
}

describe('Hosted Harness model boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes local tools before a text model request', async () => {
    const hooks = config([
      { type: LlmEventType.Content, value: 'hello back' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toEqual({
      text: 'hello back',
      model: 'test-model',
    });
    expect(hooks.unregisterTool).toHaveBeenCalledWith('run_shell_command');
    expect(hooks.setTools).toHaveBeenCalledOnce();
    expect(hooks.setHistory).toHaveBeenCalledWith([]);
    expect(hooks.shutdown).toHaveBeenCalledOnce();
    const args = vi.mocked(loadCliConfig).mock.calls[0];
    expect(args?.[1]).toMatchObject({ safeMode: true, chatRecording: false });
    expect(args?.[9]?.toolInvocationGuard?.({} as never)).toMatchObject({
      allowed: false,
    });
  });

  it('rejects a model tool request without executing it', async () => {
    const hooks = config([{ type: LlmEventType.ToolCallRequest }]);
    await expect(runHostedHarnessTextTurn(input)).rejects.toThrow(
      'refused a tool call',
    );
    expect(hooks.shutdown).toHaveBeenCalledOnce();
  });
});
