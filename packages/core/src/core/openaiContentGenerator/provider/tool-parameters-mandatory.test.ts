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
import { MiniMaxOpenAICompatibleProvider } from './minimax.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { ToolParametersMandatoryOpenAICompatibleProvider } from './tool-parameters-mandatory.js';

describe('ToolParametersMandatoryOpenAICompatibleProvider', () => {
  const mockCliConfig = {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  function createConfig(
    baseUrl: string,
    toolParametersMandatory?: boolean,
  ): ContentGeneratorConfig {
    return {
      model: 'local-model',
      apiKey: 'test-api-key',
      baseUrl,
      ...(toolParametersMandatory === undefined
        ? {}
        : { toolParametersMandatory }),
    } as ContentGeneratorConfig;
  }

  describe('isToolParametersMandatory', () => {
    it('matches only an explicit opt-in', () => {
      expect(
        ToolParametersMandatoryOpenAICompatibleProvider.isToolParametersMandatory(
          createConfig('http://localhost:5000/v1', true),
        ),
      ).toBe(true);
      expect(
        ToolParametersMandatoryOpenAICompatibleProvider.isToolParametersMandatory(
          createConfig('http://localhost:5000/v1', false),
        ),
      ).toBe(false);
      expect(
        ToolParametersMandatoryOpenAICompatibleProvider.isToolParametersMandatory(
          createConfig('http://localhost:5000/v1'),
        ),
      ).toBe(false);
    });

    it('never matches on the endpoint URL alone', () => {
      // A self-hosted server shares localhost with llama.cpp / LM Studio /
      // Ollama, which need the opposite shape, so the URL must not select it.
      expect(
        ToolParametersMandatoryOpenAICompatibleProvider.isToolParametersMandatory(
          createConfig('http://localhost:5000/v1'),
        ),
      ).toBe(false);
      expect(
        ToolParametersMandatoryOpenAICompatibleProvider.isToolParametersMandatory(
          createConfig('http://127.0.0.1:8080/v1'),
        ),
      ).toBe(false);
    });
  });

  describe('provider selection', () => {
    it('is selected by the OpenAI-compatible provider factory', () => {
      const provider = determineProvider(
        createConfig('http://localhost:5000/v1', true),
        mockCliConfig,
      );

      expect(provider).toBeInstanceOf(
        ToolParametersMandatoryOpenAICompatibleProvider,
      );
    });

    it('leaves an opted-out route on the default provider', () => {
      const provider = determineProvider(
        createConfig('http://localhost:5000/v1'),
        mockCliConfig,
      );

      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(provider).not.toBeInstanceOf(
        ToolParametersMandatoryOpenAICompatibleProvider,
      );
    });

    it('stays behind a vendor hostname whose provider injects its own shape', () => {
      const provider = determineProvider(
        createConfig('https://api.minimaxi.com/v1', true),
        mockCliConfig,
      );

      expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
    });
  });

  describe('buildRequest', () => {
    function buildWithTools(
      tools: OpenAI.Chat.ChatCompletionTool[],
    ): OpenAI.Chat.ChatCompletionCreateParams {
      const provider = new ToolParametersMandatoryOpenAICompatibleProvider(
        createConfig('http://localhost:5000/v1', true),
        mockCliConfig,
      );
      return provider.buildRequest(
        {
          model: 'local-model',
          messages: [{ role: 'user', content: 'Hello' }],
          tools,
        },
        'prompt-id',
      );
    }

    it('emits an object schema for a tool that declares no parameters', () => {
      const result = buildWithTools([
        {
          type: 'function',
          function: { name: 'cron_list', description: 'desc' },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'cron_list',
            description: 'desc',
            parameters: { type: 'object' },
          },
        },
      ]);
    });

    it('emits the schema when the converter left parameters present-but-undefined', () => {
      // converter.ts emits parameterless tools with `parameters: undefined`
      // (key present); the predicate must test the value, not key presence, or
      // the production shape stops receiving the fix.
      const result = buildWithTools([
        {
          type: 'function',
          function: {
            name: 'cron_status',
            description: 'desc',
            parameters: undefined,
          },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'cron_status',
            description: 'desc',
            parameters: { type: 'object' },
          },
        },
      ]);
    });

    it('passes a tool with a declared schema through unchanged', () => {
      const schema = {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      };

      const result = buildWithTools([
        {
          type: 'function',
          function: { name: 'read_file', description: 'd', parameters: schema },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: { name: 'read_file', description: 'd', parameters: schema },
        },
      ]);
    });

    it('keeps a request without tools tool-free', () => {
      const provider = new ToolParametersMandatoryOpenAICompatibleProvider(
        createConfig('http://localhost:5000/v1', true),
        mockCliConfig,
      );
      const result = provider.buildRequest(
        {
          model: 'local-model',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'prompt-id',
      );

      expect(result.tools).toBeUndefined();
    });
  });
});
