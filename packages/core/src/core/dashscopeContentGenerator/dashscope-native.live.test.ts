/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live smoke test for the native DashScope provider against qwen3.8-max.
 * Skipped by default; runs only when `QWEN_CODE_RUN_LIVE_TESTS=1` and
 * `DASHSCOPE_API_KEY` are set in the environment:
 *
 *   cd packages/core && QWEN_CODE_RUN_LIVE_TESTS=1 npx vitest run \
 *     src/core/dashscopeContentGenerator/dashscope-native.live.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { FinishReason } from '@google/genai';
import { preloadRuntimeFetchModule } from '../../utils/runtimeFetchOptions.js';
import { createDashScopeContentGenerator } from './index.js';
import {
  createDashScopeGeneratorConfig,
  createFakeCliConfig,
} from './test-utils.js';

const apiKey = process.env['DASHSCOPE_API_KEY'];
const runLiveTests =
  process.env['QWEN_CODE_RUN_LIVE_TESTS'] === '1' && Boolean(apiKey);
const baseUrl = process.env['DASHSCOPE_BASE_URL'];
const MODEL = 'qwen3.8-max';
const TIMEOUT_MS = 90_000;

function buildGenerator() {
  return createDashScopeContentGenerator(
    createDashScopeGeneratorConfig({
      apiKey: apiKey ?? '',
      model: MODEL,
      ...(baseUrl ? { baseUrl } : {}),
    }),
    createFakeCliConfig(),
  );
}

async function collectStream(
  stream: AsyncGenerator<GenerateContentResponse>,
): Promise<GenerateContentResponse[]> {
  const chunks: GenerateContentResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe.skipIf(!runLiveTests)('DashScope native (live)', () => {
  beforeAll(async () => {
    await preloadRuntimeFetchModule();
  });

  it(
    'non-streaming text with thinking off returns text and usage',
    async () => {
      const generator = buildGenerator();
      const response = await generator.generateContent(
        {
          model: MODEL,
          contents: [
            { role: 'user', parts: [{ text: 'Say the single word OK.' }] },
          ],
          config: { thinkingConfig: { includeThoughts: false } },
        },
        'live-prompt-1',
      );

      const text = response.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('');
      expect(text?.length ?? 0).toBeGreaterThan(0);
      expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(response.usageMetadata?.promptTokenCount ?? 0).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'streaming with reasoning on emits a thought part before the first text part, usage once on the last chunk',
    async () => {
      const generator = buildGenerator();
      const stream = await generator.generateContentStream(
        {
          model: MODEL,
          contents: [
            {
              role: 'user',
              parts: [{ text: 'What is 2 + 2? Answer in one short sentence.' }],
            },
          ],
          config: { thinkingConfig: { includeThoughts: true } },
        },
        'live-prompt-2',
      );
      const chunks = await collectStream(stream);

      const firstThoughtIndex = chunks.findIndex((chunk) =>
        chunk.candidates?.[0]?.content?.parts?.some((part) => part.thought),
      );
      const firstTextIndex = chunks.findIndex((chunk) =>
        chunk.candidates?.[0]?.content?.parts?.some(
          (part) => part.text && !part.thought,
        ),
      );
      expect(firstThoughtIndex).toBeGreaterThanOrEqual(0);
      expect(firstThoughtIndex).toBeLessThan(firstTextIndex);

      const usageChunks = chunks.filter((chunk) => chunk.usageMetadata);
      expect(usageChunks).toHaveLength(1);
      expect(usageChunks[0]).toBe(chunks[chunks.length - 1]);
      expect(
        usageChunks[0].usageMetadata?.thoughtsTokenCount ?? 0,
      ).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'streaming tool calls for two cities round-trip through a second turn',
    async () => {
      const generator = buildGenerator();
      const tool = {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city.',
            parametersJsonSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      };

      const firstTurn = {
        model: MODEL,
        contents: [
          {
            role: 'user' as const,
            parts: [
              {
                text: 'Call get_weather for Paris AND Tokyo, one call per city.',
              },
            ],
          },
        ],
        config: { tools: [tool] },
      };

      const stream = await generator.generateContentStream(
        firstTurn,
        'live-prompt-3',
      );
      const chunks = await collectStream(stream);
      const functionCallParts = chunks.flatMap(
        (chunk) =>
          chunk.candidates?.[0]?.content?.parts?.filter(
            (part) => part.functionCall,
          ) ?? [],
      );
      expect(functionCallParts.length).toBe(2);
      const ids = functionCallParts.map((part) => part.functionCall?.id);
      expect(new Set(ids).size).toBe(2);
      const cities = functionCallParts.map(
        (part) => (part.functionCall?.args as { city?: string })?.city,
      );
      expect(cities.sort()).toEqual(['Paris', 'Tokyo']);

      const secondTurn = await generator.generateContent(
        {
          model: MODEL,
          contents: [
            ...firstTurn.contents,
            {
              role: 'model' as const,
              parts: functionCallParts,
            },
            {
              role: 'user' as const,
              parts: functionCallParts.map((part) => ({
                functionResponse: {
                  id: part.functionCall?.id,
                  name: part.functionCall?.name,
                  response: { output: '22C sunny' },
                },
              })),
            },
          ],
          config: { tools: [tool] },
        },
        'live-prompt-3b',
      );
      const finalText = secondTurn.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('');
      expect(finalText?.length ?? 0).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'explicit cache: a large shared systemInstruction is a cache miss then a cache hit',
    async () => {
      const generator = buildGenerator();
      // Explicit caching silently no-ops below the server's ~1024-token
      // minimum prefix length (api-contract.md §7) — repeat enough to clear
      // ~1500+ tokens with margin, matching the live-verified capture. A
      // per-run nonce keeps this prefix unique so a prior run's 5-minute
      // cache entry (or a stray manual probe against the same base text)
      // can't produce a false cache hit on the supposedly-cold first turn.
      const systemInstruction =
        `Session nonce: ${Date.now()}-${Math.random()}. ` +
        'You are a helpful assistant. '.repeat(260) +
        'Always answer concisely.';

      const firstTurn = await generator.generateContent(
        {
          model: MODEL,
          contents: [
            {
              role: 'user',
              parts: [{ text: 'What is the capital of France?' }],
            },
          ],
          config: {
            systemInstruction,
            thinkingConfig: { includeThoughts: false },
          },
        },
        'live-prompt-4a',
      );
      expect(firstTurn.usageMetadata?.cachedContentTokenCount ?? 0).toBe(0);

      const secondTurn = await generator.generateContent(
        {
          model: MODEL,
          contents: [
            {
              role: 'user',
              parts: [{ text: 'What is the capital of Japan?' }],
            },
          ],
          config: {
            systemInstruction,
            thinkingConfig: { includeThoughts: false },
          },
        },
        'live-prompt-4b',
      );
      expect(
        secondTurn.usageMetadata?.cachedContentTokenCount ?? 0,
      ).toBeGreaterThan(1000);
    },
    TIMEOUT_MS,
  );
});
