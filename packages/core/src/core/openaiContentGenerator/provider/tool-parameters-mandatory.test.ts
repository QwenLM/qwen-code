/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import type { OpenAICompatibleProvider } from './types.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { DashScopeOpenAICompatibleProvider } from './dashscope.js';
import { DeepSeekOpenAICompatibleProvider } from './deepseek.js';
import { MiMoOpenAICompatibleProvider } from './mimo.js';
import { MiniMaxOpenAICompatibleProvider } from './minimax.js';
import { MistralOpenAICompatibleProvider } from './mistral.js';
import { ZaiOpenAICompatibleProvider } from './zai.js';

const EMPTY_PARAMETERS = { type: 'object', properties: {} };

const mockCliConfig = {
  getCliVersion: vi.fn().mockReturnValue('1.0.0'),
  getProxy: vi.fn().mockReturnValue(undefined),
  getContentGeneratorConfig: vi.fn().mockReturnValue({}),
} as unknown as Config;

// converter.ts emits a parameterless tool with `parameters: undefined` (key
// present), so the repair must test the value rather than key presence.
const CONVERTER_SHAPE: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: { name: 'cron_list', description: 'desc', parameters: undefined },
};

function createConfig(
  model: string,
  baseUrl: string,
  toolParametersMandatory?: boolean,
): ContentGeneratorConfig {
  return {
    model,
    apiKey: 'test-api-key',
    baseUrl,
    ...(toolParametersMandatory === undefined
      ? {}
      : { toolParametersMandatory }),
  } as ContentGeneratorConfig;
}

function outboundRequest(
  config: ContentGeneratorConfig,
  provider: OpenAICompatibleProvider,
  tools: OpenAI.Chat.ChatCompletionTool[] | null = [CONVERTER_SHAPE],
): OpenAI.Chat.ChatCompletionCreateParams {
  return provider.buildRequest(
    {
      model: config.model,
      messages: [{ role: 'user', content: 'Hello' }],
      ...(tools === null ? {} : { tools }),
    },
    'prompt-id',
  );
}

function outboundTool(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionTool {
  const emitted = request.tools?.[0];
  if (!emitted) throw new Error('expected the request to carry a tool');
  return emitted;
}

describe('generationConfig.toolParametersMandatory', () => {
  describe('routes whose vendor predicate matches the model name', () => {
    // These four predicates match a model id at any baseUrl, so a self-hosted
    // strict server reaches them without ever reaching the default provider.
    // max_tokens is contributed by the request the provider builds before the
    // repair runs, so pinning it catches a repair wired to the inbound request
    // instead of the built one — the tool mapping alone cannot tell them apart.
    const cases = [
      {
        model: 'deepseek-v4.1-flash',
        ctor: DeepSeekOpenAICompatibleProvider,
        maxTokens: 64_000,
      },
      {
        model: 'glm-4.6',
        ctor: ZaiOpenAICompatibleProvider,
        maxTokens: 32_000,
      },
      {
        model: 'mimo-7b',
        ctor: MiMoOpenAICompatibleProvider,
        maxTokens: 32_000,
      },
      {
        model: 'mistral-small',
        ctor: MistralOpenAICompatibleProvider,
        maxTokens: 32_000,
      },
    ] as const;

    it.each(cases)(
      'repairs on the $model route while its provider stays selected',
      ({ model, ctor, maxTokens }) => {
        const config = createConfig(model, 'http://localhost:5000/v1', true);
        const provider = determineProvider(config, mockCliConfig);

        expect(provider).toBeInstanceOf(ctor);
        const request = outboundRequest(config, provider);

        expect(outboundTool(request).function.parameters).toEqual(
          EMPTY_PARAMETERS,
        );
        expect(request.max_tokens).toBe(maxTokens);
      },
    );
  });

  describe('routes with no vendor predicate', () => {
    it('omits the field by default', () => {
      const config = createConfig('local-model', 'http://localhost:5000/v1');
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toBeUndefined();
      expect(request.max_tokens).toBe(32_000);
    });

    it('emits the schema when opted in', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
      expect(request.max_tokens).toBe(32_000);
    });

    it('repairs a tool that declares no schema at all', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      const request = outboundRequest(config, provider, [
        {
          type: 'function',
          function: { name: 'cron_list', description: 'desc' },
        },
      ]);

      expect(outboundTool(request).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
      expect(request.max_tokens).toBe(32_000);
    });
  });

  describe('the route that builds its request without super', () => {
    // DashScope merges user extra_body last and calls the repair from that
    // merge, so extra_body is what its own build step contributes.
    const EXTRA_BODY = { custom: 'value' };

    function dashScopeConfig(
      toolParametersMandatory?: boolean,
    ): ContentGeneratorConfig {
      return {
        ...createConfig(
          'qwen3-8b',
          'http://localhost:5000/v1',
          toolParametersMandatory,
        ),
        extra_body: EXTRA_BODY,
      };
    }

    it('emits the schema on DashScope when opted in', () => {
      const config = dashScopeConfig(true);
      const provider = new DashScopeOpenAICompatibleProvider(
        config,
        mockCliConfig,
      );

      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
      expect(request as unknown as Record<string, unknown>).toMatchObject(
        EXTRA_BODY,
      );
    });

    it('leaves the DashScope omission intact without the opt-in', () => {
      const config = dashScopeConfig();
      const provider = new DashScopeOpenAICompatibleProvider(
        config,
        mockCliConfig,
      );

      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toBeUndefined();
      expect(request as unknown as Record<string, unknown>).toMatchObject(
        EXTRA_BODY,
      );
    });
  });

  describe('the vendor that needs the field unconditionally', () => {
    it('emits the schema on MiniMax without the opt-in', () => {
      const config = createConfig('local-model', 'https://api.minimaxi.com/v1');
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
      expect(request.max_tokens).toBe(32_000);
    });

    it('emits the schema on MiniMax when opted in', () => {
      const config = createConfig(
        'local-model',
        'https://api.minimaxi.com/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
      const request = outboundRequest(config, provider);

      expect(outboundTool(request).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
      expect(request.max_tokens).toBe(32_000);
    });
  });

  describe('tools that already declare a schema', () => {
    it('passes a declared schema through unchanged', () => {
      const schema = {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      };
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      const request = outboundRequest(config, provider, [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'desc',
            parameters: schema,
          },
        },
      ]);

      expect(request.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'desc',
            parameters: schema,
          },
        },
      ]);
      expect(request.max_tokens).toBe(32_000);
    });

    it('keeps a request without tools tool-free', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      const request = outboundRequest(config, provider, null);

      expect(request.tools).toBeUndefined();
      expect(request.max_tokens).toBe(32_000);
    });
  });
});
