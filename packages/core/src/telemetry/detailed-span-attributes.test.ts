/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attributes, Span, SpanContext } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  addAgentInputMessageAttributes,
  addAgentOutputMessageAttributes,
  addModelOutputAttributes,
  addSystemPromptAttributes,
  addToolArgumentsAttributes,
  addToolCallResultAttributes,
  addToolInputAttributes,
  addToolResultAttributes,
  addToolSchemaAttributes,
  addUserPromptAttributes,
  AgentOutputMessageCapture,
  clearDetailedSpanState,
  truncateContent,
} from './detailed-span-attributes.js';
import { DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH } from './constants.js';

const mockState = vi.hoisted(() => ({
  sdkInitialized: true,
  sensitiveEnabled: true,
  maxLength: 1024 * 1024,
}));

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => mockState.sdkInitialized,
}));

interface MockSpan extends Span {
  attrs: Record<string, unknown>;
}

function config(): Config {
  return {
    getTelemetryIncludeSensitiveSpanAttributes: () =>
      mockState.sensitiveEnabled,
    getTelemetrySensitiveSpanAttributeMaxLength: () => mockState.maxLength,
  } as unknown as Config;
}

function span(): MockSpan {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttributes(values: Attributes) {
      Object.assign(attrs, values);
      return this;
    },
    setAttribute(key: string, value: unknown) {
      attrs[key] = value;
      return this;
    },
    addEvent() {
      return this;
    },
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
    isRecording() {
      return true;
    },
    recordException() {
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

describe('detailed span attributes', () => {
  beforeEach(() => {
    mockState.sdkInitialized = true;
    mockState.sensitiveEnabled = true;
    mockState.maxLength = DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH;
  });

  describe('truncateContent', () => {
    it('preserves content at or below the limit', () => {
      expect(truncateContent('hello', 5)).toEqual({
        content: 'hello',
        truncated: false,
      });
    });

    it('uses the default 1 MiB limit', () => {
      const content = 'x'.repeat(
        DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH + 1,
      );
      const result = truncateContent(content);
      expect(result.content).toHaveLength(
        DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
      );
      expect(result.truncated).toBe(true);
    });

    it('bounds oversized content and marks it truncated', () => {
      const result = truncateContent('x'.repeat(100), 50);
      expect(result.content).toHaveLength(50);
      expect(result.truncated).toBe(true);
    });

    it('keeps a visible marker within very small limits', () => {
      expect(truncateContent('long', 3)).toEqual({
        content: '...',
        truncated: true,
      });
    });

    it('accepts a prebounded prefix with a larger original length', () => {
      expect(truncateContent('abc', 3, 6)).toEqual({
        content: 'abc',
        truncated: true,
      });
    });

    it('rejects an original length shorter than the content', () => {
      expect(() => truncateContent('abcd', 4, 3)).toThrow(TypeError);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid maximum %s',
      (maxLength) => {
        expect(() => truncateContent('x', maxLength)).toThrow(TypeError);
      },
    );
  });

  it('keeps interaction new_context behavior unchanged', () => {
    const target = span();
    addUserPromptAttributes(config(), target, 'hello');
    expect(target.attrs['new_context']).toBe('[USER PROMPT]\nhello');
  });

  it('writes one raw user message for an agent invocation', () => {
    const target = span();
    addAgentInputMessageAttributes(config(), target, 'raw @file prompt');
    expect(JSON.parse(target.attrs['gen_ai.input.messages'] as string)).toEqual(
      [
        {
          role: 'user',
          parts: [{ type: 'text', content: 'raw @file prompt' }],
        },
      ],
    );
  });

  it('writes one normalized final agent output message', () => {
    const target = span();
    addAgentOutputMessageAttributes(config(), target, '{"ok":true}', 'STOP');
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '{"ok":true}' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it.each([
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['LANGUAGE', 'content_filter'],
    ['BLOCKLIST', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['SPII', 'content_filter'],
    ['IMAGE_SAFETY', 'content_filter'],
    ['IMAGE_PROHIBITED_CONTENT', 'content_filter'],
    ['IMAGE_RECITATION', 'content_filter'],
    ['IMAGE_OTHER', 'content_filter'],
    ['tool_calls', 'tool_call'],
    ['function_call', 'tool_call'],
    ['MALFORMED_FUNCTION_CALL', 'malformed_function_call'],
  ])('normalizes agent finish reason %s to %s', (input, expected) => {
    const target = span();
    addAgentOutputMessageAttributes(config(), target, 'answer', input);
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toMatchObject([{ finish_reason: expected }]);
  });

  it('omits empty or incomplete agent messages', () => {
    const target = span();
    addAgentInputMessageAttributes(config(), target, ' \n\t ');
    addAgentOutputMessageAttributes(config(), target, 'answer', '');
    addAgentOutputMessageAttributes(
      config(),
      target,
      'answer',
      'FINISH_REASON_UNSPECIFIED',
    );
    addAgentOutputMessageAttributes(config(), target, ' \n\t ', 'STOP');
    expect(target.attrs).toEqual({});
  });

  it('omits complete agent message JSON when it exceeds the limit', () => {
    mockState.maxLength = 20;
    const target = span();
    addAgentInputMessageAttributes(config(), target, 'raw prompt');
    addAgentOutputMessageAttributes(config(), target, 'answer', 'stop');
    expect(target.attrs).toEqual({});
  });

  it('captures only a completed response without pending tools', () => {
    const target = span();
    const capture = new AgentOutputMessageCapture(config());
    capture.beginResponse();
    capture.appendText('final ');
    capture.appendText('answer');
    capture.observeFinishReason('STOP');
    capture.commitResponse(false);
    capture.writeToSpan(target);
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'final answer' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('resets failed attempts and preserves continuation fragments', () => {
    const target = span();
    const capture = new AgentOutputMessageCapture(config());
    capture.beginResponse();
    capture.appendText('discarded');
    capture.restartAttempt(false);
    capture.appendText('kept ');
    capture.restartAttempt(true);
    capture.appendText('continuation');
    capture.observeFinishReason('MAX_TOKENS');
    capture.commitResponse(false);
    capture.writeToSpan(target);
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toMatchObject([
      {
        parts: [{ content: 'kept continuation' }],
        finish_reason: 'length',
      },
    ]);
  });

  it('invalidates stale, tool, and incomplete captures', () => {
    const target = span();
    const capture = new AgentOutputMessageCapture(config());
    capture.beginResponse();
    capture.appendText('old');
    capture.observeFinishReason('STOP');
    capture.commitResponse(false);
    capture.beginResponse();
    capture.appendText('new');
    capture.observeFinishReason('STOP');
    capture.commitResponse(true);
    capture.writeToSpan(target);
    expect(target.attrs).toEqual({});
  });

  it('bounds oversized output capture in memory', () => {
    mockState.maxLength = 10;
    const target = span();
    const capture = new AgentOutputMessageCapture(config());
    capture.beginResponse();
    capture.appendText('01234567890');
    capture.observeFinishReason('STOP');
    capture.commitResponse(false);
    capture.writeToSpan(target);
    expect(target.attrs).toEqual({});
  });

  it('omits agent messages when sensitive telemetry is disabled or inactive', () => {
    const target = span();
    mockState.sensitiveEnabled = false;
    addAgentInputMessageAttributes(config(), target, 'disabled input');
    addAgentOutputMessageAttributes(
      config(),
      target,
      'disabled output',
      'STOP',
    );
    mockState.sensitiveEnabled = true;
    mockState.sdkInitialized = false;
    addAgentInputMessageAttributes(config(), target, 'inactive input');
    addAgentOutputMessageAttributes(
      config(),
      target,
      'inactive output',
      'STOP',
    );
    expect(target.attrs).toEqual({});
  });

  it('does not let agent-message Span API failures affect the caller', () => {
    const target = span();
    target.setAttribute = () => {
      throw new Error('cannot set');
    };
    expect(() =>
      addAgentInputMessageAttributes(config(), target, 'input'),
    ).not.toThrow();
    expect(() =>
      addAgentOutputMessageAttributes(config(), target, 'output', 'STOP'),
    ).not.toThrow();
  });

  it('keeps interaction truncation metadata', () => {
    mockState.maxLength = 20;
    const target = span();
    addUserPromptAttributes(config(), target, 'x'.repeat(100));
    expect(String(target.attrs['new_context'])).toHaveLength(20);
    expect(target.attrs['new_context_truncated']).toBe(true);
    expect(target.attrs['new_context_original_length']).toBe(100);
  });

  it('omits interaction content when disabled, uninitialized, or empty', () => {
    const target = span();
    mockState.sensitiveEnabled = false;
    addUserPromptAttributes(config(), target, 'disabled');
    mockState.sensitiveEnabled = true;
    mockState.sdkInitialized = false;
    addUserPromptAttributes(config(), target, 'uninitialized');
    mockState.sdkInitialized = true;
    addUserPromptAttributes(config(), target, '');
    expect(target.attrs).toEqual({});
  });

  it('writes compatibility helpers only to standard GenAI keys', () => {
    const target = span();
    addSystemPromptAttributes(config(), target, 'system');
    addToolSchemaAttributes(config(), target, [
      { type: 'function', name: 'read' },
    ]);
    addModelOutputAttributes(config(), target, 'answer', 'stop');
    addToolInputAttributes(config(), target, 'read', '{"path":"a"}');
    addToolResultAttributes(config(), target, 'read', '{"output":"ok"}');

    expect(
      JSON.parse(target.attrs['gen_ai.system_instructions'] as string),
    ).toEqual([{ type: 'text', content: 'system' }]);
    expect(
      JSON.parse(target.attrs['gen_ai.tool.definitions'] as string),
    ).toEqual([{ type: 'function', name: 'read' }]);
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'answer' }],
        finish_reason: 'stop',
      },
    ]);
    expect(target.attrs['gen_ai.tool.call.arguments']).toBe('{"path":"a"}');
    expect(target.attrs['gen_ai.tool.call.result']).toBe('{"output":"ok"}');
    expect(Object.keys(target.attrs)).not.toEqual(
      expect.arrayContaining([
        'system_prompt',
        'tools',
        'response.model_output',
        'tool_input',
        'tool_result',
      ]),
    );
  });

  it('retains an explicit finish reason across later incomplete chunks', () => {
    const target = span();
    const capture = new AgentOutputMessageCapture(config());
    capture.beginResponse();
    capture.appendText('answer');
    capture.observeFinishReason('STOP');
    capture.observeFinishReason(undefined);
    capture.observeFinishReason('FINISH_REASON_UNSPECIFIED');
    capture.commitResponse(false);
    capture.writeToSpan(target);
    expect(
      JSON.parse(target.attrs['gen_ai.output.messages'] as string),
    ).toMatchObject([{ finish_reason: 'stop' }]);
  });

  it('does not synthesize output without a finish reason', () => {
    const target = span();
    addModelOutputAttributes(config(), target, 'answer');
    expect(target.attrs['gen_ai.output.messages']).toBeUndefined();
  });

  it('requires object roots for tool arguments and results', () => {
    const target = span();
    addToolArgumentsAttributes(config(), target, []);
    addToolCallResultAttributes(config(), target, 'result');
    expect(target.attrs['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(target.attrs['gen_ai.tool.call.result']).toBeUndefined();
  });

  it('preserves empty tool objects', () => {
    const target = span();
    addToolArgumentsAttributes(config(), target, {});
    addToolCallResultAttributes(config(), target, {});
    expect(target.attrs['gen_ai.tool.call.arguments']).toBe('{}');
    expect(target.attrs['gen_ai.tool.call.result']).toBe('{}');
  });

  it('omits complete JSON attributes that exceed the configured limit', () => {
    mockState.maxLength = 5;
    const target = span();
    addToolArgumentsAttributes(config(), target, { value: 'too long' });
    expect(target.attrs['gen_ai.tool.call.arguments']).toBeUndefined();
  });

  it('omits cyclic values without affecting the caller', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    const target = span();
    expect(() =>
      addToolArgumentsAttributes(config(), target, value),
    ).not.toThrow();
    expect(target.attrs['gen_ai.tool.call.arguments']).toBeUndefined();
  });

  it('does not let serializer or Span API failures affect the caller', () => {
    const uninspectable = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('cannot inspect');
        },
      },
    );
    const target = span();
    target.setAttribute = () => {
      throw new Error('cannot set');
    };

    expect(() =>
      addToolArgumentsAttributes(config(), target, uninspectable),
    ).not.toThrow();
    expect(() =>
      addToolCallResultAttributes(config(), target, { output: 'ok' }),
    ).not.toThrow();
  });

  it('honors the sensitive-data switch and SDK state', () => {
    const target = span();
    mockState.sensitiveEnabled = false;
    addToolArgumentsAttributes(config(), target, { secret: true });
    mockState.sensitiveEnabled = true;
    mockState.sdkInitialized = false;
    addToolCallResultAttributes(config(), target, { secret: true });
    expect(target.attrs).toEqual({});
  });

  it('keeps the old state reset export as a no-op', () => {
    expect(() => clearDetailedSpanState()).not.toThrow();
  });
});
