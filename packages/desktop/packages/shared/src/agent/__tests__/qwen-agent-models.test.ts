/* eslint-disable import/no-internal-modules */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelDefinition } from '../../config/models.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  QwenAgent,
  extractQwenParentToolUseId,
  formatQwenAcpErrorMessage,
  resolveQwenParentToolUseId,
} from '../qwen-agent.ts';

type QwenModelInternals = {
  recordSessionModels: (result: Record<string, unknown>) => void;
  applySessionSettings: (sessionId: string) => Promise<void>;
  callAcp: <T>(
    method: string,
    execute: (connection: {
      unstable_setSessionModel: (params: {
        sessionId: string;
        modelId: string;
      }) => Promise<T>;
      setSessionConfigOption: (params: {
        sessionId: string;
        configId: string;
        value: string;
      }) => Promise<T>;
      setSessionMode: (params: {
        sessionId: string;
        modeId: string;
      }) => Promise<T>;
    }) => Promise<T>,
  ) => Promise<T>;
  captureUsage: (update: Record<string, unknown>) => void;
  eventQueue: {
    drain: () => AsyncGenerator<unknown>;
  };
  extractUsage: (update: Record<string, unknown>) => {
    inputTokens: number;
    contextTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  } | null;
  extractLatestTokenUsage: (updates: Array<Record<string, unknown>>) =>
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        contextTokens: number;
        costUsd: number;
      }
    | undefined;
};

