/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import {
  FatalAuthenticationError,
  MissingSessionModelProviderError,
  QWEN_SUBSCRIPTION_SIGNED_OUT_HINT,
  QwenSubscriptionOAuthError,
  type Config,
  type SDKMessage,
} from '@qwen-code/core';
import {
  createAcpSessionHost,
  refreshAcpSessionState,
  toAcpRequestError,
} from './acpSessionHost.js';
import { createDefaultAcpModelAdapter } from './acpSupport.js';

describe('ACP 异步模型状态', () => {
  function fixture() {
    const config = {
      getModel: vi.fn(() => 'model-1'),
      getModelRequestIdentity: vi.fn(() => 'account-1'),
      getSessionId: vi.fn(() => 'session-1'),
      getPermissionMode: vi.fn(() => 'default'),
    } as unknown as Config;
    const adapter = {
      buildAvailableModels: vi.fn(async () => ({
        availableModels: [{ modelId: 'model-1', name: 'Model 1' }],
        currentModelId: 'model-1',
      })),
      buildReasoningEffortOption: vi.fn(
        async (): Promise<acp.SessionConfigOption | null> => null,
      ),
    };
    const { state } = createAcpSessionHost({
      sessionId: 'session-1',
      cwd: '/workspace',
      clientCapabilities: undefined,
      mcpServers: [],
      additionalDirectories: [],
      modelAdapter: adapter,
      connection: {
        sessionUpdate: vi.fn(async () => ({})),
      } as unknown as acp.AgentSideConnection,
      ensureAuthReady: async () => {},
      resolveConfig: () => config,
      setModeForExitPlan: async () => {},
    });
    return { state, config, adapter };
  }

  it('能力查询完成后一次提交模型、模式和配置选项', async () => {
    const { state, config, adapter } = fixture();
    let resolve!: (value: acp.SessionConfigOption | null) => void;
    adapter.buildReasoningEffortOption.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = refreshAcpSessionState(state, config);
    await vi.waitFor(() =>
      expect(adapter.buildReasoningEffortOption).toHaveBeenCalledOnce(),
    );
    expect(state.models.availableModels).toEqual([]);
    expect(state.configOptions).toEqual([]);
    resolve({
      type: 'select',
      id: 'reasoning_effort',
      name: 'Effort',
      currentValue: 'high',
      options: [{ value: 'high', name: 'High' }],
    });
    await expect(pending).resolves.toEqual({
      modeChanged: false,
      modelsChanged: true,
    });
    expect(state.models.currentModelId).toBe('model-1');
    expect(state.configOptions.map((option) => option.id)).toEqual([
      'mode',
      'model',
      'reasoning_effort',
    ]);
  });

  it.each([
    'model',
    'account',
    'session',
    'mode',
    'disposed',
    'aborted',
  ] as const)('丢弃目录查询期间 %s 变化后的迟到结果', async (changed) => {
    const { state, config, adapter } = fixture();
    let resolve!: (
      value: Awaited<ReturnType<typeof adapter.buildAvailableModels>>,
    ) => void;
    adapter.buildAvailableModels.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = refreshAcpSessionState(state, config);
    if (changed === 'model')
      vi.mocked(config.getModel).mockReturnValue('model-2');
    if (changed === 'account')
      vi.mocked(config.getModelRequestIdentity).mockReturnValue('account-2');
    if (changed === 'session')
      vi.mocked(config.getSessionId).mockReturnValue('session-2');
    if (changed === 'mode')
      vi.mocked(config.getPermissionMode).mockReturnValue('yolo');
    if (changed === 'disposed') state.disposed = true;
    if (changed === 'aborted') state.abortController.abort();
    resolve({
      availableModels: [{ modelId: 'stale', name: 'Stale' }],
      currentModelId: 'model-1',
    });
    await expect(pending).resolves.toEqual({
      modeChanged: false,
      modelsChanged: false,
    });
    expect(state.models.availableModels).toEqual([]);
    expect(state.configOptions).toEqual([]);
  });

  it('先发查询后完成不能覆盖较新的目录', async () => {
    const { state, config, adapter } = fixture();
    let resolve!: (
      value: Awaited<ReturnType<typeof adapter.buildAvailableModels>>,
    ) => void;
    adapter.buildAvailableModels.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = refreshAcpSessionState(state, config);
    await refreshAcpSessionState(state, config);
    const latest = state.models;
    resolve({
      availableModels: [{ modelId: 'stale', name: 'Stale' }],
      currentModelId: 'model-1',
    });
    await pending;
    expect(state.models).toBe(latest);
  });

  it('查询失败不部分更新协议状态', async () => {
    const { state, config, adapter } = fixture();
    const before = state.models;
    adapter.buildReasoningEffortOption.mockRejectedValueOnce(
      new Error('unavailable'),
    );
    await expect(refreshAcpSessionState(state, config)).rejects.toThrow(
      'unavailable',
    );
    expect(state.models).toBe(before);
    expect(state.configOptions).toEqual([]);
  });
});

