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

function outboundTool(
  config: ContentGeneratorConfig,
  provider: OpenAICompatibleProvider,
  tool: OpenAI.Chat.ChatCompletionTool = CONVERTER_SHAPE,
): OpenAI.Chat.ChatCompletionTool {
  const request = provider.buildRequest(
    {
      model: config.model,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [tool],
    },
    'prompt-id',
  );

  const emitted = request.tools?.[0];
  if (!emitted) throw new Error('expected the request to carry a tool');
  return emitted;
}

describe('generationConfig.toolParametersMandatory', () => {
  describe('routes whose vendor predicate matches the model name', () => {
    // These four predicates match a model id at any baseUrl, so a self-hosted
    // strict server reaches them without ever reaching the default provider.
    const cases = [
      { model: 'deepseek-v4.1-flash', ctor: DeepSeekOpenAICompatibleProvider },
      { model: 'glm-4.6', ctor: ZaiOpenAICompatibleProvider },
      { model: 'mimo-7b', ctor: MiMoOpenAICompatibleProvider },
      { model: 'mistral-small', ctor: MistralOpenAICompatibleProvider },
    ] as const;

    it.each(cases)(
      'repairs on the $model route while its provider stays selected',
      ({ model, ctor }) => {
        const config = createConfig(model, 'http://localhost:5000/v1', true);
        const provider = determineProvider(config, mockCliConfig);

        expect(provider).toBeInstanceOf(ctor);
        expect(outboundTool(config, provider).function.parameters).toEqual(
          EMPTY_PARAMETERS,
        );
      },
    );
  });

  describe('routes with no vendor predicate', () => {
    it('omits the field by default', () => {
      const config = createConfig('local-model', 'http://localhost:5000/v1');
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(
        outboundTool(config, provider).function.parameters,
      ).toBeUndefined();
    });

    it('emits the schema when opted in', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(outboundTool(config, provider).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
    });

    it('repairs a tool that declares no schema at all', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      expect(
        outboundTool(config, provider, {
          type: 'function',
          function: { name: 'cron_list', description: 'desc' },
        }).function.parameters,
      ).toEqual(EMPTY_PARAMETERS);
    });
  });

  describe('the route that builds its request without super', () => {
    it('emits the schema on DashScope when opted in', () => {
      const config = createConfig('qwen3-8b', 'http://localhost:5000/v1', true);
      const provider = new DashScopeOpenAICompatibleProvider(
        config,
        mockCliConfig,
      );

      expect(outboundTool(config, provider).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
    });

    it('leaves the DashScope omission intact without the opt-in', () => {
      const config = createConfig('qwen3-8b', 'http://localhost:5000/v1');
      const provider = new DashScopeOpenAICompatibleProvider(
        config,
        mockCliConfig,
      );

      expect(
        outboundTool(config, provider).function.parameters,
      ).toBeUndefined();
    });
  });

  describe('the vendor that needs the field unconditionally', () => {
    it('emits the schema on MiniMax without the opt-in', () => {
      const config = createConfig('local-model', 'https://api.minimaxi.com/v1');
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
      expect(outboundTool(config, provider).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
    });

    it('emits the schema on MiniMax when opted in', () => {
      const config = createConfig(
        'local-model',
        'https://api.minimaxi.com/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
      expect(outboundTool(config, provider).function.parameters).toEqual(
        EMPTY_PARAMETERS,
      );
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

      const request = provider.buildRequest(
        {
          model: config.model,
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'desc',
                parameters: schema,
              },
            },
          ],
        },
        'prompt-id',
      );

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
    });

    it('keeps a request without tools tool-free', () => {
      const config = createConfig(
        'local-model',
        'http://localhost:5000/v1',
        true,
      );
      const provider = determineProvider(config, mockCliConfig);

      const request = provider.buildRequest(
        {
          model: config.model,
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'prompt-id',
      );

      expect(request.tools).toBeUndefined();
    });
  });
});
