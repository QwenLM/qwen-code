/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { DeepSeekOpenAICompatibleProvider } from './deepseek.js';
import { determineProvider } from '../index.js';
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

  const withConfig = (overrides: Partial<ContentGeneratorConfig>) =>
    ({ ...mockContentGeneratorConfig, ...overrides }) as ContentGeneratorConfig;

  const providerFor = (baseUrl: string, model: string) =>
    new DeepSeekOpenAICompatibleProvider(
      withConfig({ baseUrl, model }),
      mockCliConfig,
    );

  describe('isDeepSeekProvider', () => {
    const isDeepSeek = (baseUrl: string, model: string) =>
      DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(
        withConfig({ baseUrl, model }),
      );

    it('returns true when baseUrl includes deepseek', () => {
      const result = DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(
        mockContentGeneratorConfig,
      );
      expect(result).toBe(true);
    });

    it('returns false when neither baseUrl nor model match deepseek', () => {
      expect(isDeepSeek('https://api.example.com/v1', 'gpt-4o')).toBe(false);
    });

    it('returns true for deepseek model on a non-deepseek baseUrl (e.g. sglang) — issue #3613', () => {
      expect(
        isDeepSeek('https://my-sglang.example.com:8000/v1', 'deepseek-v4-pro'),
      ).toBe(true);
    });

    it('matches model name case-insensitively', () => {
      expect(isDeepSeek('https://my-vllm.example.com/v1', 'DeepSeek-R1')).toBe(
        true,
      );
    });
  });

  describe('buildRequest', () => {
    const userPromptId = 'prompt-123';

    /** Builds `{ model, messages: [user 'hi'], ...fields }` through `target`. */
    const buildHi = (
      fields: Record<string, unknown>,
      {
        model = 'deepseek-v4-pro',
        target = provider,
        promptId = userPromptId,
      } = {},
    ) =>
      target.buildRequest(
        {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          ...fields,
        } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
        promptId,
      ) as unknown as Record<string, unknown>;

    it('caps max on an unverified endpoint that merely has deepseek in the model name', () => {
      const model = 'deepseek-r1-distill';
      const result = buildHi(
        { reasoning: { effort: 'max' } },
        {
          model,
          target: providerFor('https://llm.example.com/v1', model),
          promptId: 'prompt-id',
        },
      );

      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
      expect(result['reasoning_effort']).toBeUndefined();
    });

    it('keeps the max tier on a verified DeepSeek host', () => {
      const model = 'deepseek-reasoner';
      const result = buildHi(
        { reasoning: { effort: 'max' } },
        {
          model,
          target: providerFor('https://api.deepseek.com/v1', model),
          promptId: 'prompt-id',
        },
      );

      expect(result['reasoning_effort']).toBe('max');
    });

    /** Builds a deepseek-chat request holding one user message. */
    const buildUser = (content: unknown) => {
      const request = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content }],
      } as OpenAI.Chat.ChatCompletionCreateParams;
      return { request, result: provider.buildRequest(request, userPromptId) };
    };

    it('converts array content into a string', () => {
      const { request, result } = buildUser([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);

      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello\n\n world',
      });
      expect(request.messages?.[0].content).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
    });

    it('leaves string content unchanged', () => {
      const { result } = buildUser('Hello world');
      expect(result.messages?.[0].content).toBe('Hello world');
    });

    it('handles plain string parts in the content array', () => {
      const { result } = buildUser(['Hello', { type: 'text', text: ' world' }]);
      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello\n\n world',
      });
    });

    it('replaces non-text parts with a placeholder', () => {
      const { result } = buildUser([
        { type: 'text', text: 'Hello ' },
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/image.png' },
        },
      ]);

      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello \n\n[Unsupported content type: image_url]',
      });
    });

    it.each(['https://opencode.ai/zen/go/v1', 'https://api.deepseek.com'])(
      'preserves image parts when image input is enabled on %s',
      (baseUrl) => {
        const config = withConfig({
          baseUrl,
          model: 'deepseek-v4-flash-vision-exp',
          modalities: { image: true },
        });
        const visionProvider = determineProvider(config, mockCliConfig);
        const expectedMessage = {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png' },
            },
          ],
        } satisfies OpenAI.Chat.ChatCompletionUserMessageParam;
        const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'deepseek-v4-flash-vision-exp',
          messages: [structuredClone(expectedMessage)],
        };

        const result = visionProvider.buildRequest(
          originalRequest,
          userPromptId,
        );

        expect(visionProvider).toBeInstanceOf(DeepSeekOpenAICompatibleProvider);
        expect(result.messages?.[0]).toEqual(expectedMessage);
        expect(originalRequest.messages[0]).toEqual(expectedMessage);
      },
    );

    const globCall = () => ({
      id: 'call_1',
      type: 'function',
      function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
    });

    /** Builds a deepseek-v4-flash request and returns its second message. */
    const secondMessage = (messages: unknown[]) =>
      provider.buildRequest(
        {
          model: 'deepseek-v4-flash',
          messages,
        } as OpenAI.Chat.ChatCompletionCreateParams,
        userPromptId,
      ).messages?.[1] as { role: string; reasoning_content?: string };

    // https://github.com/QwenLM/qwen-code/issues/3695 — DeepSeek's thinking
    // mode rejects subsequent requests when any prior assistant turn omits
    // reasoning_content, even if the model itself returned no reasoning text.
    // The provider must always send the field.
    it('injects empty reasoning_content on tool-calling assistant turns missing it', () => {
      const assistant = secondMessage([
        { role: 'user', content: 'list markdown files' },
        { role: 'assistant', content: null, tool_calls: [globCall()] },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'Found 2 matching file(s)',
        },
      ]);

      expect(assistant.role).toBe('assistant');
      expect(assistant.reasoning_content).toBe('');
    });

    it('preserves existing reasoning_content on tool-calling assistant turns', () => {
      const assistant = secondMessage([
        { role: 'user', content: 'list markdown files' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Let me glob first.',
          tool_calls: [globCall()],
        },
      ]);

      expect(assistant.reasoning_content).toBe('Let me glob first.');
    });

    it('injects empty reasoning_content on assistant turns without tool_calls', () => {
      const assistant = secondMessage([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);

      expect(assistant.reasoning_content).toBe('');
    });

    // https://api-docs.deepseek.com/zh-cn/api/create-chat-completion —
    // DeepSeek expects a flat `reasoning_effort` body parameter (high/max);
    // the standard `reasoning: { effort }` shape from the OpenAI pipeline
    // would otherwise be ignored.
    it('translates `reasoning.effort` into top-level `reasoning_effort`', () => {
      const r = buildHi({ reasoning: { effort: 'max' } });

      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toBeUndefined();
    });

    it('passes through `reasoning_effort: high` unchanged', () => {
      const r = buildHi({ reasoning: { effort: 'high' } });

      expect(r['reasoning_effort']).toBe('high');
      expect(r['reasoning']).toBeUndefined();
    });

    it("maps backward-compat 'xhigh' effort to 'max' (DeepSeek doc behavior)", () => {
      const r = buildHi({ reasoning: { effort: 'xhigh' } });

      expect(r['reasoning_effort']).toBe('max');
    });

    it('maps backward-compat `low`/`medium` effort to `high` (DeepSeek doc behavior)', () => {
      for (const effort of ['low', 'medium'] as const) {
        const r = buildHi({ reasoning: { effort } });
        expect(r['reasoning_effort']).toBe('high');
      }
    });

    it('preserves an explicitly set top-level `reasoning_effort` (no clobber)', () => {
      const r = buildHi({
        reasoning_effort: 'max',
        reasoning: { effort: 'high' },
      });

      // Top-level value wins; nested shape is stripped to avoid sending both.
      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toBeUndefined();
    });

    it('keeps the rest of the `reasoning` object when only `effort` is stripped', () => {
      const r = buildHi({
        reasoning: { effort: 'max', budget_tokens: 50_000 },
      });

      expect(r['reasoning_effort']).toBe('max');
      expect(r['reasoning']).toEqual({ budget_tokens: 50_000 });
    });

    it('leaves a request without `reasoning.effort` untouched', () => {
      const r = buildHi({});

      expect(r['reasoning_effort']).toBeUndefined();
      expect(r['reasoning']).toBeUndefined();
    });

    it('does NOT translate reasoning_effort on a non-DeepSeek hostname (model-name fallback only)', () => {
      // The provider class is selected by `isDeepSeekProvider`, which matches
      // the broader hostname-OR-model rule (covers sglang/vllm self-hosting
      // DeepSeek models). But the DeepSeek-specific `reasoning_effort` body
      // shape only ships on actual DeepSeek hostnames; otherwise a strict
      // OpenAI-compat backend would see an unexpected request shape change.
      // Content flattening still runs (a model-format constraint, not a
      // wire-shape one).
      const selfHostedProvider = providerFor(
        'https://my-sglang.example.com:8000/v1',
        'deepseek-v4-pro',
      );

      const originalRequest = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        reasoning: { effort: 'max' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = selfHostedProvider.buildRequest(
        originalRequest,
        userPromptId,
      );
      const r = result as unknown as Record<string, unknown>;

      // reasoning_effort NOT injected. The nested object still ships, but the
      // tier is capped to the generic ceiling: the same hostname rule that
      // withholds DeepSeek's wire shape also withholds DeepSeek's ladder, so
      // an unverified backend never receives a `max` it may reject.
      expect(r['reasoning_effort']).toBeUndefined();
      expect(r['reasoning']).toEqual({ effort: 'xhigh' });
      // Content flattening still ran.
      expect((result.messages?.[0] as { content: unknown }).content).toBe('hi');
    });
  });

  describe('isDeepSeekHostname', () => {
    const isHost = (config: Partial<ContentGeneratorConfig>) =>
      DeepSeekOpenAICompatibleProvider.isDeepSeekHostname(
        config as ContentGeneratorConfig,
      );

    it('matches api.deepseek.com baseUrls', () => {
      expect(isHost({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    });

    it('does NOT match a self-hosted host even when model name is deepseek', () => {
      expect(
        isHost({
          baseUrl: 'https://my-sglang.example.com:8000/v1',
          model: 'deepseek-v4-pro',
        }),
      ).toBe(false);
    });

    it('matches subdomains of api.deepseek.com', () => {
      expect(isHost({ baseUrl: 'https://us.api.deepseek.com/v1' })).toBe(true);
    });

    it('rejects hostile hostnames that contain api.deepseek.com as a substring', () => {
      // Naive substring matching would let an attacker route requests
      // through e.g. `api.deepseek.com.evil.com` and inject the
      // DeepSeek-only `reasoning_effort` body parameter into a non-DeepSeek
      // backend. Parse with `new URL` and match the hostname exactly.
      for (const baseUrl of [
        'https://api.deepseek.com.evil.com/v1',
        'https://evil.com/api.deepseek.com/v1',
        'https://api.deepseek.comevil.com/v1',
        'https://api-deepseek-com.example.com/v1',
      ]) {
        expect(isHost({ baseUrl })).toBe(false);
      }
    });

    it('treats invalid URLs as non-DeepSeek', () => {
      expect(isHost({ baseUrl: 'not-a-url' })).toBe(false);
      expect(isHost({ baseUrl: '' })).toBe(false);
    });
  });

  describe('getDefaultGenerationConfig', () => {
    it('does not force a deterministic temperature by default', () => {
      expect(provider.getDefaultGenerationConfig()).toEqual({});
    });
  });
});
