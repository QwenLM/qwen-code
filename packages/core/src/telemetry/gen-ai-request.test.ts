/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, type Attributes, type Span } from '@opentelemetry/api';
import {
  createGenAiRequestObserverContext,
  extractAnthropicRequestAttributes,
  extractGeminiRequestAttributes,
  extractOpenAiRequestAttributes,
  reportOpenAiRequest,
} from './gen-ai-request.js';

function createSpan(options: { recording?: boolean; throws?: boolean } = {}): {
  span: Span;
  attributes: Attributes;
} {
  const attributes: Attributes = {};
  const span = {
    isRecording: () => options.recording ?? true,
    setAttributes: (values: Attributes) => {
      if (options.throws) throw new Error('setAttributes failed');
      Object.assign(attributes, values);
      return span;
    },
  } as unknown as Span;
  return { span, attributes };
}

describe('GenAI request attribute extraction', () => {
  it('extracts all OpenAI-compatible fields', () => {
    expect(
      extractOpenAiRequestAttributes({
        n: 3,
        max_completion_tokens: 512,
        temperature: 0,
        top_p: 0.9,
        frequency_penalty: -0.25,
        presence_penalty: 0.5,
        stop: 'done',
      }),
    ).toEqual({
      'gen_ai.request.choice.count': 3,
      'gen_ai.request.max_tokens': 512,
      'gen_ai.request.temperature': 0,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.frequency_penalty': -0.25,
      'gen_ai.request.presence_penalty': 0.5,
      'gen_ai.request.stop_sequences': ['done'],
    });
  });

  it.each([
    ['max_tokens', { max_tokens: 11 }],
    ['max_completion_tokens', { max_completion_tokens: 11 }],
    ['max_new_tokens', { max_new_tokens: 11 }],
    [
      'matching aliases',
      { max_tokens: 11, max_completion_tokens: 11, max_new_tokens: 11 },
    ],
  ])('maps the %s output budget', (_name, request) => {
    expect(extractOpenAiRequestAttributes(request)).toEqual({
      'gen_ai.request.max_tokens': 11,
    });
  });

  it.each([
    { max_tokens: 10, max_completion_tokens: 11 },
    { max_tokens: 10, max_completion_tokens: 10.5 },
    { max_tokens: 10, max_new_tokens: Number.NaN },
    { max_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])('omits ambiguous or invalid output budgets', (request) => {
    expect(extractOpenAiRequestAttributes(request)).toEqual({});
  });

  it('omits choice count one but preserves other safe integers', () => {
    expect(extractOpenAiRequestAttributes({ n: 1 })).toEqual({});
    expect(extractOpenAiRequestAttributes({ n: 0 })).toEqual({
      'gen_ai.request.choice.count': 0,
    });
    expect(extractOpenAiRequestAttributes({ n: -1 })).toEqual({
      'gen_ai.request.choice.count': -1,
    });
  });

  it('omits invalid numbers and nullish values', () => {
    expect(
      extractOpenAiRequestAttributes({
        temperature: Number.NaN,
        top_p: Number.POSITIVE_INFINITY,
        frequency_penalty: '0.1',
        presence_penalty: null,
        max_tokens: undefined,
      }),
    ).toEqual({});
  });

  it('requires own properties', () => {
    const request = Object.create({
      n: 2,
      max_tokens: 50,
      temperature: 0.2,
      stop: ['inherited'],
    }) as Record<string, unknown>;
    request['top_p'] = 0.8;
    expect(extractOpenAiRequestAttributes(request)).toEqual({
      'gen_ai.request.top_p': 0.8,
    });
  });

  it('preserves and copies valid stop sequences', () => {
    const stop = ['one', 'two'];
    const attributes = extractOpenAiRequestAttributes({ stop });
    expect(attributes).toEqual({
      'gen_ai.request.stop_sequences': ['one', 'two'],
    });
    expect(attributes['gen_ai.request.stop_sequences']).not.toBe(stop);
    expect(extractOpenAiRequestAttributes({ stop: [] })).toEqual({
      'gen_ai.request.stop_sequences': [],
    });
    expect(extractOpenAiRequestAttributes({ stop: ['one', 2] })).toEqual({});
  });

  it('extracts Anthropic fields without unsupported penalties', () => {
    expect(
      extractAnthropicRequestAttributes({
        max_tokens: 0,
        temperature: -0.1,
        top_p: 1,
        stop_sequences: ['done'],
        frequency_penalty: 0.2,
        presence_penalty: 0.3,
      }),
    ).toEqual({
      'gen_ai.request.max_tokens': 0,
      'gen_ai.request.temperature': -0.1,
      'gen_ai.request.top_p': 1,
      'gen_ai.request.stop_sequences': ['done'],
    });
  });

  it('extracts fields from the final Gemini config', () => {
    expect(
      extractGeminiRequestAttributes({
        candidateCount: 99,
        config: {
          candidateCount: 2,
          maxOutputTokens: -1,
          temperature: 1,
          topP: 0.95,
          frequencyPenalty: 0,
          presencePenalty: -0.2,
          stopSequences: [],
        },
      }),
    ).toEqual({
      'gen_ai.request.choice.count': 2,
      'gen_ai.request.max_tokens': -1,
      'gen_ai.request.temperature': 1,
      'gen_ai.request.top_p': 0.95,
      'gen_ai.request.frequency_penalty': 0,
      'gen_ai.request.presence_penalty': -0.2,
      'gen_ai.request.stop_sequences': [],
    });
  });

  it('omits invalid Gemini config shapes', () => {
    expect(extractGeminiRequestAttributes({ config: null })).toEqual({});
    expect(extractGeminiRequestAttributes({ config: 'invalid' })).toEqual({});
  });
});

describe('GenAI request observer', () => {
  it('records only the first request snapshot', () => {
    const { span, attributes } = createSpan();
    const requestContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      span,
    );

    reportOpenAiRequest({}, requestContext);
    reportOpenAiRequest({ temperature: 0.5 }, requestContext);

    expect(attributes).toEqual({});
  });

  it('consumes the first snapshot when extraction fails', () => {
    const { span, attributes } = createSpan();
    const requestContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      span,
    );
    const brokenRequest = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('property inspection failed');
        },
      },
    );

    reportOpenAiRequest(brokenRequest, requestContext);
    reportOpenAiRequest({ temperature: 0.5 }, requestContext);

    expect(attributes).toEqual({});
  });

  it('keeps concurrent observer contexts isolated', () => {
    const first = createSpan();
    const second = createSpan();
    const firstContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      first.span,
    );
    const secondContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      second.span,
    );

    reportOpenAiRequest({ temperature: 0.1 }, firstContext);
    reportOpenAiRequest({ temperature: 0.9 }, secondContext);

    expect(first.attributes).toEqual({
      'gen_ai.request.temperature': 0.1,
    });
    expect(second.attributes).toEqual({
      'gen_ai.request.temperature': 0.9,
    });
  });

  it('does not install an observer for a non-recording span', () => {
    const { span, attributes } = createSpan({ recording: false });
    const requestContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      span,
    );
    reportOpenAiRequest({ temperature: 0.5 }, requestContext);
    expect(attributes).toEqual({});
  });

  it('does not let context failures escape', () => {
    const { span } = createSpan();
    const brokenParent = {
      setValue: () => {
        throw new Error('setValue failed');
      },
    } as unknown as typeof ROOT_CONTEXT;
    expect(() =>
      createGenAiRequestObserverContext(brokenParent, span),
    ).not.toThrow();

    const brokenReporterContext = {
      getValue: () => {
        throw new Error('getValue failed');
      },
    } as unknown as typeof ROOT_CONTEXT;
    expect(() =>
      reportOpenAiRequest({ temperature: 0.5 }, brokenReporterContext),
    ).not.toThrow();
  });

  it('does not let span failures escape', () => {
    const { span } = createSpan({ throws: true });
    const requestContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      span,
    );
    expect(() =>
      reportOpenAiRequest({ temperature: 0.5 }, requestContext),
    ).not.toThrow();
  });

  it('does nothing without an observer', () => {
    expect(() =>
      reportOpenAiRequest({ temperature: 0.5 }, ROOT_CONTEXT),
    ).not.toThrow();
  });
});
