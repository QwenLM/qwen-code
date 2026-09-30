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
import { OllamaOpenAICompatibleProvider } from './ollama.js';

describe('OllamaOpenAICompatibleProvider', () => {
  const mockCliConfig = {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  function createConfig(baseUrl?: string): ContentGeneratorConfig {
    return {
      model: 'qwen3:4b',
      apiKey: 'ollama',
      ...(baseUrl ? { baseUrl } : {}),
    } as ContentGeneratorConfig;
  }

  describe('isOllamaProvider', () => {
    it('matches a local Ollama server on the default port', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://localhost:11434/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://127.0.0.1:11434/v1'),
        ),
      ).toBe(true);
    });

    it('matches a local Ollama server reached over IPv6 loopback', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://[::1]:11434/v1'),
        ),
      ).toBe(true);
    });

    it('matches a host named ollama on any port', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://ollama:11434/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('https://ollama.example.com/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://my-ollama.lan:11434/v1'),
        ),
      ).toBe(true);
    });

    it('does not match other local servers or unrelated hosts', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://localhost:8000/v1'),
        ),
      ).toBe(false);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('https://api.openai.com/v1'),
        ),
      ).toBe(false);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('https://notollama.com/v1'),
        ),
      ).toBe(false);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('not a url'),
        ),
      ).toBe(false);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(createConfig()),
      ).toBe(false);
    });
  });

  it('is selected by the OpenAI-compatible provider factory', () => {
    const provider = determineProvider(
      createConfig('http://localhost:11434/v1'),
      mockCliConfig,
    );

    expect(provider).toBeInstanceOf(OllamaOpenAICompatibleProvider);
  });

  describe('buildRequest', () => {
    function buildWithTools(
      tools: OpenAI.Chat.ChatCompletionTool[],
    ): OpenAI.Chat.ChatCompletionCreateParams {
      const provider = new OllamaOpenAICompatibleProvider(
        createConfig('http://localhost:11434/v1'),
        mockCliConfig,
      );
      return provider.buildRequest(
        {
          model: 'qwen3:4b',
          messages: [{ role: 'user', content: 'Hello' }],
          tools,
        },
        'prompt-id',
      );
    }

    it('injects an empty schema on zero-argument tools', () => {
      const result = buildWithTools([
        {
          type: 'function',
          function: { name: 'get_goal', description: 'desc' },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_goal',
            description: 'desc',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });

    it('injects the schema when the converter left parameters present-but-undefined', () => {
      const result = buildWithTools([
        {
          type: 'function',
          function: {
            name: 'list_agents',
            description: 'desc',
            parameters: undefined,
          },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'list_agents',
            description: 'desc',
            parameters: { type: 'object', properties: {} },
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
  });
});
