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

function self<T>(this: T): T {
  return this;
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
    setStatus: self,
    end() {},
    updateName: self,
    recordException: self,
    addEvent: self,
    addLink: self,
    addLinks: self,
  };
}

function exchange(
  target: Span,
  captureContent = true,
  parent: Context = ROOT_CONTEXT,
) {
  return createGenAiExchange(parent, target, {
    captureContent,
    sensitiveAttributeMaxLength: 10_000,
  });
}

// A recording span plus an exchange observing it.
function observe(captureContent = true) {
  const target = span();
  return { target, observed: exchange(target, captureContent) };
}

// A request whose only message is one user turn.
function userTurn(content: string) {
  return { messages: [{ role: 'user', content }] };
}

const inputOf = (s: MockSpan) => s.attributes['gen_ai.input.messages'];
const outputOf = (s: MockSpan) => s.attributes['gen_ai.output.messages'];

// An OpenAI stream chunk with one choice-0 delta; `finish_reason` only if given.
function chunk(content: string, finish_reason?: string) {
  const choice = { index: 0, delta: { content } };
  return {
    choices: [
      finish_reason === undefined ? choice : { ...choice, finish_reason },
    ],
  };
}

describe('GenAI exchange observer', () => {
  it('records provider-final request content and response content', () => {
    const { target, observed } = observe();
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
    expect(JSON.parse(inputOf(target) as string)).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'hello' }],
      },
    ]);
    expect(target.attributes['gen_ai.tool.definitions']).toBe('[]');
    expect(JSON.parse(outputOf(target) as string)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'answer' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('keeps the first request snapshot and latest response attempt', () => {
    const { target, observed } = observe();
    const first = reportOpenAiRequest(userTurn('first'), observed.context);
    reportOpenAiChunk(first, chunk('old'));
    const second = reportOpenAiRequest(userTurn('second'), observed.context);
    reportOpenAiChunk(first, chunk('late', 'stop'));
    reportOpenAiChunk(second, chunk('new', 'length'));
    observed.controller.finalize(true);

    expect(inputOf(target)).toContain('first');
    expect(inputOf(target)).not.toContain('second');
    expect(outputOf(target)).toContain('new');
    expect(outputOf(target)).not.toContain('old');
    expect(outputOf(target)).not.toContain('late');
  });

  it('starts a fallback attempt from its handle after context exit', () => {
    const { target, observed } = observe();
    const streamingAttempt = reportAnthropicRequest(
      { ...userTurn('initial'), stream: true },
      observed.context,
    );
    const fallbackAttempt = reportAnthropicFollowingRequest(
      userTurn('fallback'),
      streamingAttempt,
    );
    reportAnthropicResponse(fallbackAttempt, {
      content: [{ type: 'text', text: 'fallback answer' }],
      stop_reason: 'end_turn',
    });

    expect(observed.controller.finalize(true)).toEqual(['end_turn']);
    expect(inputOf(target)).toContain('initial');
    expect(inputOf(target)).not.toContain('fallback');
    expect(outputOf(target)).toContain('fallback answer');
  });

  it('does not recover a missing fallback handle from the active context', () => {
    const target = span();
    const outer = exchange(target);

    context.with(outer.context, () => {
      expect(
        reportAnthropicFollowingRequest(userTurn('fallback'), undefined),
      ).toBeUndefined();
    });

    expect(target.attributes).toEqual({});
  });

  it('consumes an empty first snapshot', () => {
    const { target, observed } = observe();
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
    const inner = exchange(span(false), true, outer.context);

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
    const inner = exchange(span(), true, brokenParent);

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
      userTurn('left-input'),
      left.context,
    );
    const rightAttempt = reportOpenAiRequest(
      userTurn('right-input'),
      right.context,
    );
    reportOpenAiChunk(rightAttempt, chunk('right-output', 'stop'));
    reportOpenAiChunk(leftAttempt, chunk('left-output', 'stop'));
    left.controller.finalize(true);
    right.controller.finalize(true);

    expect(inputOf(leftSpan)).toContain('left-input');
    expect(outputOf(leftSpan)).toContain('left-output');
    expect(outputOf(leftSpan)).not.toContain('right-output');
    expect(inputOf(rightSpan)).toContain('right-input');
    expect(outputOf(rightSpan)).toContain('right-output');
  });

  it('uses an explicit handle after the creating context has exited', () => {
    const { target, observed } = observe();
    const attempt = reportOpenAiRequest({ messages: [] }, observed.context);
    reportOpenAiChunk(attempt, chunk('outside', 'stop'));
    observed.controller.finalize(true);
    expect(outputOf(target)).toContain('outside');
  });

  it('invalidates handles and makes finalize idempotent', () => {
    const { target, observed } = observe();
    const attempt = reportOpenAiRequest({ messages: [] }, observed.context);
    reportOpenAiChunk(attempt, chunk('before', 'stop'));
    expect(observed.controller.finalize(true)).toEqual(['stop']);
    reportOpenAiChunk(attempt, chunk('after', 'length'));
    expect(observed.controller.finalize(false)).toBeUndefined();
    expect(outputOf(target)).not.toContain('after');
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
    const { target, observed } = observe();
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
    expect(outputOf(target)).toBeUndefined();
  });

  it('captures non-sensitive request fields while content capture is off', () => {
    const { target, observed } = observe(false);
    const attempt = reportOpenAiRequest(
      {
        temperature: 0.3,
        messages: [{ role: 'user', content: 'secret' }],
      },
      observed.context,
    );
    reportOpenAiChunk(attempt, chunk('partial'));
    expect(target.attributes['gen_ai.request.temperature']).toBe(0.3);
    expect(inputOf(target)).toBeUndefined();
    expect(observed.controller.finalize(false)).toEqual(['error']);
    expect(outputOf(target)).toBeUndefined();
  });
});