describe('ACP prompt usage', () => {
  it('maps token usage into usage and quota metadata', async () => {
    const connection = {
      sessionUpdate: vi.fn(async () => ({})),
    } as unknown as acp.AgentSideConnection;
    const config = {
      toolCallSnapshots: {
        subscribeToolCallSnapshots: vi.fn(() => () => {}),
      },
    } as unknown as Config;
    const { host } = createAcpSessionHost({
      sessionId: 'session-1',
      cwd: '/workspace',
      clientCapabilities: undefined,
      mcpServers: [],
      additionalDirectories: [],
      modelAdapter: createDefaultAcpModelAdapter(),
      connection,
      ensureAuthReady: async () => {},
      resolveConfig: () => config,
      setModeForExitPlan: async () => {},
    });

    const handle = host.beginPrompt('command-1', 'hello');
    host.events.emit({
      kind: 'commandLifecycle',
      commandUuid: 'command-1',
      state: 'started',
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'assistant',
        message: {
          content: [],
          model: 'test-model',
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        },
      } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'result',
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
        modelUsage: {
          'test-model': {
            inputTokens: 12,
            outputTokens: 3,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 2,
          },
        },
      } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'commandLifecycle',
      commandUuid: 'command-1',
      state: 'completed',
    });

    const response = await handle.promise;
    expect(response.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedReadTokens: 4,
      cachedWriteTokens: 2,
    });
    expect(response._meta).toMatchObject({
      quota: {
        token_count: {
          input_tokens: 12,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
        model_usage: [
          {
            model: 'test-model',
            token_count: {
              input_tokens: 12,
              output_tokens: 3,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
            },
          },
        ],
      },
    });
  });
});


describe('ACP inference preparation forwarding', () => {
  it('forwards the session Config and cancellation signal to its product host', async () => {
    const prepareInference = vi.fn(async () => {});
    const { host } = createAcpSessionHost({
      sessionId: 'session-1', cwd: '/workspace', clientCapabilities: undefined,
      mcpServers: [], additionalDirectories: [],
      modelAdapter: createDefaultAcpModelAdapter(),
      connection: {} as acp.AgentSideConnection,
      ensureAuthReady: async () => {}, prepareInference,
      resolveConfig: () => ({} as Config), setModeForExitPlan: async () => {},
    });
    const input = { config: {} as Config, signal: new AbortController().signal,
      catalogReadyInitialize: false };
    await host.requests.prepareInference!(input);
    expect(prepareInference).toHaveBeenCalledExactlyOnceWith(input);
  });
});


