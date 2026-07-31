/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attributes, Span, SpanContext } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  addModelOutputAttributes,
  addSystemPromptAttributes,
  addToolArgumentsAttributes,
  addToolCallResultAttributes,
  addToolInputAttributes,
  addToolResultAttributes,
  addToolSchemaAttributes,
  addUserPromptAttributes,
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
