/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveCacheSafeParams,
  getCacheSafeParams,
  getCacheSafeParamsSessionId,
  clearCacheSafeParams,
  createForkedChat,
  runForkedAgent,
  runWithForkedChatModel,
} from './forkedAgent.js';
import type { CachePathParams } from './forkedAgent.js';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { LlmChat, StreamEventType } from '../core/llm-chat.js';
import { createRuntimeContentGeneratorView } from '../models/content-generator-config.js';
import type { RuntimeContentGeneratorView } from './runtime/agent-context.js';
import {
  content,
  fnCall,
  modelChunk,
  modelText,
  streamOf,
  userText,
} from '../test-utils/model-fixtures.js';

vi.mock('../core/llm-chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/llm-chat.js')>();
  return {
    ...actual,
    LlmChat: vi.fn(),
  };
});

vi.mock('../models/content-generator-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../models/content-generator-config.js')
    >();
  return {
    ...actual,
    createRuntimeContentGeneratorView: vi.fn(),
  };
});

function makeRuntimeView(model: string): RuntimeContentGeneratorView {
  return {
    contentGenerator: {} as RuntimeContentGeneratorView['contentGenerator'],
    contentGeneratorConfig: {
      model,
      authType: AuthType.USE_OPENAI,
    },
  };
}

type Decls = Array<{ functionDeclarations: unknown[] }>;