describe('ACP one-shot permission options', () => {
  it.each(['proceed_once', 'proceed_always_and_save'] as const)('keeps host choices and rejects an unoffered persistent grant (%s)', async (selected) => {
    const requestPermission = vi.fn(async (_request: acp.RequestPermissionRequest) => ({ outcome: { outcome: 'selected', optionId: selected } }));
    const config = { getToolRegistry: () => ({ getTool: () => undefined }) } as unknown as Config;
    const { host } = createAcpSessionHost({ sessionId: 'policy-session', cwd: '/workspace', clientCapabilities: undefined, mcpServers: [], additionalDirectories: [], modelAdapter: createDefaultAcpModelAdapter(), connection: { sessionUpdate: vi.fn(async () => ({})), requestPermission } as unknown as acp.AgentSideConnection, ensureAuthReady: async () => {}, resolveConfig: () => config, setModeForExitPlan: async () => {} });
    const result = await host.requests.canUseTool!({ toolName: 'Read', input: { file_path: '/workspace/private.txt' }, suggestions: [], blockedPath: undefined, title: 'Read file', description: undefined, toolUseId: 'one-shot', displayName: 'Read', details: { type: 'file_read', title: 'Read file', filePath: '/workspace/private.txt' }, options: [{ outcome: 'proceed_once', name: 'Allow once', allowed: true }, { outcome: 'cancel', name: 'Reject', allowed: false }] });
    expect(requestPermission.mock.calls[0][0].options.map((o: acp.PermissionOption) => o.kind)).toEqual(['allow_once', 'reject_once']);
    expect(result.behavior).toBe(selected === 'proceed_once' ? 'allow' : 'deny');
  });
});

describe('ACP background continuation projection', () => {
  function fixture() {
    const connection = {
      sessionUpdate: vi.fn(async () => ({})),
    } as unknown as acp.AgentSideConnection;
    const config = {
      toolCallSnapshots: {
        subscribeToolCallSnapshots: vi.fn(() => () => {}),
      },
      getToolRegistry: () => ({ getTool: () => undefined }),
    } as unknown as Config;
    const { state, host } = createAcpSessionHost({
      sessionId: 'session-1',
      cwd: '/workspace',
      clientCapabilities: undefined,
      mcpServers: [],
      additionalDirectories: [],
      modelAdapter: createDefaultAcpModelAdapter(),
      connection,
      ensureAuthReady: async () => {},
      resolveConfig: () => config,
      setModeForExitPlan: async () => {},
    });
    state.active = true;
    return { state, host, connection };
  }

  it('projects synthetic continuation frames without a client prompt', async () => {
    const { state, host, connection } = fixture();
    host.events.emit({
      kind: 'messageReplay',
      message: { type: 'user', isSynthetic: true },
      commandUuid: 'background-1',
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'task finished' },
        },
      } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
      } as unknown as SDKMessage,
    });

    await vi.waitFor(() =>
      expect(connection.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'task finished' },
        },
      }),
    );
    await vi.waitFor(() => expect(state.pendingCommands.size).toBe(0));
    expect(state.activeCommandUuid).toBeUndefined();
  });

  it('projects background tool calls', async () => {
    const { host, connection } = fixture();
    host.events.emit({
      kind: 'messageReplay',
      message: { type: 'user', isSynthetic: true },
      commandUuid: 'background-2',
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/workspace/a.ts' },
            },
          ],
        },
      } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'ok',
            },
          ],
        },
      } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
      } as unknown as SDKMessage,
    });

    await vi.waitFor(() =>
      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
          }),
        }),
      ),
    );
  });

  it('does not project a replayed user message without a pending prompt', async () => {    const { state, host, connection } = fixture();
    host.events.emit({
      kind: 'messageReplay',
      message: { type: 'user', isSynthetic: false },
      commandUuid: 'duplicate-1',
    });
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ignored' },
        },
      } as unknown as SDKMessage,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.sessionUpdate).not.toHaveBeenCalled();
    expect(state.pendingCommands.size).toBe(0);
  });
});

