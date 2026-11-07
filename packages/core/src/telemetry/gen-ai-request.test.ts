/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, type Attributes, type Span } from '@opentelemetry/api';
import {
  createGenAiExchange,
  createGenAiRequestObserverContext,
  extractAnthropicRequestAttributes,
  extractLlmRequestAttributes,
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
    setAttribute: (key: string, value: unknown) => {
      if (options.throws) throw new Error('setAttribute failed');
      attributes[key] = value as Attributes[string];
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
        reasoning_effort: 'high',
      }),
    ).toEqual({
      'gen_ai.request.choice.count': 3,
      'gen_ai.request.max_tokens': 512,
      'gen_ai.request.temperature': 0,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.frequency_penalty': -0.25,
      'gen_ai.request.presence_penalty': 0.5,
      'gen_ai.request.stop_sequences': ['done'],
      'gen_ai.request.reasoning.level': 'high',
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
      reasoning_effort: 'high',
    }) as Record<string, unknown>;
    request['top_p'] = 0.8;
    expect(extractOpenAiRequestAttributes(request)).toEqual({
      'gen_ai.request.top_p': 0.8,
    });
  });

  it.each([
    'low',
    'medium',
    'high',
    'minimal',
    'xhigh',
    'max',
    'none',
    'custom',
  ])('preserves the exact reasoning effort %s', (reasoningEffort) => {
    expect(
      extractOpenAiRequestAttributes({ reasoning_effort: reasoningEffort }),
    ).toEqual({ 'gen_ai.request.reasoning.level': reasoningEffort });
  });

  it.each([undefined, null, '', 1, false, [], {}])(
    'omits invalid reasoning effort %j',
    (reasoningEffort) => {
      expect(
        extractOpenAiRequestAttributes({ reasoning_effort: reasoningEffort }),
      ).toEqual({});
    },
  );

  it('does not infer reasoning effort from nested provider fields', () => {
    expect(
      extractOpenAiRequestAttributes({ reasoning: { effort: 'high' } }),
    ).toEqual({});
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
      extractLlmRequestAttributes({
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
    expect(extractLlmRequestAttributes({ config: null })).toEqual({});
    expect(extractLlmRequestAttributes({ config: 'invalid' })).toEqual({});
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
    reportOpenAiRequest(
      { temperature: 0.5, reasoning_effort: 'high' },
      requestContext,
    );

    expect(attributes).toEqual({});
  });

  it('retains the first reasoning effort across request attempts', () => {
    const { span, attributes } = createSpan();
    const requestContext = createGenAiRequestObserverContext(
      ROOT_CONTEXT,
      span,
    );

    reportOpenAiRequest({ reasoning_effort: 'high' }, requestContext);
    reportOpenAiRequest({ reasoning_effort: 'low' }, requestContext);
    reportOpenAiRequest({}, requestContext);

    expect(attributes).toEqual({ 'gen_ai.request.reasoning.level': 'high' });
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

    reportOpenAiRequest(
      { temperature: 0.1, reasoning_effort: 'high' },
      firstContext,
    );
    reportOpenAiRequest({ temperature: 0.9 }, secondContext);

    expect(first.attributes).toEqual({
      'gen_ai.request.temperature': 0.1,
      'gen_ai.request.reasoning.level': 'high',
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

describe('GenAI response attributes', () => {
  /** A live observer whose span collects attributes, plus its handle. */
  function observed() {
    const { span, attributes } = createSpan();
    const exchange = createGenAiExchange(ROOT_CONTEXT, span, {
      captureContent: false,
      sensitiveAttributeMaxLength: 1024,
    });
    const handle = reportOpenAiRequest({}, exchange.context);
    return { span, attributes, controller: exchange.controller, handle };
  }

  it('writes a response attribute onto the span', () => {
    const { attributes, controller, handle } = observed();
    controller.recordResponseAttribute(
      handle,
      'openrouter.provider',
      'Parasail',
    );
    expect(attributes).toEqual({ 'openrouter.provider': 'Parasail' });
  });

  it('overwrites an earlier value so a retry reports the answering attempt', () => {
    const { attributes, controller, handle } = observed();
    controller.recordResponseAttribute(handle, 'openrouter.provider', 'Stale');
    controller.recordResponseAttribute(handle, 'openrouter.provider', 'Fresh');
    expect(attributes['openrouter.provider']).toBe('Fresh');
  });

  it('ignores an undefined value', () => {
    const { attributes, controller, handle } = observed();
    controller.recordResponseAttribute(
      handle,
      'openrouter.provider',
      undefined,
    );
    expect(attributes).toEqual({});
  });

  it('ignores a missing handle', () => {
    const { attributes, controller } = observed();
    expect(() =>
      controller.recordResponseAttribute(undefined, 'openrouter.provider', 'x'),
    ).not.toThrow();
    expect(attributes).toEqual({});
  });

  it('refuses a handle from an earlier generation', () => {
    // The retry path reuses one span, so a stale handle and a live one have
    // the same controller: only the generation tells them apart, and the
    // foreign-controller case below cannot exercise that check.
    const { span, attributes } = createSpan();
    const exchange = createGenAiExchange(ROOT_CONTEXT, span, {
      captureContent: false,
      sensitiveAttributeMaxLength: 1024,
    });
    const stale = reportOpenAiRequest({}, exchange.context);
    reportOpenAiRequest({}, exchange.context);
    exchange.controller.recordResponseAttribute(
      stale,
      'openrouter.provider',
      'stale',
    );
    expect(attributes['openrouter.provider']).toBeUndefined();
  });

  it('refuses a handle from a different controller', () => {
    const { attributes, controller, handle } = observed();
    const exchange = createGenAiExchange(ROOT_CONTEXT, createSpan().span, {
      captureContent: false,
      sensitiveAttributeMaxLength: 1024,
    });
    controller.recordResponseAttribute(handle, 'openrouter.provider', 'ok');
    // A foreign controller's handle must not reach this controller's span.
    exchange.controller.recordResponseAttribute(
      handle,
      'openrouter.provider',
      'foreign',
    );
    expect(attributes).toEqual({ 'openrouter.provider': 'ok' });
  });

  it('refuses a same-generation handle owned by another controller', () => {
    // Both exchanges open one attempt, so both handles carry generation 1 and
    // only the controller identity separates them. Without that check the
    // write would land on this exchange's span.
    const first = observed();
    const second = observed();
    first.controller.recordResponseAttribute(
      second.handle,
      'openrouter.provider',
      'foreign',
    );
    expect(first.attributes).toEqual({});
  });

  it('refuses to write after the exchange is finalized', () => {
    const { attributes, controller, handle } = observed();
    controller.finalize(true);
    controller.recordResponseAttribute(handle, 'openrouter.provider', 'late');
    expect(attributes['openrouter.provider']).toBeUndefined();
  });

  it('does not let span failures escape', () => {
    const { span } = createSpan({ throws: true });
    const exchange = createGenAiExchange(ROOT_CONTEXT, span, {
      captureContent: false,
      sensitiveAttributeMaxLength: 1024,
    });
    const handle = reportOpenAiRequest({}, exchange.context);
    expect(() =>
      exchange.controller.recordResponseAttribute(
        handle,
        'openrouter.provider',
        'x',
      ),
    ).not.toThrow();
  });
});
