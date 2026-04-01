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
    } as unknown as BaseLlmClient;
    mockConfig = {
      getBaseLlmClient: vi.fn().mockReturnValue(mockBaseLlmClient),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    } as unknown as Config;
  });

  it('should call BaseLlmClient.generateJson with side-query defaults', async () => {
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      decision: 'user',
    });

    const result = await runSideQuery<{ decision: string }>(mockConfig, {
      purpose: 'next-speaker',
      contents: [{ role: 'user', parts: [{ text: 'Who speaks next?' }] }],
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
        },
        required: ['decision'],
      },
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({ decision: 'user' });
    expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen3-coder-plus',
        promptId: 'side-query:next-speaker',
        abortSignal: abortController.signal,
      }),
    );
  });

  it('should allow overriding model, promptId, systemInstruction, and config', async () => {
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      status: 'ok',
    });

    await runSideQuery<{ status: string }>(mockConfig, {
      contents: [{ role: 'user', parts: [{ text: 'Check status' }] }],
      schema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
      abortSignal: abortController.signal,
      model: 'custom-model',
      promptId: 'custom-prompt-id',
      systemInstruction: 'You are a validator.',
      config: { temperature: 0.1 },
    });

    expect(mockBaseLlmClient.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-model',
        promptId: 'custom-prompt-id',
        systemInstruction: 'You are a validator.',
        config: { temperature: 0.1 },
      }),
    );
  });

  it('should throw when the response does not satisfy the schema', async () => {
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      status: 'ok',
    });

    await expect(
      runSideQuery<{ status: string; decision: string }>(mockConfig, {
        contents: [{ role: 'user', parts: [{ text: 'Check schema' }] }],
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

  it('should throw when custom validation fails', async () => {
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      status: '',
    });

    await expect(
      runSideQuery<{ status: string }>(mockConfig, {
        contents: [{ role: 'user', parts: [{ text: 'Validate me' }] }],
        schema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
        abortSignal: abortController.signal,
        validate: (response) =>
          response.status.trim().length === 0 ? 'Status must be non-empty' : null,
      }),
    ).rejects.toThrow('Status must be non-empty');
  });
});