describe('ACP prompt userMessageId', () => {
  function fixture() {
    const connection = {
      sessionUpdate: vi.fn(async () => ({})),
    } as unknown as acp.AgentSideConnection;
    const config = {
      toolCallSnapshots: {
        subscribeToolCallSnapshots: vi.fn(() => () => {}),
      },
      getToolRegistry: () => ({ getTool: () => undefined }),
    } as unknown as Config;
    const { host } = createAcpSessionHost({
      sessionId: 'session-1',
      cwd: '/workspace',
      clientCapabilities: undefined,
      mcpServers: [],
      additionalDirectories: [],
      modelAdapter: createDefaultAcpModelAdapter(),
      connection,
      ensureAuthReady: async () => {},
      resolveConfig: () => config,
      setModeForExitPlan: async () => {},
    });
    return { host };
  }

  function emitPrompt(
    host: ReturnType<typeof createAcpSessionHost>['host'],
    commandUuid: string,
    result: Record<string, unknown>,
  ): void {
    host.events.emit({
      kind: 'commandLifecycle',
      commandUuid,
      state: 'started',
    });
    host.events.emit({
      kind: 'messageReplay',
      message: { type: 'user', isSynthetic: false },
      commandUuid,
    });
    host.events.emit({
      kind: 'threadMessage',
      message: { type: 'result', ...result } as unknown as SDKMessage,
    });
    host.events.emit({
      kind: 'commandLifecycle',
      commandUuid,
      state: 'completed',
    });
  }

  it('echoes the recorded user message id for model turns', async () => {
    const { host } = fixture();
    const handle = host.beginPrompt('command-1', 'hello');
    emitPrompt(host, 'command-1', {
      subtype: 'success',
      num_turns: 1,
    });
    await expect(handle.promise).resolves.toMatchObject({
      userMessageId: 'command-1',
    });
  });

  it('omits the user message id for local command results', async () => {
    const { host } = fixture();
    const handle = host.beginPrompt('command-2', undefined);
    emitPrompt(host, 'command-2', {
      subtype: 'success',
      num_turns: 0,
      result: 'Rewound to before message previous-user.',
    });
    const response = await handle.promise;
    expect(response).not.toHaveProperty('userMessageId');
  });
});

describe('ACP request error mapping', () => {
  it('keeps the upstream rate-limit status', () => {
    const error = Object.assign(new Error('too many requests'), {
      status: 429,
    });
    const mapped = toAcpRequestError(error);
    expect(mapped.code).toBe(429);
    expect(mapped.message).toBe('Rate limit exceeded. Try again later.');
  });

  it('keeps other upstream HTTP statuses', () => {
    const error = Object.assign(new Error('upstream failed'), { status: 502 });
    const mapped = toAcpRequestError(error);
    expect(mapped.code).toBe(502);
    expect(mapped.message).toBe('upstream failed');
  });

  it('maps missing session ModelProvider errors to authRequired with authMethods', () => {
    const authMethods = [
      { id: 'qwen-subscription', name: 'Sign in with Qwen' },
    ];
    const mapped = toAcpRequestError(
      new MissingSessionModelProviderError(),
      authMethods,
    );
    expect(mapped.code).toBe(-32000);
    expect(mapped.data).toEqual({ authMethods });

    const serialized = toAcpRequestError(
      new Error('A session ModelProvider is required for inference.'),
      authMethods,
    );
    expect(serialized.code).toBe(-32000);
    expect(serialized.data).toEqual({ authMethods });
  });

  it('maps subscription session_changed, signed-out hint, and FatalAuthenticationError to authRequired', () => {
    const subError = new QwenSubscriptionOAuthError(
      'session_changed',
      undefined,
      'Your Qwen session expired.',
    );
    const mappedSub = toAcpRequestError(subError);
    expect(mappedSub.code).toBe(-32000);

    const hintError = new Error(QWEN_SUBSCRIPTION_SIGNED_OUT_HINT);
    expect(toAcpRequestError(hintError).code).toBe(-32000);

    const fatalAuth = new FatalAuthenticationError('Token revoked');
    const mappedFatal = toAcpRequestError(fatalAuth);
    expect(mappedFatal.code).toBe(-32000);
  });

  it('preserves generic HTTP 401 for custom providers without forcing authRequired', () => {
    const error = Object.assign(new Error('Invalid API key'), { status: 401 });
    const mapped = toAcpRequestError(error);
    expect(mapped.code).toBe(401);
    expect(mapped.message).toBe('Invalid API key');
  });
});

