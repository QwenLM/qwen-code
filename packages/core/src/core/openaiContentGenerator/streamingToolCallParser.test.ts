/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolCallParseResult } from './streamingToolCallParser.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';

describe('StreamingToolCallParser', () => {
  let parser: StreamingToolCallParser;

  beforeEach(() => {
    parser = new StreamingToolCallParser();
  });

  describe('Basic functionality', () => {
    it('should initialize with empty state', () => {
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual({
        depth: 0,
        inString: false,
        escape: false,
      });
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should handle simple complete JSON in single chunk', () => {
      const result = parser.addChunk(
        0,
        '{"key": "value"}',
        'call_1',
        'test_function',
      );

      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ key: 'value' });
      expect(result.error).toBeUndefined();
      expect(result.repaired).toBeUndefined();
    });

    it('should accumulate chunks until complete JSON', () => {
      let result = parser.addChunk(0, '{"key":', 'call_1', 'test_function');
      expect(result.complete).toBe(false);

      result = parser.addChunk(0, ' "val');
      expect(result.complete).toBe(false);

      result = parser.addChunk(0, 'ue"}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ key: 'value' });
    });

    it('should handle empty chunks gracefully', () => {
      const result = parser.addChunk(0, '', 'call_1', 'test_function');
      expect(result.complete).toBe(false);
      expect(parser.getBuffer(0)).toBe('');
    });
  });

  describe('JSON depth tracking', () => {
    it('should track nested objects correctly', () => {
      let result = parser.addChunk(
        0,
        '{"outer": {"inner":',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(parser.getState(0).depth).toBe(2);

      result = parser.addChunk(0, ' "value"}}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ outer: { inner: 'value' } });
    });

    it('should track nested arrays correctly', () => {
      let result = parser.addChunk(
        0,
        '{"arr": [1, [2,',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      // Depth: { (1) + [ (2) + [ (3) = 3
      expect(parser.getState(0).depth).toBe(3);

      result = parser.addChunk(0, ' 3]]}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ arr: [1, [2, 3]] });
    });

    it('should handle mixed nested structures', () => {
      let result = parser.addChunk(
        0,
        '{"obj": {"arr": [{"nested":',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      // Depth: { (1) + { (2) + [ (3) + { (4) = 4
      expect(parser.getState(0).depth).toBe(4);

      result = parser.addChunk(0, ' true}]}}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ obj: { arr: [{ nested: true }] } });
    });
  });

  describe('String handling', () => {
    it('should handle strings with special characters', () => {
      const result = parser.addChunk(
        0,
        '{"text": "Hello, \\"World\\"!"}',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ text: 'Hello, "World"!' });
    });

    it('should handle strings with braces and brackets', () => {
      const result = parser.addChunk(
        0,
        '{"code": "if (x) { return [1, 2]; }"}',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ code: 'if (x) { return [1, 2]; }' });
    });

    it('should track string boundaries correctly across chunks', () => {
      let result = parser.addChunk(
        0,
        '{"text": "Hello',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(parser.getState(0).inString).toBe(true);

      result = parser.addChunk(0, ' World"}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ text: 'Hello World' });
    });

    it('should handle escaped quotes in strings', () => {
      let result = parser.addChunk(
        0,
        '{"text": "Say \\"Hello',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(parser.getState(0).inString).toBe(true);

      result = parser.addChunk(0, '\\" to me"}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ text: 'Say "Hello" to me' });
    });

    it('should handle backslash escapes correctly', () => {
      const result = parser.addChunk(
        0,
        '{"path": "C:\\\\Users\\\\test"}',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ path: 'C:\\Users\\test' });
    });
  });

  describe('Error handling and repair', () => {
    it('should return error for malformed JSON at depth 0', () => {
      const result = parser.addChunk(
        0,
        '{"key": invalid}',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should auto-repair unclosed strings', () => {
      // Test the repair functionality in getCompletedToolCalls instead
      // since that's where repair is actually used in practice
      parser.addChunk(0, '{"text": "unclosed', 'call_1', 'test_function');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].args).toEqual({ text: 'unclosed' });
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = parser.addChunk(
        0,
        '{"obj": {"text": "unclosed',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
    });

    it('should handle repair failure gracefully', () => {
      // Create a case where even repair fails - malformed JSON at depth 0
      const result = parser.addChunk(
        0,
        'invalid json',
        'call_1',
        'test_function',
      );
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });
  });

  describe('Multiple tool calls', () => {
    it('should handle multiple tool calls with different indices', () => {
      const result1 = parser.addChunk(
        0,
        '{"param1": "value1"}',
        'call_1',
        'function1',
      );
      const result2 = parser.addChunk(
        1,
        '{"param2": "value2"}',
        'call_2',
        'function2',
      );

      expect(result1.complete).toBe(true);
      expect(result1.value).toEqual({ param1: 'value1' });
      expect(result2.complete).toBe(true);
      expect(result2.value).toEqual({ param2: 'value2' });

      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_1',
        name: 'function1',
      });
      expect(parser.getToolCallMeta(1)).toEqual({
        id: 'call_2',
        name: 'function2',
      });
    });

    it('should handle interleaved chunks from multiple tool calls', () => {
      let result1 = parser.addChunk(0, '{"param1":', 'call_1', 'function1');
      let result2 = parser.addChunk(1, '{"param2":', 'call_2', 'function2');

      expect(result1.complete).toBe(false);
      expect(result2.complete).toBe(false);

      result1 = parser.addChunk(0, ' "value1"}');
      result2 = parser.addChunk(1, ' "value2"}');

      expect(result1.complete).toBe(true);
      expect(result1.value).toEqual({ param1: 'value1' });
      expect(result2.complete).toBe(true);
      expect(result2.value).toEqual({ param2: 'value2' });
    });

    it('should maintain separate state for each index', () => {
      parser.addChunk(0, '{"nested": {"deep":', 'call_1', 'function1');
      parser.addChunk(1, '{"simple":', 'call_2', 'function2');

      expect(parser.getState(0).depth).toBe(2);
      expect(parser.getState(1).depth).toBe(1);

      const result1 = parser.addChunk(0, ' "value"}}');
      const result2 = parser.addChunk(1, ' "value"}');

      expect(result1.complete).toBe(true);
      expect(result2.complete).toBe(true);
    });
  });

  describe('Tool call metadata handling', () => {
    it('should store and retrieve tool call metadata', () => {
      parser.addChunk(0, '{"param": "value"}', 'call_123', 'my_function');

      const meta = parser.getToolCallMeta(0);
      expect(meta.id).toBe('call_123');
      expect(meta.name).toBe('my_function');
    });

    it('should handle metadata-only chunks', () => {
      const result = parser.addChunk(0, '', 'call_123', 'my_function');
      expect(result.complete).toBe(false);

      const meta = parser.getToolCallMeta(0);
      expect(meta.id).toBe('call_123');
      expect(meta.name).toBe('my_function');
    });

    it('should update metadata incrementally', () => {
      parser.addChunk(0, '', 'call_123');
      expect(parser.getToolCallMeta(0).id).toBe('call_123');
      expect(parser.getToolCallMeta(0).name).toBeUndefined();

      parser.addChunk(0, '{"param":', undefined, 'my_function');
      expect(parser.getToolCallMeta(0).id).toBe('call_123');
      expect(parser.getToolCallMeta(0).name).toBe('my_function');
    });

    it('should detect new tool call with same index and reassign to new index', () => {
      // First tool call
      const result1 = parser.addChunk(
        0,
        '{"param1": "value1"}',
        'call_1',
        'function1',
      );
      expect(result1.complete).toBe(true);

      // New tool call with same index but different ID should get reassigned to new index
      const result2 = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result2.complete).toBe(false);

      // The original index 0 should still have the first tool call
      expect(parser.getBuffer(0)).toBe('{"param1": "value1"}');
      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_1',
        name: 'function1',
      });

      // The new tool call should be at a different index (1)
      expect(parser.getBuffer(1)).toBe('{"param2":');
      expect(parser.getToolCallMeta(1)).toEqual({
        id: 'call_2',
        name: 'function2',
      });
    });
  });

  describe('Completed tool calls', () => {
    it('should return completed tool calls', () => {
      parser.addChunk(0, '{"param1": "value1"}', 'call_1', 'function1');
      parser.addChunk(1, '{"param2": "value2"}', 'call_2', 'function2');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);

      expect(completed[0]).toEqual({
        id: 'call_1',
        name: 'function1',
        args: { param1: 'value1' },
        index: 0,
      });

      expect(completed[1]).toEqual({
        id: 'call_2',
        name: 'function2',
        args: { param2: 'value2' },
        index: 1,
      });
    });

    it('should handle completed tool calls with repair', () => {
      parser.addChunk(0, '{"text": "unclosed', 'call_1', 'function1');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].args).toEqual({ text: 'unclosed' });
    });

    it('should use safeJsonParse as fallback for malformed JSON', () => {
      // Simulate a case where JSON.parse fails but jsonrepair can fix it
      parser.addChunk(
        0,
        '{"valid": "data", "invalid": }',
        'call_1',
        'function1',
      );

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      // jsonrepair should fix the malformed JSON by setting invalid to null
      expect(completed[0].args).toEqual({ valid: 'data', invalid: null });
    });

    it('should not return tool calls without function name', () => {
      parser.addChunk(0, '{"param": "value"}', 'call_1'); // No function name

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(0);
    });

    it('should not return tool calls with empty buffer', () => {
      parser.addChunk(0, '', 'call_1', 'function1'); // Empty buffer

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle very large JSON objects', () => {
      const largeObject = { data: 'x'.repeat(10000) };
      const jsonString = JSON.stringify(largeObject);

      const result = parser.addChunk(0, jsonString, 'call_1', 'function1');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual(largeObject);
    });

    it('should handle deeply nested structures', () => {
      let nested: unknown = 'value';
      for (let i = 0; i < 100; i++) {
        nested = { level: nested };
      }

      const jsonString = JSON.stringify(nested);
      const result = parser.addChunk(0, jsonString, 'call_1', 'function1');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual(nested);
    });

    it('should handle JSON with unicode characters', () => {
      const result = parser.addChunk(
        0,
        '{"emoji": "🚀", "chinese": "你好"}',
        'call_1',
        'function1',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ emoji: '🚀', chinese: '你好' });
    });

    it('should handle JSON with null and boolean values', () => {
      const result = parser.addChunk(
        0,
        '{"null": null, "bool": true, "false": false}',
        'call_1',
        'function1',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ null: null, bool: true, false: false });
    });

    it('should handle JSON with numbers', () => {
      const result = parser.addChunk(
        0,
        '{"int": 42, "float": 3.14, "negative": -1, "exp": 1e5}',
        'call_1',
        'function1',
      );
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({
        int: 42,
        float: 3.14,
        negative: -1,
        exp: 1e5,
      });
    });

    it('should handle whitespace-only chunks', () => {
      let result = parser.addChunk(0, '  \n\t  ', 'call_1', 'function1');
      expect(result.complete).toBe(false);

      result = parser.addChunk(0, '{"key": "value"}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ key: 'value' });
    });

    it('should handle chunks with only structural characters', () => {
      let result = parser.addChunk(0, '{', 'call_1', 'function1');
      expect(result.complete).toBe(false);
      expect(parser.getState(0).depth).toBe(1);

      result = parser.addChunk(0, '}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({});
    });
  });

  describe('Real-world streaming scenarios', () => {
    it('should handle typical OpenAI streaming pattern', () => {
      // Simulate how OpenAI typically streams tool call arguments
      const chunks = [
        '{"',
        'query',
        '": "',
        'What is',
        ' the weather',
        ' in Paris',
        '?"}',
      ];

      let result: ToolCallParseResult = { complete: false };
      for (let i = 0; i < chunks.length; i++) {
        result = parser.addChunk(
          0,
          chunks[i],
          i === 0 ? 'call_1' : undefined,
          i === 0 ? 'get_weather' : undefined,
        );
        if (i < chunks.length - 1) {
          expect(result.complete).toBe(false);
        }
      }

      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ query: 'What is the weather in Paris?' });
    });

    it('should handle multiple concurrent tool calls streaming', () => {
      // Simulate multiple tool calls being streamed simultaneously
      parser.addChunk(0, '{"location":', 'call_1', 'get_weather');
      parser.addChunk(1, '{"query":', 'call_2', 'search_web');
      parser.addChunk(0, ' "New York"}');

      const result1 = parser.addChunk(1, ' "OpenAI GPT"}');

      expect(result1.complete).toBe(true);
      expect(result1.value).toEqual({ query: 'OpenAI GPT' });

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expect(completed.find((tc) => tc.name === 'get_weather')?.args).toEqual({
        location: 'New York',
      });
      expect(completed.find((tc) => tc.name === 'search_web')?.args).toEqual({
        query: 'OpenAI GPT',
      });
    });

    it('should handle malformed streaming that gets repaired', () => {
      // Simulate a stream that gets cut off mid-string
      parser.addChunk(0, '{"message": "Hello world', 'call_1', 'send_message');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].args).toEqual({ message: 'Hello world' });
    });
  });

  describe('Tool call ID collision detection and mapping', () => {
    it('should handle tool call ID reuse correctly', () => {
      // First tool call with ID 'call_1' at index 0
      const result1 = parser.addChunk(
        0,
        '{"param1": "value1"}',
        'call_1',
        'function1',
      );
      expect(result1.complete).toBe(true);

      // Second tool call with same ID 'call_1' should reuse the same internal index
      // and append to the buffer (this is the actual behavior)
      const result2 = parser.addChunk(
        0,
        '{"param2": "value2"}',
        'call_1',
        'function2',
      );
      expect(result2.complete).toBe(false); // Not complete because buffer is malformed

      // Should have updated the metadata but appended to buffer
      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_1',
        name: 'function2',
      });
      expect(parser.getBuffer(0)).toBe(
        '{"param1": "value1"}{"param2": "value2"}',
      );
    });

    it('should detect index collision and find new index', () => {
      // First complete tool call at index 0
      parser.addChunk(0, '{"param1": "value1"}', 'call_1', 'function1');

      // New tool call with different ID but same index should get reassigned
      const result = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result.complete).toBe(false);

      // Complete the second tool call
      const result2 = parser.addChunk(0, ' "value2"}');
      expect(result2.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);

      // Should have both tool calls with different IDs
      const call1 = completed.find((tc) => tc.id === 'call_1');
      const call2 = completed.find((tc) => tc.id === 'call_2');
      expect(call1).toBeDefined();
      expect(call2).toBeDefined();
      expect(call1?.args).toEqual({ param1: 'value1' });
      expect(call2?.args).toEqual({ param2: 'value2' });
    });

    it('should handle continuation chunks without ID correctly', () => {
      // Start a tool call
      parser.addChunk(0, '{"param":', 'call_1', 'function1');

      // Add continuation chunk without ID
      const result = parser.addChunk(0, ' "value"}');
      expect(result.complete).toBe(true);
      expect(result.value).toEqual({ param: 'value' });

      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_1',
        name: 'function1',
      });
    });

    it('should find most recent incomplete tool call for continuation chunks', () => {
      // Start multiple tool calls
      parser.addChunk(0, '{"param1": "complete"}', 'call_1', 'function1');
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');
      parser.addChunk(2, '{"param3":', 'call_3', 'function3');

      // Add continuation chunk without ID at index 1 - should continue the incomplete tool call at index 1
      const result = parser.addChunk(1, ' "continuation"}');
      expect(result.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      const call2 = completed.find((tc) => tc.id === 'call_2');
      expect(call2?.args).toEqual({ param2: 'continuation' });
    });
  });

  describe('Index management and reset functionality', () => {
    it('should reset individual index correctly', () => {
      // Set up some state at index 0
      parser.addChunk(0, '{"partial":', 'call_1', 'function1');
      expect(parser.getBuffer(0)).toBe('{"partial":');
      expect(parser.getState(0).depth).toBe(1);
      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_1',
        name: 'function1',
      });

      // Reset the index
      parser.resetIndex(0);

      // Verify everything is cleared
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual({
        depth: 0,
        inString: false,
        escape: false,
      });
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should find next available index when all lower indices are occupied', () => {
      // Fill up indices 0, 1, 2 with complete tool calls
      parser.addChunk(0, '{"param0": "value0"}', 'call_0', 'function0');
      parser.addChunk(1, '{"param1": "value1"}', 'call_1', 'function1');
      parser.addChunk(2, '{"param2": "value2"}', 'call_2', 'function2');

      // New tool call should get assigned to index 3
      const result = parser.addChunk(
        0,
        '{"param3": "value3"}',
        'call_3',
        'function3',
      );
      expect(result.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(4);

      // Verify the new tool call got a different index
      const call3 = completed.find((tc) => tc.id === 'call_3');
      expect(call3).toBeDefined();
      expect(call3?.index).toBe(3);
    });

    it('should reuse incomplete index when available', () => {
      // Create an incomplete tool call at index 0
      parser.addChunk(0, '{"incomplete":', 'call_1', 'function1');

      // New tool call with different ID should reuse the incomplete index
      const result = parser.addChunk(0, ' "completed"}', 'call_2', 'function2');
      expect(result.complete).toBe(true);

      // Should have updated the metadata for the same index
      expect(parser.getToolCallMeta(0)).toEqual({
        id: 'call_2',
        name: 'function2',
      });
    });
  });

  describe('Repair functionality and flags', () => {
    it('should test repair functionality in getCompletedToolCalls', () => {
      // The repair functionality is primarily used in getCompletedToolCalls, not addChunk
      parser.addChunk(0, '{"message": "unclosed string', 'call_1', 'function1');

      // The addChunk should not complete because depth > 0 and inString = true
      expect(parser.getState(0).depth).toBe(1);
      expect(parser.getState(0).inString).toBe(true);

      // But getCompletedToolCalls should repair it
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].args).toEqual({ message: 'unclosed string' });
    });

    it('should not set repaired flag for normal parsing', () => {
      const result = parser.addChunk(
        0,
        '{"message": "normal"}',
        'call_1',
        'function1',
      );

      expect(result.complete).toBe(true);
      expect(result.repaired).toBeUndefined();
      expect(result.value).toEqual({ message: 'normal' });
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = parser.addChunk(
        0,
        '{"nested": {"unclosed": "string',
        'call_1',
        'function1',
      );

      // Should not attempt repair because depth > 0
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
      expect(parser.getState(0).depth).toBe(2);
    });

    it('should handle repair failure gracefully', () => {
      // Create malformed JSON that can't be repaired at depth 0
      const result = parser.addChunk(
        0,
        '{invalid: json}',
        'call_1',
        'function1',
      );

      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.repaired).toBeUndefined();
    });
  });

  describe('Complex collision scenarios', () => {
    it('should handle rapid tool call switching at same index', () => {
      // Rapid switching between different tool calls at index 0
      parser.addChunk(0, '{"step1":', 'call_1', 'function1');
      parser.addChunk(0, ' "done"}', 'call_1', 'function1');

      // New tool call immediately at same index
      parser.addChunk(0, '{"step2":', 'call_2', 'function2');
      parser.addChunk(0, ' "done"}', 'call_2', 'function2');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);

      const call1 = completed.find((tc) => tc.id === 'call_1');
      const call2 = completed.find((tc) => tc.id === 'call_2');
      expect(call1?.args).toEqual({ step1: 'done' });
      expect(call2?.args).toEqual({ step2: 'done' });
    });

    it('should handle interleaved chunks from multiple tool calls with ID mapping', () => {
      // Start tool call 1 at index 0
      parser.addChunk(0, '{"param1":', 'call_1', 'function1');

      // Start tool call 2 at index 1 (different index to avoid collision)
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');

      // Continue tool call 1 at its index
      const result1 = parser.addChunk(0, ' "value1"}');
      expect(result1.complete).toBe(true);

      // Continue tool call 2 at its index
      const result2 = parser.addChunk(1, ' "value2"}');
      expect(result2.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);

      const call1 = completed.find((tc) => tc.id === 'call_1');
      const call2 = completed.find((tc) => tc.id === 'call_2');
      expect(call1?.args).toEqual({ param1: 'value1' });
      expect(call2?.args).toEqual({ param2: 'value2' });
    });
  });
});
