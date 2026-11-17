/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  isBareTextPart,
  isTypedPrompt,
  markTypedPrompt,
  TYPED_PROMPT_METADATA,
} from './typed-prompt.js';
import { OpenAIContentConverter } from '../core/openaiContentGenerator/converter.js';
import { AnthropicContentConverter } from '../core/anthropicContentGenerator/converter.js';
import { convertGeminiContentsToResponsesInput } from '../core/openaiResponsesContentGenerator/responses-converter.js';

describe('typed-prompt mark', () => {
  it('marks a copy and keeps the metadata already there', () => {
    const part: Part = { text: 'port the parser', partMetadata: { a: 1 } };
    const marked = markTypedPrompt(part);
    expect(marked).toEqual({
      text: 'port the parser',
      partMetadata: { a: 1, [TYPED_PROMPT_METADATA]: true },
    });
    expect(part).toEqual({ text: 'port the parser', partMetadata: { a: 1 } });
  });

  it.each<[string, Part, boolean]>([
    ['a marked text part', markTypedPrompt({ text: 'x' }), true],
    ['an unmarked text part', { text: 'x' }, false],
    [
      'a mark whose value is not true',
      { text: 'x', partMetadata: { [TYPED_PROMPT_METADATA]: 'yes' } },
      false,
    ],
    ['a marked thought', markTypedPrompt({ text: 'x', thought: true }), false],
    [
      'a marked function call',
      markTypedPrompt({ text: 'x', functionCall: { name: 'f' } }),
      false,
    ],
    [
      'a marked function response',
      markTypedPrompt({ text: 'x', functionResponse: { name: 'f' } }),
      false,
    ],
    [
      'a marked part with no text',
      markTypedPrompt({ inlineData: { mimeType: 'image/png', data: '' } }),
      false,
    ],
  ])('reads %s as typed: %s', (_label, part, expected) => {
    expect(isTypedPrompt(part)).toBe(expected);
  });

  it.each<[string, Part, boolean]>([
    ['text alone', { text: '/docs' }, true],
    ['text with only the mark', markTypedPrompt({ text: '/docs' }), true],
    [
      'text with the mark and other metadata',
      markTypedPrompt({ text: '/docs', partMetadata: { other: true } }),
      false,
    ],
    [
      'text with other metadata only',
      { text: '/docs', partMetadata: { other: true } },
      false,
    ],
    [
      'text with another field',
      { ...markTypedPrompt({ text: '/docs' }), thoughtSignature: 's' },
      false,
    ],
    ['no text', { inlineData: { mimeType: 'image/png', data: '' } }, false],
  ])('reads %s as a bare text part: %s', (_label, part, expected) => {
    expect(isBareTextPart(part)).toBe(expected);
  });
});

describe('the typed-prompt mark never reaches a provider', () => {
  const contents: Content[] = [
    {
      role: 'user',
      parts: [markTypedPrompt({ text: 'port the parser' })],
    },
  ];
  const request = { model: 'test-model', contents };

  it.each<[string, () => unknown]>([
    [
      'OpenAI-compatible',
      () =>
        OpenAIContentConverter.convertLlmRequestToOpenAI(request, {
          model: 'test-model',
          modalities: { image: true, pdf: true, audio: true, video: true },
          startTime: 0,
        }),
    ],
    [
      'Anthropic',
      () =>
        new AnthropicContentConverter(
          'test-model',
          'auto',
        ).convertLlmRequestToAnthropic(request),
    ],
    [
      'OpenAI Responses',
      () => convertGeminiContentsToResponsesInput(request).input,
    ],
  ])('%s request carries the text and not the mark', (_route, convert) => {
    const wire = JSON.stringify(convert());
    expect(wire).toContain('port the parser');
    expect(wire).not.toContain(TYPED_PROMPT_METADATA);
    expect(wire).not.toContain('partMetadata');
  });
});