describe('createDefaultAcpModelAdapter', () => {
  it('lists enabled models from ModelProviderManager and picks the provider default instead of auto', async () => {
    const adapter = createDefaultAcpModelAdapter();
    const config = {
      getModel: () => 'auto',
      getModelProviderManager: () => ({
        listModels: vi.fn(async () => [
          {
            source: 'qwen-subscription',
            key: 'qwen-subscription/qwen4-max',
            displayName: 'Qwen4-Max',
            enabled: true,
            isDefault: true,
            capabilities: {
              tools: true,
              vision: true,
              reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
              contextWindows: [],
            },
            limits: { maxContextTokens: 1_000_000 },
          },
          {
            source: 'qwen-subscription',
            key: 'qwen-subscription/disabled',
            displayName: 'Disabled',
            enabled: false,
            capabilities: {
              tools: true,
              vision: false,
              reasoning: { supported: false, supportedEfforts: [] },
              contextWindows: [],
            },
            limits: { maxContextTokens: 128_000 },
          },
        ]),
        getModel: vi.fn(async () => ({
          source: 'qwen-subscription',
          key: 'qwen-subscription/qwen4-max',
          displayName: 'Qwen4-Max',
          capabilities: {
            tools: true,
            vision: true,
            reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
            contextWindows: [],
          },
          limits: { maxContextTokens: 1_000_000 },
        })),
        getModelConfig: vi.fn(() => ({ reasoning: { effort: 'high' } })),
      }),
    } as unknown as Config;

    const models = await adapter.buildAvailableModels(config);
    expect(models).toEqual({
      availableModels: [
        {
          modelId: 'qwen-subscription/qwen4-max',
          name: 'Qwen4-Max (default)',
          description: 'Reasoning · Vision',
        },
      ],
      currentModelId: 'qwen-subscription/qwen4-max',
    });

    const effort = await adapter.buildReasoningEffortOption?.(config);
    expect(effort).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    });
  });

  it('uses model defaultModelConfig reasoning effort when no user preference is stored', async () => {
    const adapter = createDefaultAcpModelAdapter();
    const config = {
      getModel: () => 'qwen-subscription/qwen4-max',
      getModelProviderManager: () => ({
        getModel: vi.fn(async () => ({
          source: 'qwen-subscription',
          key: 'qwen-subscription/qwen4-max',
          displayName: 'Qwen4-Max',
          capabilities: {
            tools: true,
            vision: true,
            reasoning: {
              supported: true,
              supportedEfforts: ['none', 'low', 'medium', 'high'],
            },
            contextWindows: [],
          },
          limits: { maxContextTokens: 1_000_000 },
          defaultModelConfig: {
            reasoning: { effort: 'medium' },
          },
        })),
        getModelConfig: vi.fn(() => undefined),
      }),
    } as unknown as Config;

    const effort = await adapter.buildReasoningEffortOption?.(config);
    expect(effort).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'medium',
    });
  });

  it('clamps a stale stored reasoning effort preference that is no longer supported', async () => {
    const adapter = createDefaultAcpModelAdapter();
    const config = {
      getModel: () => 'qwen-subscription/qwen4-max',
      getModelProviderManager: () => ({
        getModel: vi.fn(async () => ({
          source: 'qwen-subscription',
          key: 'qwen-subscription/qwen4-max',
          displayName: 'Qwen4-Max',
          capabilities: {
            tools: true,
            vision: true,
            reasoning: {
              supported: true,
              supportedEfforts: ['none', 'low', 'medium', 'high'],
            },
            contextWindows: [],
          },
          limits: { maxContextTokens: 1_000_000 },
          defaultModelConfig: {
            reasoning: { effort: 'medium' },
          },
        })),
        getModelConfig: vi.fn(() => ({ reasoning: { effort: 'xhigh' } })),
      }),
    } as unknown as Config;

    const effort = await adapter.buildReasoningEffortOption?.(config);
    expect(effort).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'medium',
    });
  });

  it('falls back to auto when no models are returned', async () => {
    const adapter = createDefaultAcpModelAdapter();
    const config = {
      getModel: () => '',
      getModelProviderManager: () => ({
        listModels: vi.fn(async () => []),
      }),
    } as unknown as Config;

    const models = await adapter.buildAvailableModels(config);
    expect(models).toEqual({
      availableModels: [{ modelId: 'auto', name: 'auto' }],
      currentModelId: 'auto',
    });
  });
});