describe('CacheSafeParams', () => {
  beforeEach(() => {
    clearCacheSafeParams();
  });

  describe('saveCacheSafeParams / getCacheSafeParams', () => {
    it('saves and retrieves params', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'You are helpful',
        tools: [{ functionDeclarations: [] }],
      };

      saveCacheSafeParams(config, [], 'qwen-max');

      const params = getCacheSafeParams();
      expect(params).not.toBeNull();
      expect(params!.model).toBe('qwen-max');
      expect(params!.history).toEqual([]);
      expect(params!.version).toBeGreaterThan(0);
    });

    it('stores session id', () => {
      saveCacheSafeParams({}, [], 'model', 'session-a');

      expect(getCacheSafeParams()?.sessionId).toBe('session-a');
    });

    it('rejects params owned by another session', () => {
      saveCacheSafeParams({}, [], 'model', 'session-b');

      expect(getCacheSafeParams('session-a')).toBeNull();
      expect(getCacheSafeParams('session-b')?.sessionId).toBe('session-b');
    });

    it('returns the current session id without reading full params', () => {
      saveCacheSafeParams({}, [], 'model', 'session-a');

      expect(getCacheSafeParamsSessionId()).toBe('session-a');
      clearCacheSafeParams();
      expect(getCacheSafeParamsSessionId()).toBeUndefined();
    });

    it('deep clones generationConfig', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'test',
        tools: [{ functionDeclarations: [{ name: 'tool1' }] }],
      };
      const savedDecls = () =>
        (getCacheSafeParams()!.generationConfig.tools as Decls)[0]
          .functionDeclarations;

      saveCacheSafeParams(config, [], 'model');

      // Neither mutating the original nor the returned copy leaks into the store.
      (config.tools as Decls)[0].functionDeclarations.push({ name: 'tool2' });
      expect(savedDecls()).toHaveLength(1);

      savedDecls().push({ name: 'tool3' });
      expect(savedDecls()).toHaveLength(1);
    });

    it('copies history containers and Part objects', () => {
      const historyPart = { text: 'large history entry' };
      const nestedPart = {
        inlineData: { mimeType: 'image/png', data: 'screenshot' },
      };
      const historyEntry: Content = content('user', historyPart, {
        functionResponse: {
          id: 'call-1',
          name: 'screenshot',
          response: {},
          parts: [nestedPart],
        },
      });
      const historyEntryWithoutParts: Content = { role: 'model' };
      const history: Content[] = [historyEntry, historyEntryWithoutParts];

      saveCacheSafeParams({}, history, 'model');
      history.push({ role: 'model', parts: [{ text: 'late mutation' }] });
      historyEntry.parts!.push({ text: 'late part mutation' });

      const params = getCacheSafeParams();
      expect(params!.history).toHaveLength(2);
      expect(params!.history).not.toBe(history);
      expect(params!.history[0]).not.toBe(historyEntry);
      expect(params!.history[0]!.parts).toHaveLength(2);
      expect(params!.history[0]!.parts).not.toBe(historyEntry.parts);
      expect(params!.history[0]!.parts![0]).not.toBe(historyPart);
      expect(params!.history[0]!.parts![0]).toEqual(historyPart);
      const copiedNested = params!.history[0]!.parts![1]!.functionResponse
        ?.parts as Array<typeof nestedPart>;
      expect(copiedNested[0]).not.toBe(nestedPart);
      expect(copiedNested[0]).toEqual(nestedPart);
      expect(params!.history[1]).not.toBe(historyEntryWithoutParts);
      expect('parts' in params!.history[1]!).toBe(false);

      params!.history.push(modelText('returned mutation'));
      params!.history[0]!.parts!.push({ text: 'returned part mutation' });
      expect(getCacheSafeParams()!.history).toHaveLength(2);
      expect(getCacheSafeParams()!.history[0]!.parts).toHaveLength(2);
    });
  });

  describe('clearCacheSafeParams', () => {
    it('clears saved params', () => {
      saveCacheSafeParams({}, [], 'model');
      expect(getCacheSafeParams()).not.toBeNull();

      clearCacheSafeParams();
      expect(getCacheSafeParams()).toBeNull();
    });
  });

  describe('version detection', () => {
    /** Saves `config` and `history` and returns the stored version. */
    const versionAfter = (
      config: GenerateContentConfig,
      history: Content[] = [],
    ) => {
      saveCacheSafeParams(config, history, 'model');
      return getCacheSafeParams()!.version;
    };

    it('increments version when systemInstruction changes', () => {
      const v1 = versionAfter({ systemInstruction: 'version1' });
      expect(versionAfter({ systemInstruction: 'version2' })).toBeGreaterThan(
        v1,
      );
    });

    it('increments version when tools change', () => {
      const v1 = versionAfter({
        tools: [{ functionDeclarations: [{ name: 'a' }] }],
      });
      expect(
        versionAfter({
          tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }],
        }),
      ).toBeGreaterThan(v1);
    });

    it('does not increment version when only history changes', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'stable',
        tools: [],
      };
      const v1 = versionAfter(config);
      expect(versionAfter(config, [userText('hi')])).toBe(v1);
    });
  });
});

describe('createForkedChat', () => {
  beforeEach(() => {
    clearCacheSafeParams();
    vi.mocked(LlmChat).mockReset();
  });

  it('marks the fork so its history rewrites skip parent skill tracking', () => {
    const forked = {} as unknown as LlmChat;
    vi.mocked(LlmChat).mockImplementation(() => forked);

    saveCacheSafeParams({ systemInstruction: 'si' }, [], 'test-model');
    const chat = createForkedChat(
      {} as unknown as Config,
      getCacheSafeParams()!,
    );

    expect(chat.isForkedChat).toBe(true);
  });
});

const TOOL_DESCRIPTIONS: Record<string, string> = {
  edit: 'Edit a file',
  shell: 'Run a command',
};
/** Parent tool list `[{ functionDeclarations }]` with the named tools. */
const parentTools = (...names: string[]) => [
  {
    functionDeclarations: names.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
    })),
  },
];
const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5 };

/** Every forked LlmChat streams `chunks`; returns its sendMessageStream spy. */
function mockForkStream(chunks: GenerateContentResponse[], extra = {}) {
  const send = vi.fn((..._args: unknown[]) =>
    Promise.resolve(
      streamOf(
        ...chunks.map((value) => ({ type: StreamEventType.CHUNK, value })),
      ),
    ),
  );
  vi.mocked(LlmChat).mockImplementation(
    () => ({ sendMessageStream: send, ...extra }) as unknown as LlmChat,
  );
  return send;
}

