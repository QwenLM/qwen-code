/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type OpenAI from 'openai';
import type { Config } from '../config/config.js';
import { LlmChat } from './llm-chat.js';
import { convertLlmRequestToOpenAI } from './openaiContentGenerator/converter.js';
import { DashScopeOpenAICompatibleProvider } from './openaiContentGenerator/provider/dashscope.js';

const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=';
const model = 'qwen3.7-plus';

function toolRound(id: string): Content[] {
  return [
    {
      role: 'model',
      parts: [{ functionCall: { id, name: 'fixture_tool', args: {} } }],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name: 'fixture_tool',
            response: { output: id },
          },
        },
      ],
    },
  ];
}

function flatten(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
  return messages.flatMap((message, messageIndex) => {
    const { content, ...envelope } = message;
    const parts = Array.isArray(content)
      ? content
      : [{ type: 'text', text: content }];
    return parts.map((part, partIndex) => {
      const { cache_control: cacheControl, ...payload } =
        part as typeof part & {
          cache_control?: { type: string };
        };
      return {
        messageIndex,
        partIndex,
        role: message.role,
        type: part.type,
        marked: Boolean(cacheControl),
        value: JSON.stringify({ envelope, payload }),
      };
    });
  });
}

describe('issue #11627: reusable conversation cache prefix', () => {
  for (const ending of ['model', 'tool-result', 'user-text'] as const) {
    for (const withImage of [false, true]) {
      it(`${ending} ending, image=${withImage}: retains a matching conversation breakpoint`, () => {
        const history: Content[] = [
          {
            role: 'user',
            parts: withImage
              ? [{ inlineData: { mimeType: 'image/png', data: imageData } }]
              : [{ text: 'synthetic text fixture' }],
          },
          { role: 'model', parts: [{ text: 'fixture inspected' }] },
        ];
        if (ending === 'tool-result') history.push(...toolRound('round-0'));
        if (ending === 'user-text')
          history.push({ role: 'user', parts: [{ text: 'continue fixture' }] });
        const config = {
          getChatCompression: () => ({
            imagePayloadThreshold: 1,
            maxRecentImagesToRetain: 1,
          }),
          getContentGeneratorConfig: () => ({ enableCacheControl: true }),
          getSessionId: () => 'isolated-issue-11627',
        } as unknown as Config;
        const chat = new LlmChat(config, {}, history);
        const provider = new DashScopeOpenAICompatibleProvider(
          { model, apiKey: 'sk-mock', baseUrl: 'http://127.0.0.1:8765/v1' },
          config,
        );
        const makeRequest = () => {
          // Exercise the actual private request builder without starting a
          // session, loading user config, or constructing an API client.
          const contents = chat['getRequestHistoryForRoute'](undefined, {
            image: true,
          });
          const messages = convertLlmRequestToOpenAI(
            {
              model,
              contents,
              config: { systemInstruction: 'isolated fixture' },
            },
            { model, modalities: { image: true }, startTime: 0 },
          );
          return {
            contents: structuredClone(contents),
            request: provider.buildRequest(
              {
                model,
                messages,
                stream: true,
                tools: [
                  {
                    type: 'function',
                    function: {
                      name: 'fixture_tool',
                      parameters: { type: 'object', properties: {} },
                    },
                  },
                ],
              },
              'fixture-prompt',
            ),
          };
        };
        const first = makeRequest();
        const stableHistory = structuredClone(history);
        if (ending === 'model')
          history.push({ role: 'user', parts: [{ text: 'continue fixture' }] });
        history.push(...toolRound('round-1'));
        if (ending === 'model')
          history.push({ role: 'model', parts: [{ text: 'round completed' }] });
        const second = makeRequest();
        expect(history.slice(0, stableHistory.length)).toEqual(stableHistory);
        expect(second.request.tools).toEqual(first.request.tools);
        if (withImage) {
          for (const snapshot of [first, second]) {
            const blocks = flatten(snapshot.request.messages);
            const imageBlock = blocks.find(
              (block) => block.type === 'image_url',
            );
            expect(imageBlock).toBeDefined();
            for (const boundary of blocks.filter((block) => block.marked)) {
              expect(boundary.messageIndex).toBeLessThan(
                imageBlock!.messageIndex,
              );
            }
            const images = snapshot.contents
              .flatMap((entry) => entry.parts ?? [])
              .filter((part) => part.inlineData);
            expect(images).toHaveLength(1);
            expect(images[0].inlineData?.data).toBe(imageData);
            const wireImages = snapshot.request.messages.flatMap((message) =>
              Array.isArray(message.content)
                ? message.content.filter((part) => part.type === 'image_url')
                : [],
            );
            expect(wireImages).toHaveLength(1);
            expect(wireImages[0]).toEqual({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageData}` },
            });
          }
          expect(
            history
              .flatMap((entry) => entry.parts ?? [])
              .some((part) => part.inlineData),
          ).toBe(false);
          expect(first.contents).toHaveLength(
            stableHistory.length + (ending === 'model' ? 1 : 0),
          );
        }
        const firstBlocks = flatten(first.request.messages);
        const secondBlocks = flatten(second.request.messages);
        let commonBlocks = 0;
        while (
          commonBlocks < firstBlocks.length &&
          firstBlocks[commonBlocks].value === secondBlocks[commonBlocks]?.value
        )
          commonBlocks++;
        const boundaries = firstBlocks
          .map((block, index) => ({ ...block, index }))
          .filter((block) => block.marked && block.role !== 'system');
        expect(boundaries).toHaveLength(1);
        expect(
          boundaries[0].index,
          'previous conversation breakpoint must lie inside the unchanged request prefix',
        ).toBeLessThan(commonBlocks);
        expect(boundaries[0].type).toBe('text');
      });
    }
  }
});
