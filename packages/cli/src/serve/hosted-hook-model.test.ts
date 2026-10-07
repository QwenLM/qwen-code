/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { TurnBudget } from '@qwen-code/qwen-code-core/core/turn-budget.js';
import {
  HookEventName,
  HookType,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedHookModelScope } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCliConfig } from '../config/config.js';
import * as stdio from '../utils/stdioHelpers.js';
import {
  createHostedPromptHookRunner,
  runHostedHookOperation,
} from './hosted-hook-model.js';

const state = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock('../config/settings.js', () => ({
  loadSettings: () => ({ merged: {} }),
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(async () => state.config),
}));

const hook = { type: HookType.Prompt as const, prompt: '$ARGUMENTS' };
const input = {
  session_id: 'session-1',
  transcript_path: '',
  cwd: '/workspace',
  hook_event_name: HookEventName.SessionEnd,
  timestamp: '2026-09-30T00:00:00.000Z',
  managed_hook_execution_id: 'execution-1',
  managed_hook_occurrence_id: 'occurrence-1',
  managed_hook_origin_turn_id: null,
};

const response = (text = '{"ok":true}') =>
  ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { totalTokenCount: 7 },
  }) as GenerateContentResponse;

function fixture() {
  const generateContent = vi.fn(async () => response());
  const generator = {
    generateContent,
    generateContentStream: vi.fn(),
    embedContent: vi.fn(),
  };
  const config = {
    initialize: vi.fn(async () => undefined),
    getModelsConfig: () => ({ getCurrentAuthType: () => 'test-auth' }),
    refreshAuth: vi.fn(async () => undefined),
    getModel: () => 'model-1',
    getTurnBudget: () => new TurnBudget(),
    getContentGenerator: () => generator,
    getContentGeneratorConfig: () => ({}),
    getBaseLlmClient: () => ({ resolveForModel: vi.fn() }),
    shutdown: vi.fn(async () => undefined),
  };
  state.config = config;
  const usage = vi.fn();
  const evaluate = vi.fn<ManagedHookModelScope['evaluate']>(
    async (_operation, run) => run(usage),
  );
  const scope: ManagedHookModelScope = {
    evaluate,
    bindBudget: vi.fn(),
    beginMainAttempt: vi.fn(),
  };
  return { config, generateContent, evaluate, usage, scope };
}

describe('Hosted Hook model boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    'preserves the operation result or error when cleanup fails (operation failed: %s)',
    async (failed) => {
      const { config, scope } = fixture();
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      config.shutdown.mockRejectedValue(new Error('cleanup failed'));
      const primary = new Error('operation failed');
      const result = { committed: true };
      const operation = runHostedHookOperation(
        {
          sessionId: 'session-1',
          cwd: '/workspace',
          signal: new AbortController().signal,
          scope,
        },
        async () => {
          if (failed) throw primary;
          return result;
        },
      );
      if (failed) await expect(operation).rejects.toBe(primary);
      else await expect(operation).resolves.toBe(result);
      expect(config.shutdown).toHaveBeenCalledExactlyOnceWith({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('cleanup failed'),
      );
      log.mockRestore();
    },
  );

  it('authorizes an isolated prompt evaluation and attributes provider usage to its original operation', async () => {
    const { config, generateContent, evaluate, usage, scope } = fixture();
    const signal = new AbortController().signal;
    const result = await runHostedHookOperation(
      { sessionId: 'session-1', cwd: '/workspace', signal, scope },
      (runner) => runner(hook, HookEventName.SessionEnd, input, signal),
    );
    expect(result).toMatchObject({ success: true, outcome: 'success' });
    expect(config.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
      }),
    );
    expect(config.refreshAuth).toHaveBeenCalledWith('test-auth', true);
    expect(evaluate).toHaveBeenCalledWith(
      {
        operationId: 'execution-1',
        occurrenceId: 'occurrence-1',
        originTurnId: null,
        eventName: HookEventName.SessionEnd,
        model: 'model-1',
      },
      expect.any(Function),
    );
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-1' }),
      'execution-1',
    );
    expect(usage).toHaveBeenCalledWith({
      model: 'model-1',
      usage: { totalTokenCount: 7 },
    });
    expect(config.shutdown).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(loadCliConfig)
        .mock.calls[0]?.[9]?.toolInvocationGuard?.({} as never),
    ).toMatchObject({ allowed: false });
  });

  it('cannot call the provider when controller authorization fails', async () => {
    const { config, generateContent, evaluate, scope } = fixture();
    evaluate.mockRejectedValue(new Error('slot is busy'));
    const runner = createHostedPromptHookRunner(
      config as unknown as Config,
      scope,
    );
    await expect(
      runner(
        hook,
        HookEventName.SessionEnd,
        input,
        new AbortController().signal,
      ),
    ).rejects.toThrow('slot is busy');
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('captures usage and operation identity when a Hook selects another configured model', async () => {
    const { config, generateContent, usage, scope } = fixture();
    const alternate = vi.fn(async () => response());
    const resolveForModel = vi.fn().mockResolvedValue({
      model: 'provider-model',
      contentGeneratorConfig: {},
      contentGenerator: {
        generateContent: alternate,
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      },
    });
    config.getBaseLlmClient = () => ({ resolveForModel });
    const runner = createHostedPromptHookRunner(
      config as unknown as Config,
      scope,
    );
    await expect(
      runner(
        { ...hook, model: 'configured-alias' },
        HookEventName.SessionEnd,
        input,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(resolveForModel).toHaveBeenCalledWith('configured-alias', {
      failClosed: true,
    });
    expect(generateContent).not.toHaveBeenCalled();
    expect(alternate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'provider-model' }),
      'execution-1',
    );
    expect(usage).toHaveBeenCalledWith({
      model: 'provider-model',
      usage: { totalTokenCount: 7 },
    });
  });

  it.each(['not JSON', '{"ok":"yes"}'])(
    'reports invalid response %s as failure',
    async (text) => {
      const { config, generateContent, scope } = fixture();
      generateContent.mockResolvedValue(response(text));
      const runner = createHostedPromptHookRunner(
        config as unknown as Config,
        scope,
      );
      await expect(
        runner(
          hook,
          HookEventName.SessionEnd,
          input,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        success: false,
        outcome: 'non_blocking_error',
      });
    },
  );

  it('keeps the model slot until the provider really settles after timeout', async () => {
    vi.useFakeTimers();
    const { config, generateContent, scope } = fixture();
    let finish!: (value: GenerateContentResponse) => void;
    generateContent.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const runner = createHostedPromptHookRunner(
      config as unknown as Config,
      scope,
    );
    let completed = false;
    const running = runner(
      { ...hook, timeout: 0.001 },
      HookEventName.SessionEnd,
      input,
      new AbortController().signal,
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(completed).toBe(false);
    finish(response());
    await expect(running).resolves.toMatchObject({
      success: false,
      outcome: 'timeout',
    });
  });
});
