/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import { CustomProviderRegistry } from '../provider/custom/registry.js';
import type { Config } from '../config/config.js';
import { ENV_BUSINESS_SUB_TASK } from '../config/brand.js';
import { MaxOutputTokensError } from '../core/max-output-tokens.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import type { Model } from '../provider/model/model.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';

type InsightModelRequest = ModelStreamRequest & {
  qoder: {
    identity: { sessionId?: string; requestSetId?: string; requestId?: string };
    business?: unknown;
    customContext?: Readonly<Record<string, string>>;
  };
};
import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';
import {
  businessInfoContext,
  customContextContext,
  requestSetIdContext,
} from '../utils/sessionIdContext.js';
import { generateInsight } from './modelRequest.js';

function model(key: string): Model {
  return {
    key,
    source: 'qoder',
    displayName: key,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: { supported: true, supportedEfforts: ['none', 'high'] },
      contextWindows: [],
    },
    limits: { maxContextTokens: 32000, maxOutputTokens: 4096 },
  };
}

function response(
  text = 'hello',
  stopReason: 'end_turn' | 'max_tokens' | null = 'end_turn',
): ModelStreamResponse {
  const message: Awaited<ModelStreamResponse['completed']> = {
    messageId: 'message',
    model: 'selected',
    stopReason: stopReason ?? undefined,
    blocks: [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text },
    ],
  };
  return {
    events: (async function* () {})(),
    completed: Promise.resolve(message),
    partial: Promise.resolve({
      messageId: message.messageId,
      model: message.model,
      stopReason: message.stopReason,
      blocks: message.blocks,
      openBlocks: new Map(),
    }),
  };
}

function provider(
  id: string,
  models: Model[],
  selected = models[0],
  text = 'hello',
) {
  return {
    providerId: id,
    start: async () => {},
    stop: async () => {},
    getModel: async (key: string) => models.find((entry) => entry.key === key),
    listModels: async () => models,
    getModelConfig: () => undefined,
    setModelConfig: () => true,
    select: vi.fn(async (_context: ModelSelectContext) => ({
      model: selected,
      config: { reasoning: { effort: 'high' as const }, context: { contextWindow: 32000 } },
    })),
    inference: vi.fn(async (_request: InsightModelRequest) => response(text)),
  };
}

function setup() {
  const sessionModel = model('session');
  const selectedModel = model('selected');
  const qoder = provider('qoder', [sessionModel, selectedModel], selectedModel);
  const { select, inference } = qoder;
  const manager = new ModelProviderManager({
    userProviders: [qoder],
    modelTransportManager: new ModelTransportManager([]),
    settingsService: new SettingsService(),
  });
  manager.setMainModel(model('stale-session'));
  const config = {
    getModelProviderManager: () => manager,
    getModel: () => 'session',
    getModelRequestIdentity: () => 'test-account',
    getSessionId: () => 'history-session',
    isConfiguredCustomProviderModelKey: () => false,
  } as unknown as Config;
  const options = {
    sessionId: 'history-session',
    messages: [{ role: 'user' as const, content: 'Analyze this session' }],
    systemPrompt: systemPromptFromText('Analyze coding activity.'),
    abortSignal: new AbortController().signal,
    promptId: 'insights-test',
  };
  return {
    generate: (options: Parameters<typeof generateInsight>[1]) =>
      generateInsight(config, options),
    config,
    manager,
    select,
    inference,
    sessionModel,
    selectedModel,
    resolution: {
      model: selectedModel,
      config: { reasoning: { effort: 'high' as const }, context: { contextWindow: 32000 } },
    },
    options,
  };
}

