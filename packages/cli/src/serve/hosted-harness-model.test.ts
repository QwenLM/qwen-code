/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCliConfig } from '../config/config.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

const state = vi.hoisted(() => ({
  config: undefined as unknown as {
    [key: string]: unknown;
    setUserMemory: ReturnType<typeof vi.fn>;
    getLlmClient(): {
      [key: string]: unknown;
      sendMessageStream(...args: never[]): AsyncGenerator<unknown, void>;
    };
  },
}));
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

function config(
  events: Array<{
    type: LlmEventType;
    value?: unknown;
    isContinuation?: boolean;
  }>,
) {
  const tools = new Set(['run_shell_command']);
  const unregisterTool = vi.fn((name: string) => tools.delete(name));
  const setTools = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const setHistory = vi.fn();
  const setUserMemory = vi.fn();
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
    setUserMemory,
    shutdown,
  };
  return { unregisterTool, setTools, shutdown, setHistory, setUserMemory };
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

  it('discards abandoned output after a fresh retry or model fallback', async () => {
    config([
      { type: LlmEventType.Content, value: 'first attempt' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'second attempt' },
      { type: LlmEventType.ModelFallback },
      { type: LlmEventType.Content, value: 'final answer' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'final answer',
    });
  });

  it('discards abandoned output after a fresh retry alone', async () => {
    config([
      { type: LlmEventType.Content, value: 'first attempt' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'final answer' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'final answer',
    });
  });

  it('keeps output across a continuation and accepts chat compaction', async () => {
    config([
      { type: LlmEventType.Content, value: 'first' },
      { type: LlmEventType.Retry, isContinuation: true },
      { type: LlmEventType.ChatCompressed },
      { type: LlmEventType.Content, value: ' second' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'first second',
    });
  });

  it('keeps a completed answer when config cleanup fails', async () => {
    const hooks = config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    hooks.shutdown.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'answer',
    });
  });

  it('injects the Workspace context fetched before the turn', async () => {
    const order: string[] = [];
    const hooks = config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    hooks.setUserMemory.mockImplementation(() => {
      order.push('inject');
    });
    const client = state.config.getLlmClient();
    const stream = client.sendMessageStream.bind(client);
    state.config.getLlmClient = () => ({
      ...client,
      async *sendMessageStream() {
        order.push('request');
        yield* stream();
      },
    });
    await expect(
      runHostedHarnessTextTurn({
        ...input,
        workspaceContext: { read: () => 'project rules' },
      }),
    ).resolves.toMatchObject({ text: 'answer' });
    expect(hooks.setUserMemory).toHaveBeenCalledWith('project rules');
    expect(order).toEqual(['inject', 'request']);
  });

  it('picks up the Workspace context a tool batch fetched, on the next request', async () => {
    const order: string[] = [];
    let context: string | undefined;
    const rounds = [
      [
        {
          type: LlmEventType.ToolCallRequest,
          value: {
            callId: 'call-1',
            name: 'read_file',
            args: { file_path: 'QWEN.md' },
            isClientInitiated: false,
            prompt_id: input.promptId,
          },
        },
        { type: LlmEventType.Finished },
      ],
      [
        { type: LlmEventType.Content, value: 'done' },
        { type: LlmEventType.Finished },
      ],
    ];
    const hooks = config([]);
    hooks.setUserMemory.mockImplementation(() => {
      order.push('inject');
    });
    let requests = 0;
    state.config.getLlmClient = () => ({
      setTools: vi.fn(async () => undefined),
      getChat: () => ({ setHistory: vi.fn(), setTools: vi.fn() }),
      getHistory: () => [
        {
          role: 'model',
          parts:
            requests <= 1
              ? [{ functionCall: { name: 'read_file' } }]
              : [{ text: 'done' }],
        },
      ],
      async *sendMessageStream() {
        requests++;
        order.push('request');
        for (const event of rounds.shift() ?? []) yield event;
      },
    });
    const toolTurn = {
      declarations: vi.fn(async () => []),
      consumeResults: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        context = 'project rules';
        return [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'rules' },
            },
          },
        ];
      }),
    };
    await expect(
      runHostedHarnessTextTurn({
        ...input,
        toolTurn: toolTurn as never,
        workspaceContext: { read: () => context },
      }),
    ).resolves.toMatchObject({ text: 'done', model: 'test-model' });
    expect(toolTurn.execute).toHaveBeenCalledOnce();
    expect(hooks.setUserMemory).toHaveBeenCalledWith('project rules');
    expect(order).toEqual(['request', 'inject', 'request']);
  });
});
