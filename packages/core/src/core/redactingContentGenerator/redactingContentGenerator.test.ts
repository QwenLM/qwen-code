/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import { RedactionManager } from '../../security/redaction.js';
import { RedactingContentGenerator } from './redactingContentGenerator.js';

class EchoContentGenerator implements ContentGenerator {
  lastRequest: GenerateContentParameters | undefined;

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    this.lastRequest = request;
    const contents = request.contents as Array<{
      parts?: Array<{ text?: string }>;
    }>;
    const echoed = contents?.[0]?.parts?.[0]?.text ?? '';
    return {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: echoed }] },
        },
      ],
      promptFeedback: { safetyRatings: [] },
      text: undefined,
      data: undefined,
      functionCalls: undefined,
      executableCode: undefined,
      codeExecutionResult: undefined,
    };
  }

  async generateContentStream(): Promise<
    AsyncGenerator<GenerateContentResponse>
  > {
    throw new Error('not implemented');
  }

  async countTokens(_req: CountTokensParameters): Promise<CountTokensResponse> {
    return { totalTokens: 0 };
  }

  async embedContent(
    _req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return { embeddings: [] };
  }

  useSummarizedThinking(): boolean {
    return false;
  }
}

describe('RedactingContentGenerator', () => {
  it('redacts outgoing request contents and restores placeholders in responses', async () => {
    const base = new EchoContentGenerator();
    const redaction = new RedactionManager({
      enabled: true,
      keywords: { 'example-secret-123': 'API_KEY' },
    });
    const generator = new RedactingContentGenerator(base, redaction);

    const resp = await generator.generateContent(
      {
        model: 'test',
        contents: [{ role: 'user', parts: [{ text: 'example-secret-123' }] }],
      } as unknown as GenerateContentParameters,
      'prompt-1',
    );

    const sent =
      (
        base.lastRequest?.contents as Array<{
          parts?: Array<{ text?: string }>;
        }>
      )?.[0]?.parts?.[0]?.text ?? '';
    expect(sent).not.toContain('example-secret-123');
    expect(sent).toMatch(/__VG_API_KEY_[a-f0-9]{12}(?:_\\d+)?__/);

    const got = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    expect(got).toBe('example-secret-123');
  });

  it('is a no-op when disabled', async () => {
    const base = new EchoContentGenerator();
    const redaction = new RedactionManager({
      enabled: false,
      keywords: { 'example-secret-123': 'API_KEY' },
    });
    const generator = new RedactingContentGenerator(base, redaction);

    const resp = await generator.generateContent(
      {
        model: 'test',
        contents: [{ role: 'user', parts: [{ text: 'example-secret-123' }] }],
      } as unknown as GenerateContentParameters,
      'prompt-1',
    );

    const sent =
      (
        base.lastRequest?.contents as Array<{
          parts?: Array<{ text?: string }>;
        }>
      )?.[0]?.parts?.[0]?.text ?? '';
    expect(sent).toBe('example-secret-123');

    const got = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    expect(got).toBe('example-secret-123');
  });
});
