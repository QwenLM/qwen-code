/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pipeline } from '../../../pipeline/pipeline.js';
import type { CustomRequest } from '../../../request/customRequest.js';
import { CustomInferenceGeminiApiImpl } from './gemini.js';
import { CustomProviderConfig } from '../../../../provider/impl/customProviderConfig.js';
import { GOOGLE_GEMINI } from '../../../../provider/transport/modelProtocol.js';
import { INFERENCE } from '../../../endpoint/endpointType.js';

describe('CustomInferenceGeminiApiImpl', () => {
  it('streams generateContent with alt=sse and strips the models/ prefix', async () => {
    let captured: CustomRequest | undefined;
    const execute = vi.fn(async (request: CustomRequest) => {
      captured = request;
      return {
        raw: new Response(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'hi' }] } }],
          })}\n\n`,
          { status: 200 },
        ),
      };
    });
    const api = new CustomInferenceGeminiApiImpl({ execute } as unknown as Pipeline);

    const frames: unknown[] = [];
    for await (const frame of api.stream({
      model: 'models/gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      config: {
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        systemInstruction: { role: 'user', parts: [{ text: 'sys' }] },
        tools: [{ functionDeclarations: [] }],
        httpOptions: { timeout: 1 },
      },
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
    ]);
    expect(captured?.url).toBe(
      '/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(JSON.parse(String(captured?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { role: 'user', parts: [{ text: 'sys' }] },
      tools: [{ functionDeclarations: [] }],
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      },
    });
  });
});

describe('Gemini base URL normalization', () => {
  it.each([
    [
      'https://generativelanguage.googleapis.com',
      'https://generativelanguage.googleapis.com/v1beta',
    ],
    [
      'https://generativelanguage.googleapis.com/',
      'https://generativelanguage.googleapis.com/v1beta',
    ],
    [
      'https://generativelanguage.googleapis.com/v1beta',
      'https://generativelanguage.googleapis.com/v1beta',
    ],
    [
      'https://generativelanguage.googleapis.com/v1',
      'https://generativelanguage.googleapis.com/v1',
    ],
    [
      'https://proxy.example.com/gemini',
      'https://proxy.example.com/gemini/v1beta',
    ],
  ])('normalizes %s', async (baseUrl, expected) => {
    const provider = new CustomProviderConfig({
      providerId: 'gemini',
      baseUrl,
      apiKey: 'key-1',
      authType: 'google-api-key',
      models: [],
      protocol: GOOGLE_GEMINI,
    });
    const resolved = await provider.resolve(INFERENCE);
    expect(resolved?.origin).toBe(expected);
  });
});

describe('Gemini API key auth', () => {
  it('uses x-goog-api-key for google-api-key providers', () => {
    const provider = new CustomProviderConfig({
      providerId: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key-1',
      authType: 'google-api-key',
      models: [],
      protocol: GOOGLE_GEMINI,
    });
    expect(provider.getApiKey()).toBe('key-1');
    expect(provider.getApiKeyHeader()).toBe('x-goog-api-key');
    expect(provider.getBearer()).toBeUndefined();
  });
});