function createAgent(
  cwd: string,
  onAvailableModelsUpdate: BackendConfig['onAvailableModelsUpdate'],
): QwenAgent {
  return new QwenAgent({
    provider: 'qwen',
    workspace: {
      id: 'workspace-qwen',
      name: 'Qwen Workspace',
      slug: 'qwen-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'session-qwen',
      name: 'Qwen Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
    onAvailableModelsUpdate,
  } as BackendConfig);
}

async function readNextQueuedEvent(agent: QwenAgent): Promise<unknown> {
  const queue = (agent as unknown as QwenModelInternals).eventQueue;
  const iterator = queue.drain();
  const next = await iterator.next();
  await iterator.return?.(undefined);
  return next.value;
}

describe('QwenAgent ACP error formatting', () => {
  it('includes ACP internal error details in user-visible messages', () => {
    const error = Object.assign(new Error('Internal error'), {
      data: { details: '401 Unauthorized' },
    });

    expect(formatQwenAcpErrorMessage(error)).toBe(
      'Internal error: 401 Unauthorized',
    );
  });

  it('uses nested provider messages from ACP internal error data', () => {
    const error = Object.assign(new Error('Internal error'), {
      data: {
        error: {
          message: 'Model access denied',
          code: 'PermissionDenied',
        },
      },
    });

    expect(formatQwenAcpErrorMessage(error)).toBe(
      'Internal error: Model access denied',
    );
  });
});

describe('QwenAgent model metadata', () => {
  it('extracts subagent parent metadata from Qwen ACP updates', () => {
    expect(
      extractQwenParentToolUseId({
        _meta: {
          parentToolCallId: 'agent-parent-1',
          subagentType: 'general-purpose',
        },
      }),
    ).toBe('agent-parent-1');
  });

  it('falls back to the only active parent tool without self-referencing', () => {
    expect(
      resolveQwenParentToolUseId({
        update: {},
        toolUseId: 'read-child-1',
        activeParentToolUseIds: new Set(['agent-parent-1']),
      }),
    ).toBe('agent-parent-1');

    expect(
      resolveQwenParentToolUseId({
        update: {},
        toolUseId: 'agent-parent-1',
        activeParentToolUseIds: new Set(['agent-parent-1']),
      }),
    ).toBeUndefined();
  });

  it('uses ACP-reported context and thinking metadata without a hardcoded context fallback', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    let capturedModels: ModelDefinition[] = [];
    let capturedCurrent: string | undefined;
    const agent = createAgent(cwd, (models, currentModelId) => {
      capturedModels = models;
      capturedCurrent = currentModelId;
    });

    (agent as unknown as QwenModelInternals).recordSessionModels({
      models: {
        currentModelId: 'qwen3-coder-flash',
        availableModels: [
          {
            modelId: 'qwen3-coder-flash',
            name: 'GLM 5.1',
            _meta: {
              contextLimit: 128_000,
              enable_thinking: false,
            },
          },
          {
            modelId: 'qwen3-coder-plus',
            name: 'Qwen3 Coder Plus',
          },
        ],
      },
    });

    expect(agent.getModel()).toBe('qwen3-coder-flash');
    expect(capturedCurrent).toBe('qwen3-coder-flash');
    expect(capturedModels[0]).toMatchObject({
      id: 'qwen3-coder-flash',
      contextWindow: 128_000,
      supportsThinking: false,
    });
    expect(capturedModels[1]?.id).toBe('qwen3-coder-plus');
    expect(capturedModels[1]).not.toHaveProperty('contextWindow');
  });

  it('uses ACP total tokens for context usage without double-counting cached tokens', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as QwenModelInternals).extractUsage({
      _meta: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 20,
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      contextTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 20,
    });
  });

  it('applies configured session models through ACP session/set_model', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});
    const internals = agent as unknown as QwenModelInternals;
    const methods: string[] = [];
    const setModelParams: Array<{ sessionId: string; modelId: string }> = [];

    internals.recordSessionModels({
      models: {
        currentModelId: 'qwen3-coder-flash',
        availableModels: [
          {
            modelId: 'qwen3-coder-flash',
            name: 'Qwen3 Coder Flash',
          },
          {
            modelId: 'qwen3-coder-plus',
            name: 'Qwen3 Coder Plus',
          },
        ],
      },
    });
    agent.setModel('qwen3-coder-plus');

    internals.callAcp = async (method, execute) => {
      methods.push(method);
      return execute({
        unstable_setSessionModel: async (params) => {
          setModelParams.push(params);
          return undefined as Awaited<ReturnType<typeof execute>>;
        },
        setSessionConfigOption: async () =>
          undefined as Awaited<ReturnType<typeof execute>>,
        setSessionMode: async () =>
          undefined as Awaited<ReturnType<typeof execute>>,
      });
    };

    await internals.applySessionSettings('qwen-session-1');

    expect(methods).toContain('session/set_model');
    expect(methods).not.toContain('session/set_config_option');
    expect(setModelParams).toContainEqual({
      sessionId: 'qwen-session-1',
      modelId: 'qwen3-coder-plus',
    });
  });

  it('falls back to ACP input tokens for context usage when total tokens are unavailable', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as QwenModelInternals).extractUsage({
      _meta: {
        usage: {
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      contextTokens: 100,
      outputTokens: undefined,
      cacheReadTokens: 20,
    });
  });

  it('ignores empty ACP usage instead of resetting context usage to zero', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as QwenModelInternals).extractUsage({
      _meta: {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      },
    });

    expect(usage).toBeNull();
  });

  it('extracts latest replay usage for loaded Qwen native history', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});

    const tokenUsage = (
      agent as unknown as QwenModelInternals
    ).extractLatestTokenUsage([
      {
        sessionUpdate: 'agent_message_chunk',
        _meta: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        _meta: {
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 40,
            totalTokenCount: 240,
          },
        },
      },
    ]);

    expect(tokenUsage).toEqual({
      inputTokens: 240,
      outputTokens: 40,
      totalTokens: 240,
      contextTokens: 240,
      costUsd: 0,
    });
  });

  it('emits context ring usage with the same total-token semantics as /context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const agent = createAgent(cwd, () => {});
    const internals = agent as unknown as QwenModelInternals;

    internals.captureUsage({
      _meta: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 20,
        },
      },
    });

    await expect(readNextQueuedEvent(agent)).resolves.toEqual({
      type: 'usage_update',
      usage: {
        inputTokens: 150,
      },
    });
  });
});
