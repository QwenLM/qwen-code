/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolCallParseResult } from './streamingToolCallParser.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';

type ParserState = ReturnType<StreamingToolCallParser['getState']>;
type CompletedCalls = ReturnType<
  StreamingToolCallParser['getCompletedToolCalls']
>;

const EMPTY_STATE = { depth: 0, inString: false, escape: false };

/** A completed call as getCompletedToolCalls emits it. */
const toolCall = (
  id: string | undefined,
  name: string,
  args: Record<string, unknown>,
  index: number | undefined,
) => ({ id, name, args, index });

const argsOf = (completed: CompletedCalls, id: string) =>
  completed.find((tc) => tc.id === id)?.args;

describe('StreamingToolCallParser', () => {
  let parser: StreamingToolCallParser;

  beforeEach(() => {
    parser = new StreamingToolCallParser();
  });

  /** Adds `text` at index 0 as call_1 named `name`. */
  const openCall1 = (text: string, name: string) =>
    parser.addChunk(0, text, 'call_1', name);

  /**
   * Streams one call at index 0: `openCall1` with the first chunk, then
   * id-less chunks. Asserts it stays incomplete until the last chunk and,
   * when given, that the state after the first chunk matches `midState`.
   */
  const stream = (
    chunks: string[],
    name: string,
    midState?: Partial<ParserState>,
  ) => {
    const [head, ...tail] = chunks;
    let result = openCall1(head, name);
    if (midState) expect(parser.getState(0)).toMatchObject(midState);
    for (const chunk of tail) {
      expect(result.complete).toBe(false);
      result = parser.addChunk(0, chunk);
    }
    return result;
  };

  const expectComplete = (result: ToolCallParseResult, value: unknown) => {
    expect(result.complete).toBe(true);
    expect(result.value).toEqual(value);
  };

  const expectMeta = (index: number, id: string, name: string) =>
    expect(parser.getToolCallMeta(index)).toEqual({ id, name });

  const expectCalls = (...calls: Array<ReturnType<typeof toolCall>>) =>
    expect(parser.getCompletedToolCalls()).toEqual(calls);

  /** Asserts exactly one call completed, holding `args`. */
  const expectSingleCallArgs = (args: Record<string, unknown>) => {
    const completed = parser.getCompletedToolCalls();
    expect(completed).toHaveLength(1);
    expect(completed[0].args).toEqual(args);
  };

  describe('Basic functionality', () => {
    it('should initialize with empty state', () => {
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual(EMPTY_STATE);
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should handle simple complete JSON in single chunk', () => {
      const result = openCall1('{"key": "value"}', 'test_function');
      expectComplete(result, { key: 'value' });
      expect(result.error).toBeUndefined();
      expect(result.repaired).toBeUndefined();
    });

    it('should accumulate chunks until complete JSON', () => {
      const result = stream(['{"key":', ' "val', 'ue"}'], 'test_function');
      expectComplete(result, { key: 'value' });
    });

    it('should handle empty chunks gracefully', () => {
      expect(openCall1('', 'test_function').complete).toBe(false);
      expect(parser.getBuffer(0)).toBe('');
    });
  });

  describe('JSON depth tracking', () => {
    it('should track nested objects correctly', () => {
      const chunks = ['{"outer": {"inner":', ' "value"}}'];
      const result = stream(chunks, 'test_function', { depth: 2 });
      expectComplete(result, { outer: { inner: 'value' } });
    });

    it('should track nested arrays correctly', () => {
      // Depth: { (1) + [ (2) + [ (3) = 3
      const chunks = ['{"arr": [1, [2,', ' 3]]}'];
      const result = stream(chunks, 'test_function', { depth: 3 });
      expectComplete(result, { arr: [1, [2, 3]] });
    });

    it('should handle mixed nested structures', () => {
      // Depth: { (1) + { (2) + [ (3) + { (4) = 4
      const chunks = ['{"obj": {"arr": [{"nested":', ' true}]}}'];
      const result = stream(chunks, 'test_function', { depth: 4 });
      expectComplete(result, { obj: { arr: [{ nested: true }] } });
    });
  });

  describe('String handling', () => {
    it('should handle strings with special characters', () => {
      const chunk = '{"text": "Hello, \\"World\\"!"}';
      const result = openCall1(chunk, 'test_function');
      expectComplete(result, { text: 'Hello, "World"!' });
    });

    it('should handle strings with braces and brackets', () => {
      const chunk = '{"code": "if (x) { return [1, 2]; }"}';
      const result = openCall1(chunk, 'test_function');
      expectComplete(result, { code: 'if (x) { return [1, 2]; }' });
    });

    it('should track string boundaries correctly across chunks', () => {
      const chunks = ['{"text": "Hello', ' World"}'];
      const result = stream(chunks, 'test_function', { inString: true });
      expectComplete(result, { text: 'Hello World' });
    });

    it('should handle escaped quotes in strings', () => {
      const chunks = ['{"text": "Say \\"Hello', '\\" to me"}'];
      const result = stream(chunks, 'test_function', { inString: true });
      expectComplete(result, { text: 'Say "Hello" to me' });
    });

    it('should handle backslash escapes correctly', () => {
      const chunk = '{"path": "C:\\\\Users\\\\test"}';
      const result = openCall1(chunk, 'test_function');
      expectComplete(result, { path: 'C:\\Users\\test' });
    });
  });

  describe('Error handling and repair', () => {
    it('should return error for malformed JSON at depth 0', () => {
      const result = openCall1('{"key": invalid}', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should auto-repair unclosed strings', () => {
      // Tested via getCompletedToolCalls, where repair is used in practice.
      openCall1('{"text": "unclosed', 'test_function');
      expectSingleCallArgs({ text: 'unclosed' });
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = openCall1('{"obj": {"text": "unclosed', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
    });

    it('should handle repair failure gracefully', () => {
      // Malformed JSON at depth 0, where even repair fails.
      const result = openCall1('invalid json', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });
  });

  describe('Multiple tool calls', () => {
    it('should handle multiple tool calls with different indices', () => {
      const result1 = openCall1('{"param1": "value1"}', 'function1');
      const chunk2 = '{"param2": "value2"}';
      const result2 = parser.addChunk(1, chunk2, 'call_2', 'function2');
      expectComplete(result1, { param1: 'value1' });
      expectComplete(result2, { param2: 'value2' });
      expectMeta(0, 'call_1', 'function1');
      expectMeta(1, 'call_2', 'function2');
    });

    it('should handle interleaved chunks from multiple tool calls', () => {
      let result1 = parser.addChunk(0, '{"param1":', 'call_1', 'function1');
      let result2 = parser.addChunk(1, '{"param2":', 'call_2', 'function2');
      expect(result1.complete).toBe(false);
      expect(result2.complete).toBe(false);

      result1 = parser.addChunk(0, ' "value1"}');
      result2 = parser.addChunk(1, ' "value2"}');
      expectComplete(result1, { param1: 'value1' });
      expectComplete(result2, { param2: 'value2' });
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
    it('tracks real nameless calls but ignores phantom chunks', () => {
      parser.addChunk(0, '');
      expect(parser.hasNamelessToolCall()).toBe(false);
      parser.addChunk(0, '', 'call_1');
      expect(parser.hasNamelessToolCall()).toBe(true);
      parser.resetIndex(0);
      parser.addChunk(0, '{"path":"a.ts"}');
      expect(parser.hasNamelessToolCall()).toBe(true);
    });

    it.each([
      { index: 1, id: undefined },
      { index: 2, id: 'call_2' },
    ])(
      'accepts and deduplicates a name after complete arguments at index $index',
      ({ index, id }) => {
        parser.addChunk(index, '{"path":"a.ts"}', id);
        parser.addChunk(index, '', id, 'read_file');
        parser.addChunk(index, '', id, 'read_file');

        expect(parser.hasNamelessToolCall()).toBe(false);
        expectCalls(toolCall(id, 'read_file', { path: 'a.ts' }, index));
      },
    );

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
      const result1 = openCall1('{"param1": "value1"}', 'function1');
      expect(result1.complete).toBe(true);
      // A different ID at the same index is reassigned to a new index (1);
      // index 0 keeps the first call.
      const result2 = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result2.complete).toBe(false);
      expect(parser.getBuffer(0)).toBe('{"param1": "value1"}');
      expectMeta(0, 'call_1', 'function1');
      expect(parser.getBuffer(1)).toBe('{"param2":');
      expectMeta(1, 'call_2', 'function2');
    });
  });

  describe('Completed tool calls', () => {
    it('should return completed tool calls', () => {
      parser.addChunk(0, '{"param1": "value1"}', 'call_1', 'function1');
      parser.addChunk(1, '{"param2": "value2"}', 'call_2', 'function2');
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expect(completed[0]).toEqual(
        toolCall('call_1', 'function1', { param1: 'value1' }, 0),
      );
      expect(completed[1]).toEqual(
        toolCall('call_2', 'function2', { param2: 'value2' }, 1),
      );
    });

    it('should handle completed tool calls with repair', () => {
      openCall1('{"text": "unclosed', 'function1');
      expectSingleCallArgs({ text: 'unclosed' });
    });

    it('should use safeJsonParse as fallback for malformed JSON', () => {
      // JSON.parse fails, but jsonrepair fixes it by setting invalid to null.
      openCall1('{"valid": "data", "invalid": }', 'function1');
      expectSingleCallArgs({ valid: 'data', invalid: null });
    });

    it('should not return tool calls without function name', () => {
      parser.addChunk(0, '{"param": "value"}', 'call_1'); // No function name
      expect(parser.getCompletedToolCalls()).toHaveLength(0);
    });

    it('should return no-argument tool calls with empty args when buffer is empty', () => {
      // For tools without parameters, some providers stream `arguments: ""`
      // (or omit the field) and never send an argument fragment. The call
      // must survive with empty args, matching the non-streaming path.
      openCall1('', 'function1');
      expectCalls(toolCall('call_1', 'function1', {}, 0));
    });

    it('should return empty args for whitespace-only argument buffers', () => {
      openCall1('   ', 'function1');
      expectSingleCallArgs({});
    });

    it('should not overwrite a completed no-argument tool call when a new call reuses its index', () => {
      // A no-argument call (the provider never sends a fragment), then a
      // different ID at the same index: both must survive, the second relocated.
      parser.addChunk(0, '', 'call_1', 'no_arg_function');
      parser.addChunk(0, '{"param": "value"}', 'call_2', 'function2');
      expectCalls(
        toolCall('call_1', 'no_arg_function', {}, 0),
        toolCall('call_2', 'function2', { param: 'value' }, 1),
      );
    });

    it('should route ID-less argument fragments to a call whose opener streamed empty arguments', () => {
      // Canonical OpenAI-compatible streaming shape: the opener carries id +
      // name + `arguments: ""`, then ID-less fragments follow at the same
      // index. So mid-stream, an empty buffer with name metadata must stay
      // continuable at its own index — it is indistinguishable from a
      // completed no-argument call until stream end.
      openCall1('', 'function1');
      parser.addChunk(0, '{"x":');
      parser.addChunk(0, '1}');
      expectCalls(toolCall('call_1', 'function1', { x: 1 }, 0));
    });

    it('should emit empty args for a no-argument call polluted by a stray fragment at its index', () => {
      // If a misbehaving provider reuses a completed no-argument call's index
      // for another call's ID-less fragment, the fragment cannot be re-routed
      // (see the canonical-shape test above). The damage stays bounded: the
      // polluted buffer repairs to a non-object value, collapsed to {} at emit.
      parser.addChunk(0, '{"key":', 'call_1', 'function1');
      parser.addChunk(1, '', 'call_2', 'no_arg_function');
      parser.addChunk(1, '"value"}');
      expect(argsOf(parser.getCompletedToolCalls(), 'call_2')).toEqual({});
    });

    it('should collapse null argument buffers to empty args', () => {
      openCall1('null', 'function1');
      expect(parser.getCompletedToolCalls()[0].args).toEqual({});
    });

    it('should collapse array argument buffers to empty args', () => {
      openCall1('[1,2,3]', 'function1');
      expect(parser.getCompletedToolCalls()[0].args).toEqual({});
    });

    it('should scan past occupied no-argument slots when relocating a colliding call', () => {
      parser.addChunk(0, '', 'call_a', 'no_arg_a');
      parser.addChunk(1, '', 'call_b', 'no_arg_b');
      // Collision at index 0 must relocate past both occupied no-arg slots
      parser.addChunk(0, '{"x": 1}', 'call_c', 'fn_c');
      expectCalls(
        toolCall('call_a', 'no_arg_a', {}, 0),
        toolCall('call_b', 'no_arg_b', {}, 1),
        toolCall('call_c', 'fn_c', { x: 1 }, 2),
      );
    });

    it('should not route continuation chunks to a completed no-argument tool call', () => {
      parser.addChunk(0, '{"key":', 'call_1', 'function1'); // incomplete
      parser.addChunk(1, '', 'call_2', 'no_arg_function'); // no-arg, complete
      parser.addChunk(2, '{"x": 1}', 'call_3', 'function3'); // complete
      // An ID-less continuation arriving at a completed index must be routed
      // to the incomplete call_1, not to the no-argument call_2.
      parser.addChunk(2, '"value"}');
      expectCalls(
        toolCall('call_1', 'function1', { key: 'value' }, 0),
        toolCall('call_2', 'no_arg_function', {}, 1),
        toolCall('call_3', 'function3', { x: 1 }, 2),
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle very large JSON objects', () => {
      const largeObject = { data: 'x'.repeat(10000) };
      const result = openCall1(JSON.stringify(largeObject), 'function1');
      expectComplete(result, largeObject);
    });

    it('should handle deeply nested structures', () => {
      let nested: unknown = 'value';
      for (let i = 0; i < 100; i++) nested = { level: nested };
      const result = openCall1(JSON.stringify(nested), 'function1');
      expectComplete(result, nested);
    });

    it('should handle JSON with unicode characters', () => {
      const chunk = '{"emoji": "🚀", "chinese": "你好"}';
      const result = openCall1(chunk, 'function1');
      expectComplete(result, { emoji: '🚀', chinese: '你好' });
    });

    it('should handle JSON with null and boolean values', () => {
      const chunk = '{"null": null, "bool": true, "false": false}';
      const result = openCall1(chunk, 'function1');
      expectComplete(result, { null: null, bool: true, false: false });
    });

    it('should handle JSON with numbers', () => {
      const chunk = '{"int": 42, "float": 3.14, "negative": -1, "exp": 1e5}';
      const result = openCall1(chunk, 'function1');
      expectComplete(result, { int: 42, float: 3.14, negative: -1, exp: 1e5 });
    });

    it('should handle whitespace-only chunks', () => {
      const result = stream(['  \n\t  ', '{"key": "value"}'], 'function1');
      expectComplete(result, { key: 'value' });
    });

    it('should handle chunks with only structural characters', () => {
      const result = stream(['{', '}'], 'function1', { depth: 1 });
      expectComplete(result, {});
    });
  });

  describe('Real-world streaming scenarios', () => {
    it('should handle typical OpenAI streaming pattern', () => {
      // How OpenAI typically streams tool call arguments.
      const result = stream(
        ['{"', 'query', '": "', 'What is', ' the weather', ' in Paris', '?"}'],
        'get_weather',
      );
      expectComplete(result, { query: 'What is the weather in Paris?' });
    });

    it('should handle multiple concurrent tool calls streaming', () => {
      parser.addChunk(0, '{"location":', 'call_1', 'get_weather');
      parser.addChunk(1, '{"query":', 'call_2', 'search_web');
      parser.addChunk(0, ' "New York"}');
      const result1 = parser.addChunk(1, ' "OpenAI GPT"}');
      expectComplete(result1, { query: 'OpenAI GPT' });

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
      // A stream cut off mid-string.
      openCall1('{"message": "Hello world', 'send_message');
      expectSingleCallArgs({ message: 'Hello world' });
    });
  });

  describe('Tool call ID collision detection and mapping', () => {
    it('should ignore replay chunks after a tool call ID completes', () => {
      const result1 = openCall1('{"param1": "value1"}', 'function1');
      expect(result1.complete).toBe(true);
      // Once the ID has complete JSON, later chunks with the same ID are
      // provider replay and must not mutate the surviving call.
      const result2 = openCall1('{"param2": "value2"}', 'function2');
      expect(result2.complete).toBe(false);
      expectMeta(0, 'call_1', 'function1');
      expect(parser.getBuffer(0)).toBe('{"param1": "value1"}');
    });

    it('should ignore replayed openers for a completed no-argument tool call', () => {
      parser.addChunk(0, '', 'call_1', 'list_sessions');
      // A replay of the same ID's opener with a different name must not
      // mutate the surviving call.
      parser.addChunk(0, '', 'call_1', 'different_function');
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].name).toBe('list_sessions');
      expect(completed[0].args).toEqual({});
    });

    it('should append ID-bearing argument fragments after an empty opener', () => {
      // Some providers repeat the tool call ID on argument fragments. A
      // known-ID chunk carrying argument content is a continuation, not a
      // replay, and must not be swallowed by the replay guard.
      parser.addChunk(0, '', 'call_1', 'function1');
      parser.addChunk(0, '{"text":"hello', 'call_1');
      parser.addChunk(0, ' ', 'call_1');
      const result = parser.addChunk(0, 'world"}', 'call_1');
      expect(result.complete).toBe(true);
      expectCalls(toolCall('call_1', 'function1', { text: 'hello world' }, 0));
    });

    it('should ignore metadata-only replay chunks after a tool call ID completes', () => {
      parser.addChunk(0, '{"file_path": "a.ts"}', 'call_1', 'read_file');
      const result = parser.addChunk(0, '', 'call_1', 'shell');
      expect(result.complete).toBe(false);
      expectMeta(0, 'call_1', 'read_file');
      expectCalls(toolCall('call_1', 'read_file', { file_path: 'a.ts' }, 0));
    });

    it('should normalize a tool call name before storing it', () => {
      parser.addChunk(0, '{}', 'call_1', ' read_file ');
      expectCalls(toolCall('call_1', 'read_file', {}, 0));
    });

    it('should preserve the first non-empty name for a tool call ID', () => {
      parser.addChunk(0, '{"file_path":', 'call_1', 'read_file');
      parser.addChunk(0, '"a.ts"}', 'call_1', 'shell');
      expect(parser.getCompletedToolCalls()[0]?.name).toBe('read_file');
      expect(parser.hasConflictingToolCallIdentity()).toBe(true);
    });

    it('should detect index collision and find new index', () => {
      parser.addChunk(0, '{"param1": "value1"}', 'call_1', 'function1');
      // A different ID at the same index is reassigned, then completed.
      const result = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result.complete).toBe(false);
      const result2 = parser.addChunk(0, ' "value2"}');
      expect(result2.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      const call1 = completed.find((tc) => tc.id === 'call_1');
      const call2 = completed.find((tc) => tc.id === 'call_2');
      expect(call1).toBeDefined();
      expect(call2).toBeDefined();
      expect(call1?.args).toEqual({ param1: 'value1' });
      expect(call2?.args).toEqual({ param2: 'value2' });
      expect(parser.hasConflictingToolCallIdentity()).toBe(false);
    });

    it('should reject unsafe provider indices', () => {
      const result = parser.addChunk(Number.MAX_SAFE_INTEGER + 1, '   ');
      expect(result.error?.message).toContain('Invalid tool call index');
      expect(parser.hasInvalidToolCallIndex()).toBe(true);
      expect(parser.hasConflictingToolCallIdentity()).toBe(true);
    });

    it('should handle continuation chunks without ID correctly', () => {
      parser.addChunk(0, '{"param":', 'call_1', 'function1');
      const result = parser.addChunk(0, ' "value"}'); // no ID
      expectComplete(result, { param: 'value' });
      expectMeta(0, 'call_1', 'function1');
    });

    it('should find most recent incomplete tool call for continuation chunks', () => {
      parser.addChunk(0, '{"param1": "complete"}', 'call_1', 'function1');
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');
      parser.addChunk(2, '{"param3":', 'call_3', 'function3');
      // An ID-less continuation at index 1 continues the incomplete call there.
      const result = parser.addChunk(1, ' "continuation"}');
      expect(result.complete).toBe(true);
      const completed = parser.getCompletedToolCalls();
      expect(argsOf(completed, 'call_2')).toEqual({ param2: 'continuation' });
    });
  });

  describe('Index management and reset functionality', () => {
    it('should reset individual index correctly', () => {
      parser.addChunk(0, '{"partial":', 'call_1', 'function1');
      expect(parser.getBuffer(0)).toBe('{"partial":');
      expect(parser.getState(0).depth).toBe(1);
      expectMeta(0, 'call_1', 'function1');

      parser.resetIndex(0);
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual(EMPTY_STATE);
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should find next available index when all lower indices are occupied', () => {
      parser.addChunk(0, '{"param0": "value0"}', 'call_0', 'function0');
      parser.addChunk(1, '{"param1": "value1"}', 'call_1', 'function1');
      parser.addChunk(2, '{"param2": "value2"}', 'call_2', 'function2');
      // With indices 0-2 holding complete calls, a new one gets index 3.
      const chunk3 = '{"param3": "value3"}';
      const result = parser.addChunk(0, chunk3, 'call_3', 'function3');
      expect(result.complete).toBe(true);
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(4);
      const call3 = completed.find((tc) => tc.id === 'call_3');
      expect(call3).toBeDefined();
      expect(call3?.index).toBe(3);
    });

    it('should reuse incomplete index when available', () => {
      parser.addChunk(0, '{"incomplete":', 'call_1', 'function1');
      // A new ID reuses the incomplete index, updating its metadata.
      const result = parser.addChunk(0, ' "completed"}', 'call_2', 'function2');
      expect(result.complete).toBe(true);
      expectMeta(0, 'call_2', 'function2');
    });
  });

  describe('Repair functionality and flags', () => {
    it('should test repair functionality in getCompletedToolCalls', () => {
      // Repair is used in getCompletedToolCalls, not addChunk: addChunk does
      // not complete because depth > 0 and inString = true.
      openCall1('{"message": "unclosed string', 'function1');
      expect(parser.getState(0).depth).toBe(1);
      expect(parser.getState(0).inString).toBe(true);
      expectSingleCallArgs({ message: 'unclosed string' });
    });

    it('should not set repaired flag for normal parsing', () => {
      const result = openCall1('{"message": "normal"}', 'function1');
      expectComplete(result, { message: 'normal' });
      expect(result.repaired).toBeUndefined();
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = openCall1('{"nested": {"unclosed": "string', 'function1');
      // No repair attempt, because depth > 0.
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
      expect(parser.getState(0).depth).toBe(2);
    });

    it('should handle repair failure gracefully', () => {
      // Malformed JSON at depth 0 that cannot be repaired.
      const result = openCall1('{invalid: json}', 'function1');
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.repaired).toBeUndefined();
    });
  });

  describe('Complex collision scenarios', () => {
    // call_1 completes at index 0; an id-less function2 call then collides
    // there and completes in a remapped slot.
    const remapIdlessCall = () => {
      parser.addChunk(0, '{"first":true}', 'call_1', 'function1');
      return parser.addChunk(0, '{"second":true}', undefined, 'function2');
    };

    it('does not append continuation fragments to a completed remapped slot', () => {
      const remapped = remapIdlessCall();
      expect(remapped.actualIndex).toBe(1);
      expect(remapped.complete).toBe(true);

      const continuation = parser.addChunk(0, '{"third":true}');
      expect(continuation.actualIndex).not.toBe(remapped.actualIndex);
      expect(parser.getBuffer(remapped.actualIndex!)).toBe('{"second":true}');
    });

    it('associates a late stable ID with its completed remapped slot', () => {
      const remapped = remapIdlessCall();
      const identified = parser.addChunk(0, '', 'call_2');
      expect(identified.actualIndex).toBe(remapped.actualIndex);
      expect(parser.getCompletedToolCalls()).toContainEqual(
        toolCall('call_2', 'function2', { second: true }, remapped.actualIndex),
      );
    });

    it('routes id-less continuation chunks to a slot claimed by a colliding opener delta', () => {
      parser.addChunk(0, '{"a":1}', 'call_1', 'function1');
      // The provider reuses index 0 for a second tool call whose id and name
      // arrive together on an empty opener delta (the standard OpenAI streaming
      // shape: function: { name, arguments: '' }).
      const opener = parser.addChunk(0, '', 'call_2', 'function2');
      expect(opener.actualIndex).toBe(1);
      // The following id-less argument chunk must land on call_2's slot, not
      // on a fresh orphan slot that would drop the arguments and get the call
      // flagged as malformed.
      const continuation = parser.addChunk(0, '{"b":2}');
      expect(continuation.actualIndex).toBe(1);
      expect(parser.getCompletedToolCalls()).toContainEqual(
        toolCall('call_2', 'function2', { b: 2 }, 1),
      );
      // call_1's arguments must survive the collision intact.
      expect(parser.getCompletedToolCalls()).toContainEqual(
        toolCall('call_1', 'function1', { a: 1 }, 0),
      );
    });

    it('routes id-less continuations after a content-bearing colliding opener', () => {
      parser.addChunk(0, '{"a":1}', 'call_1', 'function1');
      // Same collision as above, but call_2's opener already carries a partial
      // arguments fragment alongside its id and name — the line-239 remap-record
      // path, as opposed to the empty-opener early return.
      const opener = parser.addChunk(0, '{"b":', 'call_2', 'function2');
      expect(opener.actualIndex).toBe(1);
      const continuation = parser.addChunk(0, '2}');
      expect(continuation.actualIndex).toBe(1);
      expect(parser.getCompletedToolCalls()).toContainEqual(
        toolCall('call_2', 'function2', { b: 2 }, 1),
      );
    });

    it('does not let a brand-new tool-call id adopt a remap slot that already has an id', () => {
      // Exercises the added `!toolCallMeta.get(remap)?.id` guard on
      // pending-remap adoption: after call_2 claims the 0->1 remap (with its
      // own id), a third call reusing index 0 with a fresh id must NOT hijack
      // call_2's slot via that remap — it has to fall through to collision
      // handling and get its own slot.
      parser.addChunk(0, '{"a":1}', 'call_1', 'function1');
      parser.addChunk(0, '', 'call_2', 'function2');
      parser.addChunk(0, '{"b":2}');
      const third = parser.addChunk(0, '{"c":3}', 'call_3', 'function3');
      expect(third.actualIndex).not.toBe(1);
      const completed = parser.getCompletedToolCalls();
      expect(argsOf(completed, 'call_2')).toEqual({ b: 2 });
      expect(argsOf(completed, 'call_3')).toEqual({ c: 3 });
    });

    it('routes an id-less continuation to the newest of three colliding openers', () => {
      // Three tool calls reuse provider index 0 in sequence, each opener
      // remapping to a fresh slot. An id-less continuation after the third
      // opener must land on the third call's slot. Guarding the remap
      // overwrite to keep the *first* mapping would pin the remap at call_2's
      // slot and misroute this chunk.
      parser.addChunk(0, '{"a":1}', 'call_1', 'function1'); // slot 0
      parser.addChunk(0, '', 'call_2', 'function2'); // opener -> slot 1
      parser.addChunk(0, '{"b":2}'); // call_2 args -> slot 1
      const opener3 = parser.addChunk(0, '', 'call_3', 'function3'); // opener -> slot 2
      expect(opener3.actualIndex).toBe(2);
      const continuation = parser.addChunk(0, '{"c":3}'); // id-less -> must be call_3's slot
      expect(continuation.actualIndex).toBe(2);
      const completed = parser.getCompletedToolCalls();
      expect(argsOf(completed, 'call_3')).toEqual({ c: 3 });
      expect(argsOf(completed, 'call_2')).toEqual({ b: 2 });
    });

    it('should handle rapid tool call switching at same index', () => {
      parser.addChunk(0, '{"step1":', 'call_1', 'function1');
      parser.addChunk(0, ' "done"}', 'call_1', 'function1');
      // A new tool call immediately at the same index
      parser.addChunk(0, '{"step2":', 'call_2', 'function2');
      parser.addChunk(0, ' "done"}', 'call_2', 'function2');
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expect(argsOf(completed, 'call_1')).toEqual({ step1: 'done' });
      expect(argsOf(completed, 'call_2')).toEqual({ step2: 'done' });
    });

    it('should handle interleaved chunks from multiple tool calls with ID mapping', () => {
      // Different indices avoid a collision; each call continues at its own.
      parser.addChunk(0, '{"param1":', 'call_1', 'function1');
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');
      const result1 = parser.addChunk(0, ' "value1"}');
      expect(result1.complete).toBe(true);
      const result2 = parser.addChunk(1, ' "value2"}');
      expect(result2.complete).toBe(true);
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expect(argsOf(completed, 'call_1')).toEqual({ param1: 'value1' });
      expect(argsOf(completed, 'call_2')).toEqual({ param2: 'value2' });
    });

    it('keeps both calls intact when an empty colliding opener has id-less continuations', () => {
      parser.addChunk(0, '{"path":"first.ts"}', 'call_read', 'read_file');
      // An empty opener cannot be recovered by searching for incomplete JSON.
      parser.addChunk(0, '', 'call_search', 'grep_search');
      parser.addChunk(0, '{"pattern":"needle",');
      parser.addChunk(0, '"path":"src"}');
      expectCalls(
        toolCall('call_read', 'read_file', { path: 'first.ts' }, 0),
        toolCall(
          'call_search',
          'grep_search',
          { pattern: 'needle', path: 'src' },
          1,
        ),
      );
    });
  });

  describe('hasIncompleteToolCalls', () => {
    it('should return false when no tool calls exist', () => {
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should return false when all tool calls have complete JSON', () => {
      parser.addChunk(0, '{"key": "value"}', 'call_1', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should return true when a tool call has depth > 0 (unclosed braces)', () => {
      const chunk = '{"file_path": "/tmp/test.txt", "content": "partial';
      openCall1(chunk, 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(true);
    });

    it('should return true when a tool call is inside a string literal', () => {
      // Simulate truncation mid-string: {"file_path": "/tmp/test.txt", "content": "some text
      openCall1('{"file_path": "/tmp/test.txt"', 'write_file');
      parser.addChunk(0, ', "content": "some text');
      expect(parser.getState(0).inString).toBe(true);
      expect(parser.hasIncompleteToolCalls()).toBe(true);
    });

    it('should return false for tool calls without name metadata', () => {
      // Tool calls without a name should be ignored
      parser.addChunk(0, '{"key": "incomplete', undefined, undefined);
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should detect incomplete among multiple tool calls', () => {
      parser.addChunk(0, '{"key": "value"}', 'call_1', 'func_a'); // complete
      parser.addChunk(1, '{"key": "val', 'call_2', 'func_b'); // incomplete
      expect(parser.hasIncompleteToolCalls()).toBe(true);
    });

    it('should return false after reset', () => {
      parser.addChunk(0, '{"key": "incomplete', 'call_1', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(true);
      parser.reset();
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should detect real-world truncation: write_file with only file_path', () => {
      // Reproduces the actual bug: LLM output truncated mid-JSON, only the
      // file_path key received, content never arrived. The buffer
      // {"file_path": "/path/to/file.cpp" has depth 1: outer brace unclosed.
      openCall1('{"file_path": "/path/to/file.cpp"', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(true);
      expect(parser.getState(0).depth).toBe(1);
    });
  });

  describe('hasInvalidToolCallArguments', () => {
    it.each([
      ['', false],
      ['   ', true],
      ['{"path":"a.ts"}', false],
      ['{bad}', true],
      ['null', true],
      ['[]', true],
      ['42', true],
    ])('validates %s', (toolArguments, invalid) => {
      parser.addChunk(0, toolArguments, 'call_1', 'read_file');
      expect(parser.hasInvalidToolCallArguments()).toBe(invalid);
    });
  });
});
