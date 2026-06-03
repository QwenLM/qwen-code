/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Span, Attributes, SpanContext } from '@opentelemetry/api';

const mockState = vi.hoisted(() => ({
  sdkInitialized: true,
  sensitiveEnabled: true,
}));

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => mockState.sdkInitialized,
}));

import type { Config } from '../config/config.js';
import {
  truncateContent,
  addUserPromptAttributes,
  addSystemPromptAttributes,
  addToolSchemaAttributes,
  addModelOutputAttributes,
  addToolInputAttributes,
  addToolResultAttributes,
  clearDetailedSpanState,
} from './detailed-span-attributes.js';

function createMockConfig(): Config {
  return {
    getTelemetryIncludeSensitiveSpanAttributes: () =>
      mockState.sensitiveEnabled,
  } as unknown as Config;
}

interface MockSpan extends Span {
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
}

function createMockSpan(): MockSpan {
  const attrs: Record<string, unknown> = {};
  const events: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  return {
    attrs,
    events,
    setAttributes(a: Attributes) {
      Object.assign(attrs, a);
      return this;
    },
    setAttribute(key: string, value: unknown) {
      attrs[key] = value;
      return this;
    },
    addEvent(name: string, eventAttrs?: Attributes) {
      events.push({
        name,
        attributes: (eventAttrs ?? {}) as Record<string, unknown>,
      });
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

describe('detailed-span-attributes', () => {
  beforeEach(() => {
    mockState.sdkInitialized = true;
    mockState.sensitiveEnabled = true;
    clearDetailedSpanState();
  });

  describe('truncateContent', () => {
    it('returns content as-is when under limit', () => {
      const result = truncateContent('hello');
      expect(result.content).toBe('hello');
      expect(result.truncated).toBe(false);
    });

    it('truncates content over limit', () => {
      const result = truncateContent('x'.repeat(100), 50);
      expect(result.content.length).toBeLessThanOrEqual(100);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[TRUNCATED');
    });

    it('truncates at default 60KB limit', () => {
      const largeContent = 'a'.repeat(70_000);
      const result = truncateContent(largeContent);
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(largeContent.length);
    });
  });

  describe('addUserPromptAttributes', () => {
    it('sets new_context with user prompt prefix', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addUserPromptAttributes(config, span, 'Hello world');

      expect(span.attrs['new_context']).toBe('[USER PROMPT]\nHello world');
    });

    it('no-ops when flag is disabled', () => {
      mockState.sensitiveEnabled = false;
      const config = createMockConfig();
      const span = createMockSpan();
      addUserPromptAttributes(config, span, 'Hello world');

      expect(span.attrs['new_context']).toBeUndefined();
    });

    it('no-ops when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const config = createMockConfig();
      const span = createMockSpan();
      addUserPromptAttributes(config, span, 'Hello world');

      expect(span.attrs['new_context']).toBeUndefined();
    });

    it('no-ops when promptText is empty', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addUserPromptAttributes(config, span, '');

      expect(span.attrs['new_context']).toBeUndefined();
    });

    it('sets truncation attributes for large content', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const largePrompt = 'x'.repeat(70_000);
      addUserPromptAttributes(config, span, largePrompt);

      expect(span.attrs['new_context_truncated']).toBe(true);
      expect(span.attrs['new_context_original_length']).toBe(70_000);
    });
  });

  describe('addSystemPromptAttributes', () => {
    it('sets hash, preview, and length', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addSystemPromptAttributes(config, span, 'System prompt content');

      expect(span.attrs['system_prompt_hash']).toMatch(/^sp_[a-f0-9]{12}$/);
      expect(span.attrs['system_prompt_preview']).toBe('System prompt content');
      expect(span.attrs['system_prompt_length']).toBe(21);
      expect(span.attrs['system_prompt']).toBe('System prompt content');
    });

    it('deduplicates full content on same hash', () => {
      const config = createMockConfig();
      const span1 = createMockSpan();
      const span2 = createMockSpan();

      addSystemPromptAttributes(config, span1, 'Same prompt');
      addSystemPromptAttributes(config, span2, 'Same prompt');

      expect(span1.attrs['system_prompt']).toBe('Same prompt');
      expect(span2.attrs['system_prompt']).toBeUndefined();
      expect(span2.attrs['system_prompt_hash']).toBeDefined();
    });

    it('handles non-string systemInstruction', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addSystemPromptAttributes(config, span, { text: 'obj prompt' });

      expect(span.attrs['system_prompt_hash']).toMatch(/^sp_/);
      expect(span.attrs['system_prompt_length']).toBeGreaterThan(0);
    });

    it('sets system_prompt_truncated for large content', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const largePrompt = 'p'.repeat(70_000);
      addSystemPromptAttributes(config, span, largePrompt);

      expect(span.attrs['system_prompt_truncated']).toBe(true);
      expect(span.attrs['system_prompt_length']).toBe(70_000);
    });

    it('no-ops when flag is disabled', () => {
      mockState.sensitiveEnabled = false;
      const config = createMockConfig();
      const span = createMockSpan();
      addSystemPromptAttributes(config, span, 'prompt');

      expect(span.attrs['system_prompt_hash']).toBeUndefined();
    });
  });

  describe('addToolSchemaAttributes', () => {
    it('sets tools summary and count', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const tools = [
        { name: 'Read', description: 'Read a file' },
        { name: 'Bash', description: 'Execute command' },
      ];

      addToolSchemaAttributes(config, span, tools);

      expect(span.attrs['tools_count']).toBe(2);
      const toolsSummary = JSON.parse(span.attrs['tools'] as string);
      expect(toolsSummary).toHaveLength(2);
      expect(toolsSummary[0].name).toBe('Read');
      expect(toolsSummary[1].name).toBe('Bash');
    });

    it('emits tool_schema events for first occurrence', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const tools = [{ name: 'Read', description: 'Read a file' }];

      addToolSchemaAttributes(config, span, tools);

      expect(span.events).toHaveLength(1);
      expect(span.events[0]!.name).toBe('tool_schema');
      expect(span.events[0]!.attributes['tool_name']).toBe('Read');
    });

    it('deduplicates tool schema events', () => {
      const config = createMockConfig();
      const span1 = createMockSpan();
      const span2 = createMockSpan();
      const tools = [{ name: 'Read', description: 'Read a file' }];

      addToolSchemaAttributes(config, span1, tools);
      addToolSchemaAttributes(config, span2, tools);

      expect(span1.events).toHaveLength(1);
      expect(span2.events).toHaveLength(0);
    });

    it('falls back to unknown_tool when tool has no name', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addToolSchemaAttributes(config, span, [{ description: 'no name field' }]);

      expect(span.events).toHaveLength(1);
      expect(span.events[0]!.attributes['tool_name']).toBe('unknown_tool');
      const toolsSummary = JSON.parse(span.attrs['tools'] as string);
      expect(toolsSummary[0].name).toBe('unknown_tool');
    });

    it('flattens functionDeclarations wrapper (Gemini API shape)', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const tools = [
        {
          functionDeclarations: [
            { name: 'Read', description: 'Read a file' },
            { name: 'Bash', description: 'Execute command' },
          ],
        },
      ];

      addToolSchemaAttributes(config, span, tools);

      expect(span.attrs['tools_count']).toBe(2);
      const toolsSummary = JSON.parse(span.attrs['tools'] as string);
      expect(toolsSummary.map((t: { name: string }) => t.name)).toEqual([
        'Read',
        'Bash',
      ]);
      expect(span.events).toHaveLength(2);
      expect(span.events[0]!.attributes['tool_name']).toBe('Read');
      expect(span.events[1]!.attributes['tool_name']).toBe('Bash');
    });

    it('no-ops on empty tools array', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addToolSchemaAttributes(config, span, []);

      expect(span.attrs['tools_count']).toBeUndefined();
    });

    it('no-ops on undefined tools', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addToolSchemaAttributes(config, span, undefined);

      expect(span.attrs['tools_count']).toBeUndefined();
    });
  });

  describe('addModelOutputAttributes', () => {
    it('sets response.model_output', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addModelOutputAttributes(config, span, 'Model says hello');

      expect(span.attrs['response.model_output']).toBe('Model says hello');
    });

    it('sets truncation attributes for large output', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const largeOutput = 'y'.repeat(70_000);
      addModelOutputAttributes(config, span, largeOutput);

      expect(span.attrs['response.model_output_truncated']).toBe(true);
      expect(span.attrs['response.model_output_original_length']).toBe(70_000);
    });

    it('no-ops when responseText is undefined', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addModelOutputAttributes(config, span, undefined);

      expect(span.attrs['response.model_output']).toBeUndefined();
    });
  });

  describe('addToolInputAttributes', () => {
    it('sets tool_input with prefix', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addToolInputAttributes(config, span, 'Bash', '{"command":"ls"}');

      expect(span.attrs['tool_input']).toBe(
        '[TOOL INPUT: Bash]\n{"command":"ls"}',
      );
    });

    it('no-ops when flag is disabled', () => {
      mockState.sensitiveEnabled = false;
      const config = createMockConfig();
      const span = createMockSpan();
      addToolInputAttributes(config, span, 'Bash', '{"command":"ls"}');

      expect(span.attrs['tool_input']).toBeUndefined();
    });
  });

  describe('addToolResultAttributes', () => {
    it('sets tool_result with prefix', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      addToolResultAttributes(config, span, 'Read', 'file contents here');

      expect(span.attrs['tool_result']).toBe(
        '[TOOL RESULT: Read]\nfile contents here',
      );
    });

    it('sets truncation attributes for large result', () => {
      const config = createMockConfig();
      const span = createMockSpan();
      const largeResult = 'z'.repeat(70_000);
      addToolResultAttributes(config, span, 'Read', largeResult);

      expect(span.attrs['tool_result_truncated']).toBe(true);
      expect(span.attrs['tool_result_original_length']).toBe(70_000);
    });
  });

  describe('clearDetailedSpanState', () => {
    it('resets seenHashes so system prompt is emitted again', () => {
      const config = createMockConfig();
      const span1 = createMockSpan();
      addSystemPromptAttributes(config, span1, 'Same prompt');
      expect(span1.attrs['system_prompt']).toBe('Same prompt');

      clearDetailedSpanState();

      const span2 = createMockSpan();
      addSystemPromptAttributes(config, span2, 'Same prompt');
      expect(span2.attrs['system_prompt']).toBe('Same prompt');
    });

    it('resets seenHashes so tool schema full body is re-emitted after compression', () => {
      const config = createMockConfig();
      const tools = [
        { name: 'Read', description: 'Read a file', parameters: {} },
      ];

      const span1 = createMockSpan();
      addToolSchemaAttributes(config, span1, tools);
      expect(span1.events.length).toBe(1);
      expect(span1.events[0]!.attributes['tool_definition']).toBeDefined();

      const span2 = createMockSpan();
      addToolSchemaAttributes(config, span2, tools);
      expect(span2.events.length).toBe(0);

      clearDetailedSpanState();

      const span3 = createMockSpan();
      addToolSchemaAttributes(config, span3, tools);
      expect(span3.events.length).toBe(1);
      expect(span3.events[0]!.attributes['tool_definition']).toBeDefined();
    });
  });
});
