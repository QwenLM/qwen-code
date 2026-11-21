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

    it('matches a private LAN peer or the container alias on the default port', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://192.168.1.50:11434/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://10.0.0.5:11434/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://172.16.0.9:11434/v1'),
        ),
      ).toBe(true);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://host.docker.internal:11434/v1'),
        ),
      ).toBe(true);
    });

    it('does not treat a public host on the default port as Ollama', () => {
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('http://192.168.1.50:8000/v1'),
        ),
      ).toBe(false);
      expect(
        OllamaOpenAICompatibleProvider.isOllamaProvider(
          createConfig('https://api.openai.com:11434/v1'),
        ),
      ).toBe(false);
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

  it('wins the ladder over the DeepSeek model-name fallback on a local endpoint', () => {
    // A localhost:11434 endpoint serving a deepseek model must reach the Ollama
    // provider so the empty-schema injection runs; otherwise the broad
    // isDeepSeekProvider (which matches the model name on any hostname) claims
    // it and zero-argument tools go out without `parameters`.
    const provider = determineProvider(
      {
        model: 'deepseek-r1:8b',
        apiKey: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
      } as ContentGeneratorConfig,
      mockCliConfig,
    );

    expect(provider).toBeInstanceOf(OllamaOpenAICompatibleProvider);
  });

  it('still routes a real DeepSeek hostname to its own provider', () => {
    const provider = determineProvider(
      {
        model: 'deepseek-r1:8b',
        apiKey: 'x',
        baseUrl: 'https://api.deepseek.com/v1',
      } as ContentGeneratorConfig,
      mockCliConfig,
    );

    expect(provider).not.toBeInstanceOf(OllamaOpenAICompatibleProvider);
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

    it('leaves a tool-less request with no tools to inject', () => {
      const provider = new OllamaOpenAICompatibleProvider(
        createConfig('http://localhost:11434/v1'),
        mockCliConfig,
      );
      const result = provider.buildRequest(
        {
          model: 'qwen3:4b',
          messages: [{ role: 'user', content: 'Hello' }],
        } as OpenAI.Chat.ChatCompletionCreateParams,
        'prompt-id',
      );

      expect(result.tools).toBeUndefined();
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
