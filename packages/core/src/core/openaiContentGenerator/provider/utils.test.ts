/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';
import { CerebrasOpenAICompatibleProvider } from './cerebras.js';
import { MistralOpenAICompatibleProvider } from './mistral.js';
import { stripReasoningContent } from './utils.js';

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type AssistantPayload = Partial<
  Omit<ExtendedChatCompletionAssistantMessageParam, 'role'>
> & { provider_payload?: { opaque: string } };

describe('stripReasoningContent', () => {
  it.each([
    { content: undefined },
    { content: null },
    { content: '' },
    { content: [] },
  ])(
    'drops a reasoning-only assistant segment with $content',
    ({ content }) => {
      const message = {
        role: 'assistant',
        content,
        reasoning_content: 'Let me reconsider.',
      } as Message;
      const before = structuredClone(message);

      expect(stripReasoningContent(message)).toEqual([]);
      expect(message).toEqual(before);
    },
  );

  it.each<AssistantPayload>([
    { content: 'Visible answer' },
    { content: ' ' },
    { content: [{ type: 'text', text: 'Visible answer' }] },
    {
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    },
    { function_call: { name: 'read_file', arguments: '{}' } },
    { audio: { id: 'audio_1' } },
    { refusal: 'I cannot help with that.' },
    { provider_payload: { opaque: 'keep' } },
  ])('preserves assistant payload %j', (payload) => {
    const message: ExtendedChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: null,
      ...payload,
      reasoning_content: 'Reasoning to remove.',
    };
    const before = structuredClone(message);

    expect(stripReasoningContent(message)).toEqual([
      { role: 'assistant', content: null, ...payload },
    ]);
    expect(message).toEqual(before);
  });

  it('removes only reasoning-only segments from ordered history', () => {
    const messages = [
      { role: 'user', content: 'Check the file.' },
      {
        role: 'assistant',
        content: '',
        name: 'agent',
        tool_calls: [],
        reasoning_content: 'First thought.',
      },
      { role: 'assistant', content: 'I will check it.' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Second thought.',
      },
      { role: 'assistant', content: 'Here is the result.' },
    ] as Message[];
    const before = structuredClone(messages);

    expect(messages.flatMap(stripReasoningContent)).toEqual([
      messages[0],
      messages[2],
      messages[4],
    ]);
    expect(messages).toEqual(before);
  });

  it.each([{}, { reasoning_content: '' }, { reasoning_content: null }])(
    'keeps a pre-existing empty assistant without populated reasoning: %j',
    (reasoning) => {
      const message = {
        role: 'assistant',
        content: '',
        ...reasoning,
      } as Message;

      expect(stripReasoningContent(message)).toEqual([
        { role: 'assistant', content: '' },
      ]);
    },
  );

  it('does not drop other roles when stripping an unexpected reasoning field', () => {
    const message = {
      role: 'user',
      content: '',
      reasoning_content: 'Unexpected extension.',
    } as Message;

    expect(stripReasoningContent(message)).toEqual([
      { role: 'user', content: '' },
    ]);
  });

  it.each([
    { Provider: MistralOpenAICompatibleProvider, host: 'api.mistral.ai' },
    { Provider: CerebrasOpenAICompatibleProvider, host: 'api.cerebras.ai' },
  ])(
    'omits empty reasoning segments at the $host boundary',
    ({ Provider, host }) => {
      const provider = new Provider(
        {
          apiKey: 'test-key',
          baseUrl: `https://${host}/v1`,
          model: 'strict-chat',
        } as ContentGeneratorConfig,
        { getCliVersion: () => 'test' } as Config,
      );
      const messages = [
        { role: 'user', content: 'Check the file.' },
        { role: 'assistant', content: '', reasoning_content: 'Thinking.' },
        { role: 'assistant', content: 'I will check it.' },
      ] as Message[];
      const before = structuredClone(messages);

      const result = provider.buildRequest(
        { model: 'strict-chat', messages },
        'test-prompt',
      );

      expect(result.messages).toEqual([messages[0], messages[2]]);
      expect(messages).toEqual(before);
    },
  );
});
