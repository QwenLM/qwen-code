/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import type { Config } from '../config/config.js';
import { runSideQuery } from './sideQuery.js';

describe('runSideQuery', () => {
  let mockBaseLlmClient: BaseLlmClient;
  let mockConfig: Config;
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
    mockBaseLlmClient = {
      generateJson: vi.fn(),
      generateText: vi.fn(),
    } as unknown as BaseLlmClient;
    mockConfig = {
      getBaseLlmClient: vi.fn().mockReturnValue(mockBaseLlmClient),
      getModel: vi.fn().mockReturnValue('main-model'),
      getFastModel: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
  });

  describe('JSON mode (schema present)', () => {
    it('routes through BaseLlmClient.generateJson with default policy', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
        decision: 'user',
      });

      const result = await runSideQuery<{ decision: string }>(mockConfig, {
        purpose: 'next-speaker',
        contents: [{ role: 'user', parts: [{ text: 'Who speaks next?' }] }],
        schema: {
          type: 'object',
          properties: { decision: { type: 'string' } },
          required: ['decision'],
        },
        abortSignal: abortController.signal,
      });

      expect(result).toEqual({ decision: 'user' });
      expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'main-model',
          promptId: 'side-query:next-speaker',
          abortSignal: abortController.signal,
          config: expect.objectContaining({
            thinkingConfig: { includeThoughts: false },
          }),
        }),
      );
    });

    it('prefers fastModel when available', async () => {
      vi.mocked(mockConfig.getFastModel).mockReturnValue('fast-model');
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({ ok: true });

      await runSideQuery<{ ok: boolean }>(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        abortSignal: abortController.signal,
      });

      expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'fast-model' }),
      );
    });

    it('explicit model override beats fastModel', async () => {
      vi.mocked(mockConfig.getFastModel).mockReturnValue('fast-model');
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({ ok: true });

      await runSideQuery<{ ok: boolean }>(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        abortSignal: abortController.signal,
        model: 'override-model',
      });

      expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'override-model' }),
      );
    });

    it('explicit thinkingConfig overrides the helper default', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({ ok: true });

      await runSideQuery<{ ok: boolean }>(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        abortSignal: abortController.signal,
        config: { thinkingConfig: { includeThoughts: true } },
      });

      expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            thinkingConfig: { includeThoughts: true },
          }),
        }),
      );
    });

    it('preserves caller-supplied promptId when provided', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({ ok: true });

      await runSideQuery<{ ok: boolean }>(mockConfig, {
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        abortSignal: abortController.signal,
        promptId: 'legacy-id',
      });

      expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({ promptId: 'legacy-id' }),
      );
    });

    it('throws when the response does not satisfy the schema', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
        status: 'ok',
      });

      await expect(
        runSideQuery<{ status: string; decision: string }>(mockConfig, {
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              decision: { type: 'string' },
            },
            required: ['status', 'decision'],
          },
          abortSignal: abortController.signal,
        }),
      ).rejects.toThrow('Invalid side query response:');
    });

    it('throws when custom validation fails', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
        status: '',
      });

      await expect(
        runSideQuery<{ status: string }>(mockConfig, {
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          schema: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
          abortSignal: abortController.signal,
          validate: (response) =>
            response.status.trim().length === 0
              ? 'Status must be non-empty'
              : null,
        }),
      ).rejects.toThrow('Status must be non-empty');
    });

    it('forwards maxAttempts when provided, omits it otherwise', async () => {
      vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({ ok: true });
      const baseOptions = {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        abortSignal: abortController.signal,
      };

      await runSideQuery<{ ok: boolean }>(mockConfig, {
        ...baseOptions,
        maxAttempts: 1,
      });
      expect(mockBaseLlmClient.generateJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxAttempts: 1 }),
      );

      await runSideQuery<{ ok: boolean }>(mockConfig, baseOptions);
      const lastCall = vi
        .mocked(mockBaseLlmClient.generateJson)
        .mock.calls.at(-1)?.[0];
      expect(lastCall).toBeDefined();
      expect(lastCall as object).not.toHaveProperty('maxAttempts');
    });

    it('propagates rejections from generateJson', async () => {
      const apiError = new Error('upstream 503');
      vi.mocked(mockBaseLlmClient.generateJson).mockRejectedValue(apiError);

      await expect(
        runSideQuery<{ ok: boolean }>(mockConfig, {
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          abortSignal: abortController.signal,
        }),
      ).rejects.toBe(apiError);
    });
  });

  describe('text mode (no schema)', () => {
    function mockTextResult(text: string, withUsage = true) {
      vi.mocked(mockBaseLlmClient.generateText).mockResolvedValue({
        text,
        usage: withUsage
          ? {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            }
          : undefined,
      });
    }

    it('routes through BaseLlmClient.generateText and returns { text, usage }', async () => {
      mockTextResult('hello world');

      const result = await runSideQuery(mockConfig, {
        purpose: 'session-recap',
        contents: [{ role: 'user', parts: [{ text: 'recap please' }] }],
        systemInstruction: 'You are a recap generator.',
        abortSignal: abortController.signal,
      });

      expect(result).toEqual({
        text: 'hello world',
        usage: expect.objectContaining({ totalTokenCount: 15 }),
      });
      expect(mockBaseLlmClient.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [{ role: 'user', parts: [{ text: 'recap please' }] }],
          model: 'main-model',
          systemInstruction: 'You are a recap generator.',
          abortSignal: abortController.signal,
          promptId: 'side-query:session-recap',
          config: expect.objectContaining({
            thinkingConfig: { includeThoughts: false },
          }),
        }),
      );
    });

    it('prefers fastModel when available', async () => {
      vi.mocked(mockConfig.getFastModel).mockReturnValue('fast-model');
      mockTextResult('ok');

      await runSideQuery(mockConfig, {
        purpose: 'recap',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
      });

      expect(mockBaseLlmClient.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'fast-model' }),
      );
    });

    it('exposes usageMetadata even when undefined', async () => {
      mockTextResult('no usage', false);

      const result = await runSideQuery(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
      });

      expect(result.usage).toBeUndefined();
    });

    it('passes validate the text and throws on failure', async () => {
      mockTextResult('too short');

      const validate = vi.fn((text: string): string | null =>
        text.length < 20 ? 'too short' : null,
      );

      await expect(
        runSideQuery(mockConfig, {
          purpose: 'p',
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          abortSignal: abortController.signal,
          validate,
        }),
      ).rejects.toThrow('too short');
      expect(validate).toHaveBeenCalledWith('too short');
    });

    it('explicit thinkingConfig.includeThoughts:true overrides default', async () => {
      mockTextResult('reasoning enabled');

      await runSideQuery(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
        config: { thinkingConfig: { includeThoughts: true } },
      });

      expect(mockBaseLlmClient.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            thinkingConfig: { includeThoughts: true },
          }),
        }),
      );
    });

    it('passes systemInstruction through unchanged (no main-prompt fallback)', async () => {
      mockTextResult('ok');

      await runSideQuery(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
        systemInstruction: 'custom side query prompt',
      });

      expect(mockBaseLlmClient.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: 'custom side query prompt',
        }),
      );
    });

    it('omits systemInstruction when caller does not provide one', async () => {
      mockTextResult('ok');

      await runSideQuery(mockConfig, {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
      });

      const callArg = vi.mocked(mockBaseLlmClient.generateText).mock
        .calls[0][0];
      expect(callArg.systemInstruction).toBeUndefined();
    });

    it('forwards maxAttempts when provided, omits it otherwise', async () => {
      mockTextResult('ok');
      const baseOptions = {
        purpose: 'p',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        abortSignal: abortController.signal,
      };

      await runSideQuery(mockConfig, { ...baseOptions, maxAttempts: 1 });
      expect(mockBaseLlmClient.generateText).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxAttempts: 1 }),
      );

      await runSideQuery(mockConfig, baseOptions);
      const lastCall = vi
        .mocked(mockBaseLlmClient.generateText)
        .mock.calls.at(-1)?.[0];
      expect(lastCall).toBeDefined();
      expect(lastCall as object).not.toHaveProperty('maxAttempts');
    });

    it('propagates rejections from generateText', async () => {
      const apiError = new Error('upstream 503');
      vi.mocked(mockBaseLlmClient.generateText).mockRejectedValue(apiError);

      await expect(
        runSideQuery(mockConfig, {
          purpose: 'p',
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          abortSignal: abortController.signal,
        }),
      ).rejects.toBe(apiError);
    });
  });
});
