/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { DeepSeekOpenAICompatibleProvider } from './deepseek.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { Config } from '../../../config/config.js';

// Mock OpenAI client to avoid real network calls
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({
    config,
  })),
}));

describe('DeepSeekOpenAICompatibleProvider', () => {
  let provider: DeepSeekOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new DeepSeekOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('isDeepSeekProvider', () => {
    it('returns true when baseUrl includes deepseek', () => {
      const result = DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(
        mockContentGeneratorConfig,
      );
      expect(result).toBe(true);
    });

    it('returns false when neither baseUrl nor model match deepseek', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
      } as ContentGeneratorConfig;

      const result =
        DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(config);
      expect(result).toBe(false);
    });

    it('returns true for deepseek model on a non-deepseek baseUrl (e.g. sglang) — issue #3613', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://my-sglang.example.com:8000/v1',
        model: 'deepseek-v4-pro',
      } as ContentGeneratorConfig;

      const result =
        DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(config);
      expect(result).toBe(true);
    });

    it('matches model name case-insensitively', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://my-vllm.example.com/v1',
        model: 'DeepSeek-R1',
      } as ContentGeneratorConfig;

      const result =
        DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(config);
      expect(result).toBe(true);
    });
  });

  describe('buildRequest', () => {
    const userPromptId = 'prompt-123';

    it('converts array content into a string', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world' },
            ],
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello\n\n world',
      });
      expect(originalRequest.messages?.[0].content).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
    });

    it('leaves string content unchanged', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: 'Hello world',
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages?.[0].content).toBe('Hello world');
    });

    it('handles plain string parts in the content array', () => {
      const originalRequest = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user' as const,
            content: [
              'Hello',
              { type: 'text' as const, text: ' world' },
            ] as unknown as OpenAI.Chat.ChatCompletionContentPart[],
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello\n\n world',
      });
    });

    it('replaces non-text parts with a placeholder', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello ' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.png' },
              },
            ],
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello \n\n[Unsupported content type: image_url]',
      });
    });

    // https://github.com/QwenLM/qwen-code/issues/3695 — DeepSeek's thinking
    // mode rejects subsequent requests when any prior assistant turn omits
    // reasoning_content, even if the model itself returned no reasoning text.
    // The provider must always send the field.
    it('injects empty reasoning_content on tool-calling assistant turns missing it', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: 'list markdown files' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'Found 2 matching file(s)',
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      const assistant = result.messages?.[1] as {
        role: string;
        reasoning_content?: string;
      };
      expect(assistant.role).toBe('assistant');
      expect(assistant.reasoning_content).toBe('');
    });

    it('preserves existing reasoning_content on tool-calling assistant turns', () => {
      const originalRequest = {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user' as const, content: 'list markdown files' },
          {
            role: 'assistant' as const,
            content: null,
            reasoning_content: 'Let me glob first.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
              },
            ],
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);

      const assistant = result.messages?.[1] as {
        reasoning_content?: string;
      };
      expect(assistant.reasoning_content).toBe('Let me glob first.');
    });

    it('injects empty reasoning_content on assistant turns without tool_calls', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      const assistant = result.messages?.[1] as {
        reasoning_content?: string;
      };
      expect(assistant.reasoning_content).toBe('');
    });

    // https://api-docs.deepseek.com/zh-cn/api/create-chat-completion —
    // DeepSeek expects a flat `reasoning_effort` body parameter (high/max);
    // the standard `reasoning: { effort }` shape from the OpenAI pipeline
    // would otherwise be ignored.
    it('translates `reasoning.effort` into top-level `reasoning_effort`', () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'max' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toBeUndefined();
    });

    it('passes through `reasoning_effort: high` unchanged', () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      expect(r['reasoning_effort']).toBe('high');
      expect(r['reasoning']).toBeUndefined();
    });

    it("maps backward-compat 'xhigh' effort to 'max' (DeepSeek doc behavior)", () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'xhigh' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      expect(r['reasoning_effort']).toBe('max');
    });

    it('maps backward-compat `low`/`medium` effort to `high` (DeepSeek doc behavior)', () => {
      for (const effort of ['low', 'medium'] as const) {
        const originalRequest = {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning: { effort },
        } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

        const result = provider.buildRequest(originalRequest, userPromptId);
        const r = result as unknown as Record<string, unknown>;
        expect(r['reasoning_effort']).toBe('high');
      }
    });

    it('preserves an explicitly set top-level `reasoning_effort` (no clobber)', () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      // Top-level value wins; nested shape is stripped to avoid sending both.
      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toBeUndefined();
    });

    it('keeps the rest of the `reasoning` object when only `effort` is stripped', () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'max', budget_tokens: 50_000 },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toEqual({ budget_tokens: 50_000 });
    });

    it('leaves a request without `reasoning.effort` untouched', () => {
      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(originalRequest, userPromptId);
      const r = result as unknown as Record<string, unknown>;

      expect(r['reasoning_effort']).toBeUndefined();
      expect(r['reasoning']).toBeUndefined();
    });

    it('does NOT translate reasoning_effort on a non-DeepSeek hostname (model-name fallback only)', () => {
      // The provider class is selected by `isDeepSeekProvider`, which
      // matches the broader hostname-OR-model rule (covers sglang/vllm
      // self-hosting DeepSeek models). But the DeepSeek-specific
      // `reasoning_effort` body shape only ships on actual DeepSeek
      // hostnames; otherwise a strict OpenAI-compat backend would see
      // an unexpected request shape change. Content flattening still
      // runs (it's a model-format constraint, not a wire-shape one).
      const selfHostedConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://my-sglang.example.com:8000/v1',
        model: 'deepseek-v4-pro',
      } as ContentGeneratorConfig;
      const selfHostedProvider = new DeepSeekOpenAICompatibleProvider(
        selfHostedConfig,
        mockCliConfig,
      );

      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
          },
        ],
        reasoning: { effort: 'max' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = selfHostedProvider.buildRequest(
        originalRequest,
        userPromptId,
      );
      const r = result as unknown as Record<string, unknown>;

      // reasoning_effort NOT injected, nested reasoning preserved verbatim.
      expect(r['reasoning_effort']).toBeUndefined();
      expect(r['reasoning']).toEqual({ effort: 'max' });
      // Content flattening still ran.
      expect((result.messages?.[0] as { content: unknown }).content).toBe('hi');
    });
  });

  describe('isDeepSeekHostname', () => {
    it('matches api.deepseek.com baseUrls', () => {
      expect(
        DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
          baseUrl: 'https://api.deepseek.com/v1',
        } as ContentGeneratorConfig),
      ).toBe(true);
    });

    it('does NOT match a self-hosted host even when model name is deepseek', () => {
      expect(
        DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
          baseUrl: 'https://my-sglang.example.com:8000/v1',
          model: 'deepseek-v4-pro',
        } as ContentGeneratorConfig),
      ).toBe(false);
    });

    it('matches subdomains of api.deepseek.com', () => {
      expect(
        DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
          baseUrl: 'https://us.api.deepseek.com/v1',
        } as ContentGeneratorConfig),
      ).toBe(true);
    });

    it('rejects hostile hostnames that contain api.deepseek.com as a substring', () => {
      // Naive substring matching would let an attacker route requests
      // through e.g. `api.deepseek.com.evil.com` and inject the
      // DeepSeek-only `reasoning_effort` body parameter into a
      // non-DeepSeek backend. Parse with `new URL` and match the
      // hostname exactly to block this.
      for (const baseUrl of [
        'https://api.deepseek.com.evil.com/v1',
        'https://evil.com/api.deepseek.com/v1',
        'https://api.deepseek.comevil.com/v1',
        'https://api-deepseek-com.example.com/v1',
      ]) {
        expect(
          DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
            baseUrl,
          } as ContentGeneratorConfig),
        ).toBe(false);
      }
    });

    it('treats invalid URLs as non-DeepSeek', () => {
      expect(
        DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
          baseUrl: 'not-a-url',
        } as ContentGeneratorConfig),
      ).toBe(false);
      expect(
        DeepSeekOpenAICompatibleProvider.isDeepSeekHostname({
          baseUrl: '',
        } as ContentGeneratorConfig),
      ).toBe(false);
    });
  });

  describe('getDefaultGenerationConfig', () => {
    it('returns temperature 0', () => {
      expect(provider.getDefaultGenerationConfig()).toEqual({
        temperature: 0,
      });
    });
  });
});
