/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { onModelRequestScopeEnd } from '../model-request/request-scope.js';
import {
  createAssistantMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  extractConversationTitleText,
  SessionTitleService,
} from './sessionTitleService.js';

function setup(
  generateJson = vi.fn().mockResolvedValue({ title: 'Fix auth flow' }),
) {
  const select = vi.fn(async (_input: unknown) => ({
    model: { key: 'lite', source: 'qwen-provider', limits: { maxOutputTokens: 4096 } },
    config: {
      reasoningEffortLevel: 'none',
    },
  }));
  const inference = vi.fn(async (request: unknown) => {
    const result = await generateJson(request);
    return {
      completed: Promise.resolve({
        blocks: [
          { type: 'thinking', text: 'private reasoning' },
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      }),
    };
  });
  const provider = { select, inference } as unknown as ModelProviderManager;
  const config = {
    getModelProviderManager: () => provider,
    getModel: () => 'auto',
  } satisfies Pick<Config, 'getModelProviderManager' | 'getModel'>;
  return {
    service: new SessionTitleService(config),
    select,
    inference,
    config,
  };
}

describe('sessionTitleService', () => {
  it('标题保留原 Turn 的身份，用 sub_task 表达标题用途', async () => {
    const { service, inference } = setup();
    const businessInfo = {
      product: 'app', type: 'code_review', id: 'original-turn', model_key: 'ultimate',
      name: 'original', version: 'test', begin_at: 1, stage: 'init',
    };
    const ended: Array<{ sessionId: string; requestSetId?: string }> = [];
    const unsubscribe = onModelRequestScopeEnd(async (sessionId, requestSetId) => {
      ended.push({ sessionId, requestSetId });
    });
    try {
      await service.generateTitle({ sessionId: 'session', description: '展示文字\n带附件', businessInfo });
    } finally {
      unsubscribe();
    }
    expect(inference).toHaveBeenCalledWith(expect.objectContaining({
      qoder: expect.objectContaining({ identity: { sessionId: 'session', requestSetId: expect.any(String) }, business: expect.objectContaining({
        product: 'app', type: 'code_review', id: 'original-turn', model_key: 'ultimate', sub_task: 'title_generation',
      }) }),
    }));
    const request = inference.mock.calls[0]![0] as { qoder: { identity: { sessionId: string; requestSetId: string } } };
    expect(request.qoder.identity.requestSetId).not.toBe(businessInfo.id);
    expect(ended).toContainEqual(request.qoder.identity);
  });

  it('新协议保留生成错误，旧入口继续降级为空标题', async () => {
    const failure = new Error('network unavailable');
    const { service } = setup(vi.fn().mockRejectedValue(failure));
    const options = { sessionId: 'session', description: 'title' };
    await expect(service.generateTitle({ ...options, throwOnError: true })).rejects.toBe(failure);
    await expect(service.generateTitle(options)).resolves.toBeNull();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards customContext to the title provider request', async () => {
    const { service, select, inference } = setup();
    const customContext = Object.freeze({ tenant: 'alpha' });

    await service.generateTitle({
      sessionId: 'title-session',
      description: 'Fix auth flow',
      customContext,
    });

    expect(select).toHaveBeenCalledExactlyOnceWith({ purpose: 'title' });
    expect(inference).toHaveBeenCalledWith(
      expect.objectContaining({ customContext }),
    );
  });

  it('extractConversationTitleText skips meta, command-style, and non-human user prompts', () => {
    const assistant = createAssistantMessage({
      messageId: 'assistant-1',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [{ type: 'text', text: 'I found the auth bug.' }],
    });
    const metaAssistant = createAssistantMessage({
      messageId: 'assistant-meta',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [{ type: 'text', text: 'Remote Control Connected' }],
    });
    metaAssistant.isMeta = true;

    const text = extractConversationTitleText([
      createUserMessage('Fix auth flow', { origin: { kind: 'human' } }),
      createUserMessage('/resume', { origin: { kind: 'human' } }),
      createUserMessage('system follow-up', { origin: { kind: 'system' } }),
      createUserMessage('hidden prompt', {
        isMeta: true,
        origin: { kind: 'human' },
      }),
      assistant,
      metaAssistant,
    ]);

    expect(text).toContain('Fix auth flow');
    expect(text).toContain('I found the auth bug.');
    expect(text).not.toContain('/resume');
    expect(text).not.toContain('system follow-up');
    expect(text).not.toContain('hidden prompt');
    expect(text).not.toContain('Remote Control Connected');
  });

  it('extractConversationTitleText strips system-reminder blocks from user prompts', () => {
    const text = extractConversationTitleText([
      createUserMessage(
        'Fix auth flow\n\n<system-reminder>internal routing hint</system-reminder>',
        { origin: { kind: 'human' } },
      ),
      createUserMessage(
        '<system-reminder>hidden context</system-reminder>\n\nDebug CI',
        { origin: { kind: 'human' } },
      ),
    ]);

    expect(text).toContain('Fix auth flow');
    expect(text).toContain('Debug CI');
    expect(text).not.toContain('system-reminder');
    expect(text).not.toContain('internal routing hint');
    expect(text).not.toContain('hidden context');
  });

  it('uses structured title generation defaults', async () => {
    const generateJson = vi
      .fn()
      .mockResolvedValue({ title: '"Fix auth flow on mobile"' });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth flow on mobile devices',
      currentModel: 'qwen-max',
    });

    expect(title).toBe('Fix auth flow on mobile');
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ key: 'lite' }),
        maxTokens: 64,
        reasoningEffort: 'none',
        identity: expect.objectContaining({ sessionId: 'session-1' }),
        taskRouting: { taskId: 'agent_summary' },
        business: expect.objectContaining({
          type: 'title_generation',
          sub_task: 'title_generation',
        }),
        signal: expect.any(AbortSignal),
        systemPrompt: expect.stringMatching(
          /You are an expert conversation summarizer[\s\S]*JSON Schema/,
        ),
        messages: [
          {
            role: 'user',
            content: 'Fix auth flow on mobile devices',
          },
        ],
      }),
    );
  });

  it('selects lite through the provider even when the old catalog omits lite', async () => {
    const { service, select, inference } = setup();
    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow',
        currentModel: 'auto',
      }),
    ).toBe('Fix auth flow');
    expect(select).toHaveBeenCalledWith({ purpose: 'title' });
    expect(inference).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ key: 'lite' }),
      }),
    );
  });

  it('reads SDK policy without extending the provider selection input', async () => {
    const getModelPolicy = vi.fn().mockResolvedValue(undefined);
    const { service, select } = setup();
    await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth',
      getModelPolicy,
    });
    expect(select).toHaveBeenCalledExactlyOnceWith({ purpose: 'title' });
    expect(getModelPolicy).toHaveBeenCalledWith(
      'title',
      'session-1',
      0,
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
  });

  it('skips title inference when SDK policy fails', async () => {
    const generateJson = vi.fn().mockResolvedValue({ title: 'Fix auth flow' });
    const getModelPolicy = vi
      .fn()
      .mockRejectedValue(new Error('policy failed'));
    const { service, select } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth flow on mobile devices',
      currentModel: 'qwen-max',
      getModelPolicy,
    });

    expect(title).toBeNull();
    expect(generateJson).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not infer when provider selection is aborted', async () => {
    const { service, select, inference } = setup();
    select.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth',
      }),
    ).toBeNull();
    expect(inference).not.toHaveBeenCalled();
  });

  it('preserves the selected model and session business attribution', async () => {
    const { service, select, inference } = setup();
    const businessInfo = { version: '1', id: 'parent-turn', model_key: 'auto' };
    await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth flow',
      businessInfo,
    });
    expect(select).toHaveBeenCalledWith({ purpose: 'title' });
    expect(inference).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ key: 'lite' }),
        identity: expect.objectContaining({ sessionId: 'session-1' }),
        business: { ...businessInfo, sub_task: 'title_generation' },
      }),
    );
    expect(businessInfo).not.toHaveProperty('sub_task');
  });

  it.each([
    { getModelPolicy: async () => ({ model: 'sdk-title' }) },
    { modelOverride: 'explicit-title' },
  ])(
    'does not silently substitute a built-in model for an unsupported override: %j',
    async (override) => {
      const { service, inference } = setup();
      expect(
        await service.generateTitle({
          sessionId: 'session-1',
          description: 'Fix auth',
          ...override,
        }),
      ).toBeNull();
      expect(inference).not.toHaveBeenCalled();
    },
  );

  it('uses deterministic title settings and caps output by the selected model', async () => {
    const { service, select, inference } = setup();
    select.mockResolvedValueOnce({
      model: { key: 'lite', source: 'qwen-provider', limits: { maxOutputTokens: 16 } },
      config: { reasoningEffortLevel: 'none' },
    });
    await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth',
    });
    expect(inference).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 16,
        temperature: 0,
        reasoningEffort: 'none',
      }),
    );
  });

  it('stops before selection if SDK policy resolution is cancelled', async () => {
    const { service, select, inference } = setup();
    const controller = new AbortController();
    await service.generateTitle({
      sessionId: 'session-1',
      description: 'Fix auth',
      signal: controller.signal,
      getModelPolicy: async () => {
        controller.abort();
        return undefined;
      },
    });
    expect(select).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
  });

  it('applies maxChars and maxWords limits to generated titles', async () => {
    const generateJson = vi.fn().mockResolvedValue({
      title: 'Refactor remote title generation event reporting behavior',
    });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: 'Refactor remote title generation event reporting behavior',
      maxChars: 38,
      maxWords: 4,
    });

    expect(title).toBe('Refactor remote title generation');
  });

  it('applies maxWords limits to non-ASCII titles for remote sessions', async () => {
    const generateJson = vi
      .fn()
      .mockResolvedValue({ title: '生成远程会话标题并同步到列表' });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: '生成远程会话标题并同步到列表',
      maxWords: 4,
    });

    expect(title).toBe('生成远程会话标题');
  });

  it('uses returned title text output', async () => {
    const generateJson = vi
      .fn()
      .mockResolvedValue({ title: 'List current directory contents' });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: '当前文件夹里有啥',
    });

    expect(title).toBe('List current directory contents');
  });

  it('returns null when there is no usable input', async () => {
    const generateJson = vi.fn();
    const { service } = setup(generateJson);

    await expect(
      service.generateTitle({
        sessionId: 'session-1',
        description: '   ',
      }),
    ).resolves.toBeNull();

    expect(generateJson).not.toHaveBeenCalled();
  });

  it('does not apply reasoning heuristics to structured title content', async () => {
    const generateJson = vi.fn().mockResolvedValue({
      title: 'Analyze memory leak',
    });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: '当前文件夹里有啥',
    });

    expect(title).toBe('Analyze memory leak');
  });

  it('does not apply protocol heuristics to structured title content', async () => {
    const generateJson = vi.fn().mockResolvedValue({
      title:
        '<tool_call> <function=list_files> <path> .</path> </function> </tool_call>',
    });
    const { service } = setup(generateJson);

    const title = await service.generateTitle({
      sessionId: 'session-1',
      description: '看下项目结构',
    });

    expect(title).toBe(
      '<tool_call> <function=list_files> <path> .</path> </function> </tool_call>',
    );
  });

  it('retries malformed JSON and extracts a fenced structured response', async () => {
    const output = vi
      .fn()
      .mockResolvedValueOnce('not JSON')
      .mockResolvedValueOnce('```json\n{"title":"Fix auth flow"}\n```');
    const { service, inference } = setup(output);
    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow',
        maxAttempts: 2,
      }),
    ).toBe('Fix auth flow');
    expect(inference).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'network',
      Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
    ],
    [
      'HTTP 429',
      Object.assign(new Error('Too many requests'), { status: 429 }),
    ],
    [
      'HTTP 503',
      Object.assign(new Error('Service unavailable'), { status: 503 }),
    ],
  ])('leaves %s request retries to the client', async (_kind, error) => {
    const { service, inference } = setup();
    inference.mockRejectedValueOnce(error);

    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow',
      }),
    ).toBeNull();
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it('does not restart inference when reading the completed response fails', async () => {
    const { service, inference } = setup();
    inference.mockImplementationOnce(async () => ({
      completed: Promise.reject(
        Object.assign(new Error('Stream interrupted'), { code: 'ECONNRESET' }),
      ),
    }));

    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow',
      }),
    ).toBeNull();
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it('honors the one-attempt title option on invalid output', async () => {
    const { service, inference } = setup(
      vi.fn().mockResolvedValue({ title: 3 }),
    );
    expect(
      await service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow',
        maxAttempts: 1,
      }),
    ).toBeNull();
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it('returns null when generation aborts', async () => {
    const abortError = new Error('timed out');
    abortError.name = 'AbortError';
    const generateJson = vi.fn().mockRejectedValue(abortError);
    const { service } = setup(generateJson);

    await expect(
      service.generateTitle({
        sessionId: 'session-1',
        description: 'Fix auth flow on mobile devices',
      }),
    ).resolves.toBeNull();
  });
});
