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

describe('MiniMaxOpenAICompatibleProvider', () => {
  const mockCliConfig = {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  function createConfig(baseUrl?: string): ContentGeneratorConfig {
    return {
      model: 'MiniMax-M2.7',
      apiKey: 'test-api-key',
      ...(baseUrl ? { baseUrl } : {}),
    } as ContentGeneratorConfig;
  }

  describe('isMiniMaxProvider', () => {
    it('matches the official OpenAI-compatible MiniMax API host', () => {
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.minimaxi.com/v1'),
        ),
      ).toBe(true);
    });

    it('matches the official international OpenAI-compatible MiniMax API host', () => {
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.minimax.io/v1'),
        ),
      ).toBe(true);
    });

    it('matches known hosts via exact match (api.minimaxi.com)', () => {
      // Exact match on the well-known host, not suffix-based
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.minimaxi.com/v1/chat/completions'),
        ),
      ).toBe(true);
    });

    it('matches known hosts via exact match (api.minimax.io)', () => {
      // Exact match on the well-known host, not suffix-based
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.minimax.io/v1/chat/completions'),
        ),
      ).toBe(true);
    });

    it('matches MiniMax subdomain hosts via wildcard suffix', () => {
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://gateway.minimaxi.com/v1'),
        ),
      ).toBe(true);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.minimaxi.com/v1/chat/completions'),
        ),
      ).toBe(true);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://custom.api.minimax.io/v1'),
        ),
      ).toBe(true);
    });

    it('matches custom proxy subdomains via suffix fallback', () => {
      // Suffix matching intentionally matches any subdomain under
      // minimaxi.com / minimax.io to support custom MiniMax deployments.
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://my-proxy.minimaxi.com/v1'),
        ),
      ).toBe(true);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://custom-gateway.minimax.io/v1'),
        ),
      ).toBe(true);
    });

    it('does not match unrelated or invalid URLs', () => {
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://api.openai.com/v1'),
        ),
      ).toBe(false);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://minimaxi.com/v1'),
        ),
      ).toBe(false);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('https://minimax.io/v1'),
        ),
      ).toBe(false);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
          createConfig('not a url'),
        ),
      ).toBe(false);
      expect(
        MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(createConfig()),
      ).toBe(false);
    });
  });

  it('enables tagged thinking response parsing', () => {
    const provider = new MiniMaxOpenAICompatibleProvider(
      createConfig('https://api.minimaxi.com/v1'),
      mockCliConfig,
    );

    expect(provider.getResponseParsingOptions()).toEqual({
      taggedThinkingTags: true,
    });
  });

  it('is selected by the OpenAI-compatible provider factory', () => {
    const provider = determineProvider(
      createConfig('https://api.minimax.io/v1'),
      mockCliConfig,
    );

    expect(provider).toBeInstanceOf(MiniMaxOpenAICompatibleProvider);
  });

  describe('buildRequest', () => {
    function buildWithTools(
      tools: OpenAI.Chat.ChatCompletionTool[],
    ): OpenAI.Chat.ChatCompletionCreateParams {
      const provider = new MiniMaxOpenAICompatibleProvider(
        createConfig('https://api.minimaxi.com/v1'),
        mockCliConfig,
      );
      return provider.buildRequest(
        {
          model: 'MiniMax-M3',
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
          function: { name: 'cron_list', description: 'desc' },
        },
      ]);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'cron_list',
            description: 'desc',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });

    it('injects the schema when the converter left parameters present-but-undefined', () => {
      // converter.ts emits parameterless tools with `parameters: undefined`
      // (key present); the injection predicate must test the value, not key
      // presence, or the production shape stops receiving the fix.
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
