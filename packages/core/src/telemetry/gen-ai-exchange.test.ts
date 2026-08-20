/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  ROOT_CONTEXT,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import {
  createGenAiExchange,
  reportAnthropicFollowingRequest,
  reportAnthropicRequest,
  reportAnthropicResponse,
  reportOpenAiChunk,
  reportOpenAiRequest,
  reportOpenAiResponse,
} from './gen-ai-request.js';

interface MockSpan extends Span {
  attributes: Record<string, unknown>;
}

function span(recording = true): MockSpan {
  const attributes: Record<string, unknown> = {};
  return {
    attributes,
    setAttributes(values: Attributes) {
      Object.assign(attributes, values);
      return this;
    },
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      return this;
    },
    isRecording: () => recording,
    spanContext(): SpanContext {
      return {
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 0,
      };
    },
    setStatus() {
      return this;
    },
    end() {},
    updateName() {
      return this;
    },
    recordException() {
      return this;
    },
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
  };
}

function exchange(target: Span, captureContent = true) {
  return createGenAiExchange(ROOT_CONTEXT, target, {
    captureContent,
    sensitiveAttributeMaxLength: 10_000,
  });
}

describe('GenAI exchange observer', () => {
  it('records provider-final request content and response content', () => {
    const target = span();
    const observed = exchange(target);
    const attempt = reportOpenAiRequest(
      {
        temperature: 0.2,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
      observed.context,
    );
    reportOpenAiResponse(attempt, {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer' },
          finish_reason: 'stop',
        },
      ],
    });

    expect(observed.controller.finalize(true)).toEqual(['stop']);
    expect(target.attributes['gen_ai.request.temperature']).toBe(0.2);
    expect(
      JSON.parse(target.attributes['gen_ai.input.messages'] as string),
    ).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'hello' }],
      },
    ]);
    expect(target.attributes['gen_ai.tool.definitions']).toBe('[]');
    expect(
      JSON.parse(target.attributes['gen_ai.output.messages'] as string),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'answer' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('keeps the first request snapshot and latest response attempt', () => {
    const target = span();
    const observed = exchange(target);
    const first = reportOpenAiRequest(
      { messages: [{ role: 'user', content: 'first' }] },
      observed.context,
    );
    reportOpenAiChunk(first, {
      choices: [{ index: 0, delta: { content: 'old' } }],
    });
    const second = reportOpenAiRequest(
      { messages: [{ role: 'user', content: 'second' }] },
      observed.context,
    );
    reportOpenAiChunk(first, {
      choices: [
        { index: 0, delta: { content: 'late' }, finish_reason: 'stop' },
      ],
    });
    reportOpenAiChunk(second, {
      choices: [
        { index: 0, delta: { content: 'new' }, finish_reason: 'length' },
      ],
    });
    observed.controller.finalize(true);

    expect(target.attributes['gen_ai.input.messages']).toContain('first');
    expect(target.attributes['gen_ai.input.messages']).not.toContain('second');
    expect(target.attributes['gen_ai.output.messages']).toContain('new');
    expect(target.attributes['gen_ai.output.messages']).not.toContain('old');
    expect(target.attributes['gen_ai.output.messages']).not.toContain('late');
  });

  it('starts a fallback attempt from its handle after context exit', () => {
    const target = span();
    const observed = exchange(target);
    const streamingAttempt = reportAnthropicRequest(
      { messages: [{ role: 'user', content: 'initial' }], stream: true },
      observed.context,
    );
    const fallbackAttempt = reportAnthropicFollowingRequest(
      { messages: [{ role: 'user', content: 'fallback' }] },
      streamingAttempt,
    );
    reportAnthropicResponse(fallbackAttempt, {
      content: [{ type: 'text', text: 'fallback answer' }],
      stop_reason: 'end_turn',
    });

    expect(observed.controller.finalize(true)).toEqual(['end_turn']);
    expect(target.attributes['gen_ai.input.messages']).toContain('initial');
    expect(target.attributes['gen_ai.input.messages']).not.toContain(
      'fallback',
    );
    expect(target.attributes['gen_ai.output.messages']).toContain(
      'fallback answer',
    );
  });

  it('does not recover a missing fallback handle from the active context', () => {
    const target = span();
    const outer = createGenAiExchange(ROOT_CONTEXT, target, {
      captureContent: true,
      sensitiveAttributeMaxLength: 10_000,
    });

    context.with(outer.context, () => {
      expect(
        reportAnthropicFollowingRequest(
          { messages: [{ role: 'user', content: 'fallback' }] },
          undefined,
        ),
      ).toBeUndefined();
    });

    expect(target.attributes).toEqual({});
  });

  it('consumes an empty first snapshot', () => {
    const target = span();
    const observed = exchange(target);
    reportOpenAiRequest({}, observed.context);
    reportOpenAiRequest(
      {
        temperature: 0.9,
        messages: [{ role: 'user', content: 'later' }],
      },
      observed.context,
    );
    expect(target.attributes).toEqual({});
  });

  it('shadows an outer observer for a non-recording nested span', () => {
    const outerSpan = span();
    const outer = exchange(outerSpan);
    const inner = createGenAiExchange(outer.context, span(false), {
      captureContent: true,
      sensitiveAttributeMaxLength: 10_000,
    });

    const innerAttempt = reportOpenAiRequest(
      { temperature: 0.9 },
      inner.context,
    );
    expect(innerAttempt).toBeUndefined();
    expect(outerSpan.attributes).toEqual({});

    reportOpenAiRequest({ temperature: 0.1 }, outer.context);
    expect(outerSpan.attributes['gen_ai.request.temperature']).toBe(0.1);
  });

  it('does not fall back to an outer observer when context installation fails', () => {
    const outerSpan = span();
    const outer = exchange(outerSpan);
    const brokenParent: Context = {
      getValue: (key) => outer.context.getValue(key),
      setValue: () => {
        throw new Error('context write failed');
      },
      deleteValue: () => {
        throw new Error('context write failed');
      },
    };
    const inner = createGenAiExchange(brokenParent, span(), {
      captureContent: true,
      sensitiveAttributeMaxLength: 10_000,
    });

    expect(
      reportOpenAiRequest({ temperature: 0.9 }, inner.context),
    ).toBeUndefined();
    expect(outerSpan.attributes).toEqual({});
  });

  it('isolates concurrent exchange contexts and attempt handles', () => {
    const leftSpan = span();
    const rightSpan = span();
    const left = exchange(leftSpan);
    const right = exchange(rightSpan);
    const leftAttempt = reportOpenAiRequest(
      { messages: [{ role: 'user', content: 'left-input' }] },
      left.context,
    );
    const rightAttempt = reportOpenAiRequest(
      { messages: [{ role: 'user', content: 'right-input' }] },
      right.context,
    );
    reportOpenAiChunk(rightAttempt, {
      choices: [
        { index: 0, delta: { content: 'right-output' }, finish_reason: 'stop' },
      ],
    });
    reportOpenAiChunk(leftAttempt, {
      choices: [
        { index: 0, delta: { content: 'left-output' }, finish_reason: 'stop' },
      ],
    });
    left.controller.finalize(true);
    right.controller.finalize(true);

    expect(leftSpan.attributes['gen_ai.input.messages']).toContain(
      'left-input',
    );
    expect(leftSpan.attributes['gen_ai.output.messages']).toContain(
      'left-output',
    );
    expect(leftSpan.attributes['gen_ai.output.messages']).not.toContain(
      'right-output',
    );
    expect(rightSpan.attributes['gen_ai.input.messages']).toContain(
      'right-input',
    );
    expect(rightSpan.attributes['gen_ai.output.messages']).toContain(
      'right-output',
    );
  });

  it('uses an explicit handle after the creating context has exited', () => {
    const target = span();
    const observed = exchange(target);
    const attempt = reportOpenAiRequest({ messages: [] }, observed.context);
    reportOpenAiChunk(attempt, {
      choices: [
        { index: 0, delta: { content: 'outside' }, finish_reason: 'stop' },
      ],
    });
    observed.controller.finalize(true);
    expect(target.attributes['gen_ai.output.messages']).toContain('outside');
  });

  it('invalidates handles and makes finalize idempotent', () => {
    const target = span();
    const observed = exchange(target);
    const attempt = reportOpenAiRequest({ messages: [] }, observed.context);
    reportOpenAiChunk(attempt, {
      choices: [
        { index: 0, delta: { content: 'before' }, finish_reason: 'stop' },
      ],
    });
    expect(observed.controller.finalize(true)).toEqual(['stop']);
    reportOpenAiChunk(attempt, {
      choices: [
        { index: 0, delta: { content: 'after' }, finish_reason: 'length' },
      ],
    });
    expect(observed.controller.finalize(false)).toBeUndefined();
    expect(target.attributes['gen_ai.output.messages']).not.toContain('after');
  });

  it('does not let span API failures affect reporting', () => {
    const target = span();
    target.setAttributes = () => {
      throw new Error('setAttributes failed');
    };
    target.setAttribute = () => {
      throw new Error('setAttribute failed');
    };
    const observed = exchange(target);
    expect(() =>
      reportOpenAiRequest(
        {
          temperature: 0.1,
          messages: [{ role: 'user', content: 'secret' }],
        },
        observed.context,
      ),
    ).not.toThrow();
    expect(() => observed.controller.finalize(false)).not.toThrow();
  });

  it('omits response content when conversion throws after a partial update', () => {
    const target = span();
    const observed = exchange(target);
    const attempt = reportOpenAiRequest({ messages: [] }, observed.context);
    const brokenMessage = new Proxy(
      {},
      {
        get: () => {
          throw new Error('response conversion failed');
        },
      },
    );
    reportOpenAiResponse(attempt, {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'partial' },
          finish_reason: 'stop',
        },
        {
          index: 1,
          message: brokenMessage,
          finish_reason: 'stop',
        },
      ],
    });

    expect(observed.controller.finalize(true)).toBeUndefined();
    expect(target.attributes['gen_ai.output.messages']).toBeUndefined();
  });

  it('captures non-sensitive request fields while content capture is off', () => {
    const target = span();
    const observed = exchange(target, false);
    const attempt = reportOpenAiRequest(
      {
        temperature: 0.3,
        messages: [{ role: 'user', content: 'secret' }],
      },
      observed.context,
    );
    reportOpenAiChunk(attempt, {
      choices: [{ index: 0, delta: { content: 'partial' } }],
    });
    expect(target.attributes['gen_ai.request.temperature']).toBe(0.3);
    expect(target.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(observed.controller.finalize(false)).toEqual(['error']);
    expect(target.attributes['gen_ai.output.messages']).toBeUndefined();
  });
});
