/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shouldKeepCompactedItem,
  processCompactedOutput,
  compactedItemsToContents,
  ResponsesCompactionClient,
} from './responsesCompactionClient.js';
import { COMPACTION_SUMMARY_PREFIX } from '../core/prompts.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';

describe('responsesCompactionClient', () => {
  describe('shouldKeepCompactedItem', () => {
    it('should keep compaction items', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'compaction',
          encrypted_content: 'abc123',
        }),
      ).toBe(true);
    });

    it('should keep user messages', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'message',
          role: 'user',
          content: 'hello',
        }),
      ).toBe(true);
    });

    it('should keep assistant messages', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'message',
          role: 'assistant',
          content: 'hi there',
        }),
      ).toBe(true);
    });

    it('should drop developer messages', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'message',
          role: 'developer',
          content: 'system prompt',
        }),
      ).toBe(false);
    });

    it('should drop function_call items', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'function_call',
          name: 'read_file',
        }),
      ).toBe(false);
    });

    it('should drop function_call_output items', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'function_call_output',
          call_id: 'call_1',
        }),
      ).toBe(false);
    });

    it('should return false for unknown item types', () => {
      expect(
        shouldKeepCompactedItem({
          type: 'reasoning',
          content: 'thinking...',
        }),
      ).toBe(false);
      expect(
        shouldKeepCompactedItem({
          type: 'image_generation',
          url: 'https://example.com/img.png',
        }),
      ).toBe(false);
    });
  });

  describe('processCompactedOutput', () => {
    it('should return empty array for empty input', () => {
      const filtered = processCompactedOutput([]);
      expect(filtered).toHaveLength(0);
      expect(filtered).toEqual([]);
    });

    it('should filter output correctly', () => {
      const output = [
        { type: 'message', role: 'developer', content: 'instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'function_call', name: 'read_file' },
        { type: 'function_call_output', call_id: 'c1' },
        { type: 'message', role: 'assistant', content: 'response' },
        { type: 'compaction', encrypted_content: 'enc123' },
      ];
      const filtered = processCompactedOutput(output);
      expect(filtered).toHaveLength(3);
      expect(filtered[0]!.role).toBe('user');
      expect(filtered[1]!.role).toBe('assistant');
      expect(filtered[2]!.type).toBe('compaction');
    });
  });

  describe('compactedItemsToContents', () => {
    it('should convert user messages to Content[]', () => {
      const items = [
        { type: 'message', role: 'user', content: 'hello world' },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
      expect(contents[0]!.parts?.[0]).toEqual({ text: 'hello world' });
    });

    it('should convert assistant messages with model role', () => {
      const items = [
        { type: 'message', role: 'assistant', content: 'I can help' },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents[0]!.role).toBe('model');
      expect(contents[0]!.parts?.[0]).toEqual({ text: 'I can help' });
    });

    it('should convert array content parts', () => {
      const items = [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'part 1' },
            { type: 'output_text', text: 'part 2' },
          ],
        },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents[0]!.parts?.[0]).toEqual({ text: 'part 1part 2' });
    });

    it('should preserve compaction items with summary prefix', () => {
      const item = {
        type: 'compaction',
        encrypted_content: 'enc_abc123',
      };
      const contents = compactedItemsToContents([item]);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
      const text = (contents[0]!.parts?.[0] as { text: string }).text;
      expect(text).toContain(COMPACTION_SUMMARY_PREFIX);
      expect(text).toContain('enc_abc123');
    });

    it('should ignore input_text type parts and keep text type parts', () => {
      const items = [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'input_text', text: 'ignored input' },
            { type: 'text', text: 'kept text' },
          ],
        },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.parts?.[0]).toEqual({ text: 'kept text' });
    });

    it('should return empty for message with only input_text parts', () => {
      const items = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'only input' }],
        },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents).toHaveLength(0);
    });

    it('should return empty array for empty content array', () => {
      const contents = compactedItemsToContents([]);
      expect(contents).toHaveLength(0);
      expect(contents).toEqual([]);
    });

    it('should skip empty text messages', () => {
      const items = [
        { type: 'message', role: 'user', content: '' },
        { type: 'message', role: 'user', content: 'real message' },
      ];
      const contents = compactedItemsToContents(items);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.parts?.[0]).toEqual({ text: 'real message' });
    });
  });

  describe('ResponsesCompactionClient', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('should send correct request body', async () => {
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [
              { type: 'message', role: 'user', content: 'compacted' },
            ],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      const history = [
        { role: 'user' as const, parts: [{ text: 'hello' }] },
        { role: 'model' as const, parts: [{ text: 'hi' }] },
      ];

      const result = await client.compact(history);

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      expect(url).toBe('https://api.test.com/v1/responses/compact');
      expect((opts as RequestInit).method).toBe('POST');

      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.model).toBe('codex-mini');
      expect(body.input).toBeDefined();
      expect(body.parallel_tool_calls).toBe(true);

      expect(result.compactedHistory).toHaveLength(1);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(20);
    });

    it('should include reasoning and include fields when reasoning config is set', async () => {
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [{ type: 'message', role: 'user', content: 'ok' }],
            usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
        reasoning: { effort: 'medium' as const, summary: 'auto' as const },
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]);

      const body = JSON.parse(
        (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit)
          .body as string,
      );
      expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      expect(body.include).toEqual(['reasoning.encrypted_content']);
    });

    it('should include text.verbosity when verbosity config is set', async () => {
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [{ type: 'message', role: 'user', content: 'ok' }],
            usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
        verbosity: 'low' as const,
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]);

      const body = JSON.parse(
        (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit)
          .body as string,
      );
      expect(body.text).toEqual({ verbosity: 'low' });
    });

    it('should always include truncation auto in request body', async () => {
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]);

      const body = JSON.parse(
        (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit)
          .body as string,
      );
      expect(body.truncation).toEqual({ type: 'auto' });
    });

    it('should use API key from env variable via apiKeyEnvKey', async () => {
      const origEnv = process.env['TEST_COMPACTION_KEY'];
      process.env['TEST_COMPACTION_KEY'] = 'env-secret-key';

      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKeyEnvKey: 'TEST_COMPACTION_KEY',
        baseUrl: 'https://api.test.com',
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]);

      const headers = (
        vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      ).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer env-secret-key');

      if (origEnv === undefined) {
        delete process.env['TEST_COMPACTION_KEY'];
      } else {
        process.env['TEST_COMPACTION_KEY'] = origEnv;
      }
    });

    it('should include custom headers in request', async () => {
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
        customHeaders: { 'X-Custom-Header': 'custom-value' },
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]);

      const headers = (
        vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      ).headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('custom-value');
      expect(headers['Authorization']).toBe('Bearer test-key');
    });

    it('should throw on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      } as unknown as Response);

      const config = {
        model: 'codex-mini',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
      } as ContentGeneratorConfig;

      const client = new ResponsesCompactionClient(config);
      await expect(
        client.compact([{ role: 'user', parts: [{ text: 'hi' }] }]),
      ).rejects.toThrow('Responses compact error 500');
    });
  });
});
