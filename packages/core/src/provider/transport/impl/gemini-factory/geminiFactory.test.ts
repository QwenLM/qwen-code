/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { FinishReason, type GenerateContentResponse } from '@google/genai';
import type { Model, ModelConfig } from '../../../model/model.js';
import type {
  ModelPrompt,
  ModelStreamRequest,
} from '../../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../../event/modelStreamEvent.js';
import { buildGeminiStreamReq } from './request/geminiStreamReqFactory.js';
import { buildGeminiStreamEvents } from './response/geminiStreamRespFactory.js';

const model: Model = {
  source: 'local',
  key: 'local/example',
  displayName: 'Example',
  capabilities: {
    tools: true,
    vision: true,
    reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
    contextWindows: [],
  },
  limits: { maxContextTokens: 200_000 },
};

function req(
  prompt: Partial<ModelPrompt>,
  config: ModelConfig = {},
  selectedModel = model,
): ModelStreamRequest {
  return {
    resolution: { model: selectedModel, config },
    prompt: { messages: [], ...prompt },
  };
}

async function collect(
  frames: ReadonlyArray<Partial<GenerateContentResponse>>,
): Promise<ModelStreamEvent[]> {
  async function* stream() {
    for (const frame of frames) yield frame as GenerateContentResponse;
  }
  const events: ModelStreamEvent[] = [];
  for await (const event of buildGeminiStreamEvents(stream(), 'example')) {
    events.push(event);
  }
  return events;
}

describe('buildGeminiStreamReq', () => {
  it('maps messages, tools and generation config', () => {
    const body = buildGeminiStreamReq(
      req(
        {
          messages: [
            { role: 'system', content: 'sys' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    mediaType: 'image/png',
                    data: 'AAA',
                  },
                },
              ],
            },
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'hmm', signature: 'think-sig' },
                { type: 'text', text: 'a' },
              ],
              toolCalls: [
                {
                  id: 'c1',
                  name: 'read',
                  arguments: '{"p":1}',
                  thoughtSignature: 'sig-1',
                },
              ],
            },
            { role: 'tool', toolCallId: 'c1', content: 'ok', isError: true },
          ],
          tools: [
            {
              name: 'read',
              description: 'read a file',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', additionalProperties: false },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { recursive: { type: 'boolean' } },
                    },
                  },
                },
                required: ['path'],
              },
            },
          ],
          toolChoice: { name: 'read' },
        },
        {
          sampling: { temperature: 0.3, topP: 0.9, topK: 5, stop: ['END'] },
          context: { maxOutputTokens: 512 },
          reasoning: { effort: 'high' },
        },
      ),
    );

    expect(body.model).toBe('example');
    expect(body.config?.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'sys' }],
    });
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'look' },
          { inlineData: { mimeType: 'image/png', data: 'AAA' } },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'hmm', thought: true, thoughtSignature: 'think-sig' },
          { text: 'a' },
          {
            functionCall: { name: 'read', args: { p: 1 } },
            thoughtSignature: 'sig-1',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read', response: { error: 'ok' } } },
        ],
      },
    ]);
    expect(body.config?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'read',
            description: 'read a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { recursive: { type: 'boolean' } },
                  },
                },
              },
              required: ['path'],
            },
          },
        ],
      },
    ]);
    expect(body.config?.toolConfig?.functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['read'],
    });
    expect(body.config?.temperature).toBe(0.3);
    expect(body.config?.topP).toBe(0.9);
    expect(body.config?.topK).toBe(5);
    expect(body.config?.stopSequences).toEqual(['END']);
    expect(body.config?.maxOutputTokens).toBe(512);
    expect(body.config?.thinkingConfig).toEqual({
      thinkingBudget: 24_576,
      includeThoughts: true,
    });
  });

  it('disables thinking with a zero budget', () => {
    const body = buildGeminiStreamReq(
      req({ messages: [] }, { reasoning: { effort: 'none' } }),
    );
    expect(body.config?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
  });
});

describe('buildGeminiStreamEvents', () => {
  it('projects text, thoughts, tool calls and usage', async () => {
    const events = await collect([
      {
        modelVersion: 'gemini-2.5-pro',
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 5 },
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'plan',
                  thought: true,
                  thoughtSignature: 'think-sig',
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'read', args: { p: 1 } },
                  thoughtSignature: 'sig-1',
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [{ finishReason: FinishReason.STOP }],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 2,
          cachedContentTokenCount: 1,
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'message_start',
        message: {
          id: '',
          role: 'assistant',
          model: 'gemini-2.5-pro',
          usage: { inputTokens: 5 },
        },
      },
      { type: 'content_block_start', index: 0, contentBlock: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        contentBlock: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'think-sig' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        contentBlock: {
          type: 'tool_use',
          id: 'gemini-tool-2',
          name: 'read',
          input: {},
          thoughtSignature: 'sig-1',
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"p":1}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stopReason: 'tool_use' },
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          reasoningTokens: 2,
          cacheReadInputTokens: 1,
        },
      },
      { type: 'message_stop' },
    ]);
  });

  it('maps safety stops to refusal', async () => {
    const events = await collect([
      { candidates: [{ finishReason: FinishReason.SAFETY }] },
    ]);
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stopReason: 'refusal' },
    });
  });
});