const schema = {
  type: 'object',
  properties: { topics: { type: 'array', items: { type: 'string' } } },
  required: ['topics'],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('generateInsight', () => {
  it('uses an available BYOK provider without an account or legacy registry projection', async () => {
    const f = setup();
    const main = { ...model('local/main'), source: 'local' };
    const local = provider('local', [main], main, 'BYOK insights');
    const manager = new ModelProviderManager({
      userProviders: [local],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    const registry = new CustomProviderRegistry();
    const config = {
      ...f.config,
      getModelProviderManager: () => manager,
      getModel: () => main.key,
      getModelRequestIdentity: () => '',
      isConfiguredCustomProviderModelKey: () => true,
      getCustomProviderRegistry: () => registry,
    } as unknown as Config;

    expect(await generateInsight(config, f.options)).toBe('BYOK insights');
    expect(local.select).toHaveBeenCalledExactlyOnceWith({
      purpose: 'insights',
      mainModel: main,
      parentSelection: undefined,
    });
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('uses the shared session anchor synchronization when switching providers in either direction', async () => {
    const f = setup();
    const main = { ...model('local/main'), source: 'local' };
    const helper = { ...model('local/helper'), source: 'local' };
    const local = provider('local', [main, helper], helper, 'custom result');
    const platform = provider('qoder', [model('platform')]);
    const manager = new ModelProviderManager({
      userProviders: [platform, local],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    manager.setMainModel(model('old-platform-anchor'));
    let key = main.key;
    const config = {
      ...f.config,
      getModelProviderManager: () => manager,
      getModel: () => key,
      isConfiguredCustomProviderModelKey: (value: string) =>
        value.startsWith('local/'),
      getCustomProviderRegistry: () => ({ isCustomProviderModel: () => true }),
    } as unknown as Config;
    expect(await generateInsight(config, f.options)).toBe('custom result');
    expect(local.select).toHaveBeenCalledExactlyOnceWith({
      purpose: 'insights',
      mainModel: main,
      parentSelection: undefined,
    });
    expect(local.inference).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: expect.objectContaining({ model: helper }) }),
    );
    expect(platform.select).not.toHaveBeenCalled();
    key = 'platform';
    expect(await generateInsight(config, f.options)).toBe('hello');
    expect(platform.select).toHaveBeenCalledExactlyOnceWith({
      purpose: 'insights',
      mainModel: await manager.getModel('platform'),
      parentSelection: undefined,
    });
  });

  it('rejects a BYOK model denied by the manager without a platform fallback', async () => {
    const f = setup();
    const main = { ...model('local/main'), source: 'local' };
    const local = provider('local', [main]);
    const platform = provider('qoder', [model('platform')]);
    const manager = new ModelProviderManager({
      userProviders: [platform, local],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    manager.setModelAccessCheck(async (entry) => {
      if (entry.source === 'local') throw new Error('Access denied');
    });
    const config = {
      ...f.config,
      getModelProviderManager: () => manager,
      getModel: () => main.key,
      isConfiguredCustomProviderModelKey: () => true,
    } as unknown as Config;

    await expect(generateInsight(config, f.options)).rejects.toThrow('unavailable');
    expect(local.inference).not.toHaveBeenCalled();
    expect(platform.select).not.toHaveBeenCalled();
    expect(platform.inference).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects an unavailable custom model without a platform fallback (registry available: %s)',
    async (available) => {
      const f = setup();
      const config = {
        ...f.config,
        getModel: () => 'local/missing',
        isConfiguredCustomProviderModelKey: () => true,
        getCustomProviderRegistry: () => ({
          isCustomProviderModel: () => available,
        }),
      } as unknown as Config;
      await expect(generateInsight(config, f.options)).rejects.toThrow(
        'unavailable',
      );
      expect(f.select).not.toHaveBeenCalled();
      expect(f.inference).not.toHaveBeenCalled();
    },
  );

  it('uses the session manager, refreshes a stale anchor, and consumes the selected model completion', async () => {
    const f = setup();
    expect(await f.generate(f.options)).toBe('hello');
    expect(f.select).toHaveBeenCalledExactlyOnceWith({
      purpose: 'insights',
      mainModel: f.sessionModel,
      parentSelection: undefined,
    });
    expect(f.inference).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        resolution: f.resolution,
        prompt: {
          messages: [{ role: 'system', content: 'Analyze coding activity.' }, ...f.options.messages],
        },
        control: { signal: f.options.abortSignal },
        qoder: {
          identity: {
            sessionId: 'history-session',
            requestId: expect.any(String),
            requestSetId: undefined,
          },
          business: undefined,
          customContext: undefined,
        },
      }),
    );
    expect(f.inference.mock.calls[0][0].resolution.model).toBe(f.selectedModel);
  });

  it('preserves JSON schema and request context across invalid-output retries', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.inference
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response('{"topics":false}'))
      .mockResolvedValueOnce(response('```json\n{"topics":["testing"]}\n```'));
    const parent = {
      version: '1',
      id: 'parent-business',
      model_key: 'business-model',
      sub_task: 'parent-task',
    };
    const customContext = { host: 'sdk' };
    const promise = businessInfoContext.run(parent, () =>
      requestSetIdContext.run('request-set', () =>
        customContextContext.run(customContext, () =>
          f.generate({ ...f.options, schema }),
        ),
      ),
    );
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ topics: ['testing'] });
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.inference).toHaveBeenCalledTimes(3);
    expect(f.inference.mock.calls[0][0].prompt.messages[0].content).toContain(
      JSON.stringify(schema, null, 2),
    );
    const requests = f.inference.mock.calls.map(([request]) => request);
    expect(new Set(requests.map((r) => r.qoder.identity.requestId)).size).toBe(3);
    for (const request of requests) {
      expect(request.qoder.identity).toEqual({
        sessionId: 'history-session',
        requestSetId: 'request-set',
        requestId: expect.any(String),
      });
      expect(request.qoder.business).toEqual({
        version: '1',
        id: 'parent-business',
        model_key: 'business-model',
      });
      expect(request.qoder.business).toBe(requests[0].qoder.business);
      expect(request.qoder.customContext).toEqual(customContext);
      expect(request.qoder.customContext).not.toBe(customContext);
    }
    expect(parent.sub_task).toBe('parent-task');
  });

  it('retries empty text content', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.inference.mockResolvedValueOnce(response('  '));
    const result = f.generate(f.options);
    await vi.runAllTimersAsync();
    expect(await result).toBe('hello');
    expect(f.inference).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error('fetch failed'),
    Object.assign(new Error('429'), { status: 429 }),
    Object.assign(new Error('503'), { status: 503 }),
  ])('leaves transport errors to Client RetryValve: %s', async (error) => {
    const f = setup();
    f.inference.mockRejectedValueOnce(error);
    await expect(f.generate(f.options)).rejects.toBe(error);
    expect(f.inference).toHaveBeenCalledTimes(1);
  });

  it('propagates completion stream failures without an outer transport retry', async () => {
    const f = setup();
    const error = new Error('stream disconnected');
    f.inference.mockImplementationOnce(async () => ({
      ...response(),
      completed: Promise.reject(error),
    }));
    await expect(f.generate(f.options)).rejects.toBe(error);
    expect(f.inference).toHaveBeenCalledTimes(1);
  });

  it('does not infer or fall back when selection fails', async () => {
    const f = setup();
    f.select.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(f.generate(f.options)).rejects.toThrow('model unavailable');
    expect(f.inference).not.toHaveBeenCalled();
  });

  it.each(['before', 'after', 'pending'] as const)(
    'handles cancellation %s selection',
    async (stage) => {
      const f = setup();
      const controller = new AbortController();
      if (stage === 'before') controller.abort();
      if (stage === 'after')
        f.select.mockImplementationOnce(async () => {
          controller.abort();
          return f.resolution;
        });
      if (stage === 'pending')
        f.select.mockImplementationOnce(() => new Promise(() => {}));
      const result = f.generate({
        ...f.options,
        abortSignal: controller.signal,
      });
      if (stage === 'pending') {
        await vi.waitFor(() => expect(f.select).toHaveBeenCalledOnce());
        controller.abort();
      }
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.select).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
      expect(f.inference).not.toHaveBeenCalled();
    },
  );

  it('rejects an incomplete response with no stop reason', async () => {
    const f = setup();
    f.inference.mockResolvedValueOnce(response('partial', null));
    await expect(f.generate(f.options)).rejects.toThrow(
      'Incomplete insights response',
    );
    expect(f.inference).toHaveBeenCalledTimes(1);
  });

  it('preserves output-limit errors after invalid JSON exhausts the content budget', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.inference.mockImplementation(async () =>
      response('{"topics":', 'max_tokens'),
    );
    const result = f
      .generate({ ...f.options, schema })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(MaxOutputTokensError);
    expect(f.inference).toHaveBeenCalledTimes(5);
  });

  it('creates one business ID only when the existing environment sub-task requires it', async () => {
    vi.stubEnv(ENV_BUSINESS_SUB_TASK, 'existing-subtask');
    const f = setup();
    await f.generate(f.options);
    expect(f.inference.mock.calls[0][0].qoder).toMatchObject({
      business: {
        id: expect.any(String),
        model_key: 'session',
        name: 'existing-subtask',
        sub_task: 'existing-subtask',
        stage: 'init',
      },
    });
  });

  it('rejects an empty session ID before model selection', async () => {
    const f = setup();
    await expect(f.generate({ ...f.options, sessionId: '  ' })).rejects.toThrow(
      'non-empty sessionId',
    );
    expect(f.select).not.toHaveBeenCalled();
  });
});