/** Per-request config of the first sendMessageStream call. */
const sentConfig = (send: ReturnType<typeof mockForkStream>) =>
  (send.mock.calls[0][1] as { config: GenerateContentConfig }).config;

/** Runs the cache path on the saved params; `opts` override the defaults. */
const runFork = (opts: Partial<CachePathParams> = {}) =>
  runForkedAgent({
    config: {} as Config,
    userMessage: 'suggest something',
    cacheSafeParams: getCacheSafeParams()!,
    ...opts,
  });

describe('runForkedAgent (cache path)', () => {
  beforeEach(() => {
    clearCacheSafeParams();
    vi.mocked(LlmChat).mockReset();
    vi.mocked(createRuntimeContentGeneratorView).mockReset();
  });

  it.each(['https://second.example/v1', ''])(
    'resolves an endpoint-qualified selector without passing its suffix as the model ID: %s',
    async (endpoint) => {
      const config = {
        getModel: () => 'shared',
        getContentGeneratorConfig: () => ({
          model: 'shared',
          authType: AuthType.USE_OPENAI,
        }),
      } as unknown as Config;
      vi.mocked(createRuntimeContentGeneratorView).mockResolvedValue(
        makeRuntimeView('shared'),
      );
      const request = vi.fn(async (model: string) => model);
      await expect(
        runWithForkedChatModel(config, `openai:shared\0${endpoint}`, request),
      ).resolves.toBe('shared');
      expect(request).toHaveBeenCalledWith('shared');
      expect(createRuntimeContentGeneratorView).toHaveBeenCalledWith(
        config,
        config,
        'shared',
        {
          authType: AuthType.USE_OPENAI,
          registryBaseUrl: endpoint || null,
        },
      );
    },
  );

  it('passes tools: [] in per-request config so the model cannot produce function calls', async () => {
    // Real tools simulate a normal conversation.
    saveCacheSafeParams(
      {
        systemInstruction: 'You are helpful',
        tools: parentTools('edit', 'shell'),
      },
      [userText('hello')],
      'test-model',
    );
    const enableManualPlanExitNotices = vi.fn();
    const send = mockForkStream(
      [
        modelChunk([{ text: 'commit this' }], undefined, {
          ...USAGE,
          totalTokenCount: 15,
        }),
      ],
      { enableManualPlanExitNotices },
    );

    const result = await runFork();

    // LlmChat keeps the full generationConfig (tools included):
    // createForkedChat retains tools for speculation callers.
    expect(LlmChat).toHaveBeenCalledOnce();
    const ctorArgs = vi.mocked(LlmChat).mock.calls[0];
    const chatGenerationConfig = ctorArgs[1] as GenerateContentConfig;
    expect(chatGenerationConfig.tools).toEqual(parentTools('edit', 'shell'));
    // No chatRecordingService / telemetryService, so the main session's
    // recordings are not polluted.
    expect(ctorArgs[3]).toBeUndefined(); // chatRecordingService
    expect(ctorArgs[4]).toBeUndefined(); // telemetryService
    expect(enableManualPlanExitNotices).not.toHaveBeenCalled();

    expect(send.mock.calls[0][1]).not.toBeNull();
    // KEY ASSERTION (Root Cause 1 fix): per-request tools: [] prevents the
    // model from producing function calls.
    expect(sentConfig(send)).toBeDefined();
    expect(sentConfig(send).tools).toEqual([]);

    expect(send).toHaveBeenCalledExactlyOnceWith(
      'test-model',
      expect.objectContaining({
        message: [{ text: 'suggest something' }],
        config: expect.objectContaining({ tools: [] }),
      }),
      'forked_query',
    );

    expect(result.text).toBe('commit this');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('disables model fallbacks without changing the requested route', async () => {
    saveCacheSafeParams({}, [], 'test-model');
    const send = mockForkStream([modelChunk([{ text: 'review' }])]);

    const result = await runFork({
      userMessage: 'review this',
      disableModelFallbacks: true,
    });

    expect(send).toHaveBeenCalledWith(
      'test-model',
      expect.any(Object),
      'forked_query',
      undefined,
      { disableModelFallbacks: true },
    );
    expect(result.model).toBe('test-model');
  });

  it('keeps the first structured response when the provider emits another schema call', async () => {
    saveCacheSafeParams(
      { tools: [{ functionDeclarations: [{ name: 'edit' }] }] },
      [],
      'test-model',
    );
    const send = mockForkStream([
      modelChunk(
        [fnCall('respond_in_schema', { suggestion: 'run tests' })],
        undefined,
        { promptTokenCount: 5, candidatesTokenCount: 3 },
      ),
      modelChunk([fnCall('respond_in_schema', {})]),
    ]);
    const schema = {
      type: 'object',
      properties: { suggestion: { type: 'string' } },
    };

    const result = await runFork({
      userMessage: 'suggest',
      jsonSchema: schema,
    });

    expect(sentConfig(send).tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'respond_in_schema',
            description: 'Provide the response in the required schema',
            parameters: schema,
          },
        ],
      },
    ]);
    expect(sentConfig(send).toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['respond_in_schema'],
      },
    });
    expect(result.jsonResult).toEqual({ suggestion: 'run tests' });
  });

  /** A `fast` selector naming an OpenAI model other than the parent's. */
  async function expectFastModelRoute(
    parentModel: string,
    parentAuth: AuthType,
    configuredOpenAi: string[],
  ) {
    const fastModel = 'deepseek-v4-flash';
    vi.mocked(createRuntimeContentGeneratorView).mockResolvedValue(
      makeRuntimeView(fastModel),
    );
    saveCacheSafeParams(
      { systemInstruction: 'You are helpful' },
      [userText('hello')],
      parentModel,
    );
    const send = mockForkStream([modelChunk([{ text: 'commit this' }])]);
    const mockConfig = {
      getModel: vi.fn().mockReturnValue(parentModel),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: parentModel,
        authType: parentAuth,
      }),
      getFastModel: vi
        .fn()
        .mockReturnValue(`${AuthType.USE_OPENAI}:${fastModel}`),
      getAllConfiguredModels: vi.fn((authTypes?: AuthType[]) =>
        authTypes?.includes(AuthType.USE_OPENAI)
          ? [...configuredOpenAi, fastModel].map((id) => ({
              id,
              label: id,
              authType: AuthType.USE_OPENAI,
            }))
          : [],
      ),
    } as unknown as Config;

    const result = await runFork({ config: mockConfig, model: 'fast' });

    expect(result.text).toBe('commit this');
    expect(result.model).toBe(fastModel);
    expect(createRuntimeContentGeneratorView).toHaveBeenCalledWith(
      mockConfig,
      mockConfig,
      fastModel,
      { authType: AuthType.USE_OPENAI },
    );
    expect(send).toHaveBeenCalledWith(
      fastModel,
      expect.objectContaining({ message: [{ text: 'suggest something' }] }),
      'forked_query',
    );
  }

  it('routes a cross-auth fast model through a runtime content-generator view', () =>
    expectFastModelRoute('claude-main', AuthType.USE_ANTHROPIC, []));

  it('routes a same-auth fast model through a runtime content-generator view when the model differs', () =>
    expectFastModelRoute('gpt-4', AuthType.USE_OPENAI, ['gpt-4']));

  it('falls back to the parent model when `fast` cannot resolve (no fast model configured)', async () => {
    // Public API footgun: `model: 'fast'` with no fast model configured must
    // not send the literal `'fast'` to the provider; the forked path inherits
    // the parent model, matching the subagent path's semantics.
    saveCacheSafeParams(
      { systemInstruction: 'You are helpful' },
      [userText('hello')],
      'parent-model',
    );
    const send = mockForkStream([modelChunk([{ text: 'ok' }])]);
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('parent-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: 'parent-model',
        authType: AuthType.QWEN_OAUTH,
      }),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getAllConfiguredModels: vi.fn(() => []),
    } as unknown as Config;

    const result = await runFork({ config: mockConfig, model: 'fast' });

    expect(send.mock.calls[0][0]).toBe('parent-model');
    expect(result.model).toBe('parent-model');
    expect(createRuntimeContentGeneratorView).not.toHaveBeenCalled();
  });

  it('does not strip tools when preserveTools is true', async () => {
    saveCacheSafeParams(
      {
        systemInstruction: 'You are helpful',
        tools: parentTools('edit', 'shell'),
      },
      [userText('hello')],
      'test-model',
    );
    const send = mockForkStream([
      modelChunk([{ text: '{"suggestion":"run tests"}' }], undefined, USAGE),
    ]);

    await runFork({ preserveTools: true });

    expect(sentConfig(send).tools).toBeUndefined();
  });

  it('strips tools when preserveTools is explicitly false', async () => {
    saveCacheSafeParams({ tools: parentTools('edit') }, [], 'test-model');
    const send = mockForkStream([modelChunk([{ text: 'ok' }])]);

    await runFork({ preserveTools: false });

    expect(sentConfig(send).tools).toEqual([]);
  });

  it.each([undefined, 'container'] as const)(
    'filters out functionCall parts with preserveTools and operator backend %s',
    async (backend) => {
      saveCacheSafeParams(
        { systemInstruction: 'You are helpful', tools: parentTools('edit') },
        [],
        'test-model',
      );
      mockForkStream([
        modelChunk(
          [{ text: 'some text' }, fnCall('edit', { file: 'a.ts' })],
          undefined,
          { ...USAGE, totalTokenCount: 15 },
        ),
      ]);

      const result = await runFork({
        config: { getAgentExecutionBackend: () => backend } as Config,
        preserveTools: true,
      });

      expect(result.text).toBe('some text');
    },
  );

  it('returns null text when response contains only functionCall parts', async () => {
    saveCacheSafeParams(
      { systemInstruction: 'You are helpful', tools: parentTools('edit') },
      [],
      'test-model',
    );
    mockForkStream([
      modelChunk([fnCall('edit', { file: 'a.ts' })], undefined, {
        ...USAGE,
        totalTokenCount: 15,
      }),
    ]);

    const result = await runFork({ preserveTools: true });

    expect(result.text).toBeNull();
  });

  it('preserves the parent tool prefix for structured suggestions', async () => {
    saveCacheSafeParams(
      {
        systemInstruction: 'You are helpful',
        tools: parentTools('edit', 'shell'),
      },
      [],
      'test-model',
    );
    const send = mockForkStream([
      modelChunk([{ text: '{"suggestion":"run tests"}' }], undefined, USAGE),
    ]);
    const schema = {
      type: 'object',
      properties: { suggestion: { type: 'string' } },
    };

    const result = await runFork({ preserveTools: true, jsonSchema: schema });

    const config = sentConfig(send);
    expect(config.tools).toBeUndefined();
    expect(config.toolConfig).toBeUndefined();
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseJsonSchema).toEqual(schema);
    expect(result.jsonResult).toEqual({ suggestion: 'run tests' });
  });

  it('throws when CacheSafeParams are not available', async () => {
    // Deliberately saves nothing. The cache path takes cacheSafeParams
    // explicitly; the null guard lives in the callers (btwCommand,
    // suggestionGenerator), which check getCacheSafeParams() first.
    expect(getCacheSafeParams()).toBeNull();
  });
});
