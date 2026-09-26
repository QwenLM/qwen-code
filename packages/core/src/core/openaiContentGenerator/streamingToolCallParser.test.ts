/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolCallParseResult } from './streamingToolCallParser.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';

type Completed = ReturnType<StreamingToolCallParser['getCompletedToolCalls']>;

const EMPTY_STATE = { depth: 0, inString: false, escape: false };
// A completed tool call as getCompletedToolCalls() reports it.
const call = (
  id: string | undefined,
  name: string,
  args: Record<string, unknown>,
  index: number | undefined,
) => ({ id, name, args, index });

const expectComplete = (result: ToolCallParseResult, value: unknown) => {
  expect(result.complete).toBe(true);
  expect(result.value).toEqual(value);
};
// Checks each completed call's args, looked up by id, in the order given.
const expectArgsById = (
  completed: Completed,
  argsById: Record<string, unknown>,
) => {
  for (const [id, args] of Object.entries(argsById)) {
    expect(completed.find((tc) => tc.id === id)?.args).toEqual(args);
  }
};

describe('StreamingToolCallParser', () => {
  let parser: StreamingToolCallParser;

  beforeEach(() => {
    parser = new StreamingToolCallParser();
  });

  // Opens call_1 at index 0 with `chunk` under `name`.
  const open = (chunk: string, name = 'function1') =>
    parser.addChunk(0, chunk, 'call_1', name);
  const expectMeta = (index: number, id: string, name: string) =>
    expect(parser.getToolCallMeta(index)).toEqual({ id, name });
  // Opens call_1 with `head`, which must leave the parser incomplete in
  // `state`, then completes it with an id-less `tail` parsing to `value`.
  function expectHeadThenTail(
    head: string,
    state: Partial<typeof EMPTY_STATE>,
    tail: string,
    value: unknown,
    name = 'test_function',
  ) {
    expect(open(head, name).complete).toBe(false);
    expect(parser.getState(0)).toMatchObject(state);
    expectComplete(parser.addChunk(0, tail), value);
  }
  // Opens call_1 with `chunk`; stream-end repair yields exactly one call
  // carrying `args`.
  function expectRepairedArgs(chunk: string, args: unknown, name: string) {
    open(chunk, name);
    const completed = parser.getCompletedToolCalls();
    expect(completed).toHaveLength(1);
    expect(completed[0].args).toEqual(args);
  }

  describe('Basic functionality', () => {
    it('should initialize with empty state', () => {
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual(EMPTY_STATE);
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should handle simple complete JSON in single chunk', () => {
      const result = open('{"key": "value"}', 'test_function');

      expectComplete(result, { key: 'value' });
      expect(result.error).toBeUndefined();
      expect(result.repaired).toBeUndefined();
    });

    it('should accumulate chunks until complete JSON', () => {
      expect(open('{"key":', 'test_function').complete).toBe(false);
      expect(parser.addChunk(0, ' "val').complete).toBe(false);
      expectComplete(parser.addChunk(0, 'ue"}'), { key: 'value' });
    });

    it('should handle empty chunks gracefully', () => {
      expect(open('', 'test_function').complete).toBe(false);
      expect(parser.getBuffer(0)).toBe('');
    });
  });

  describe('JSON depth tracking', () => {
    it('should track nested objects correctly', () => {
      expectHeadThenTail('{"outer": {"inner":', { depth: 2 }, ' "value"}}', {
        outer: { inner: 'value' },
      });
    });

    it('should track nested arrays correctly', () => {
      // Depth: { (1) + [ (2) + [ (3) = 3
      expectHeadThenTail('{"arr": [1, [2,', { depth: 3 }, ' 3]]}', {
        arr: [1, [2, 3]],
      });
    });

    it('should handle mixed nested structures', () => {
      // Depth: { (1) + { (2) + [ (3) + { (4) = 4
      expectHeadThenTail(
        '{"obj": {"arr": [{"nested":',
        { depth: 4 },
        ' true}]}}',
        {
          obj: { arr: [{ nested: true }] },
        },
      );
    });
  });

  describe('String handling', () => {
    it.each([
      [
        'should handle strings with special characters',
        '{"text": "Hello, \\"World\\"!"}',
        { text: 'Hello, "World"!' },
      ],
      [
        'should handle strings with braces and brackets',
        '{"code": "if (x) { return [1, 2]; }"}',
        { code: 'if (x) { return [1, 2]; }' },
      ],
      [
        'should handle backslash escapes correctly',
        '{"path": "C:\\\\Users\\\\test"}',
        { path: 'C:\\Users\\test' },
      ],
    ])('%s', (_title, json, value) => {
      expectComplete(open(json, 'test_function'), value);
    });

    it('should track string boundaries correctly across chunks', () => {
      expectHeadThenTail('{"text": "Hello', { inString: true }, ' World"}', {
        text: 'Hello World',
      });
    });

    it('should handle escaped quotes in strings', () => {
      expectHeadThenTail(
        '{"text": "Say \\"Hello',
        { inString: true },
        '\\" to me"}',
        {
          text: 'Say "Hello" to me',
        },
      );
    });
  });

  describe('Error handling and repair', () => {
    it('should return error for malformed JSON at depth 0', () => {
      const result = open('{"key": invalid}', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should auto-repair unclosed strings', () => {
      // Checked via getCompletedToolCalls, where repair is used in practice.
      expectRepairedArgs(
        '{"text": "unclosed',
        { text: 'unclosed' },
        'test_function',
      );
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = open('{"obj": {"text": "unclosed', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
    });

    it('should handle repair failure gracefully', () => {
      // Even repair fails here: malformed JSON at depth 0
      const result = open('invalid json', 'test_function');
      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });
  });

  describe('Multiple tool calls', () => {
    it('should handle multiple tool calls with different indices', () => {
      const result1 = open('{"param1": "value1"}');
      const result2 = parser.addChunk(
        1,
        '{"param2": "value2"}',
        'call_2',
        'function2',
      );

      expectComplete(result1, { param1: 'value1' });
      expectComplete(result2, { param2: 'value2' });
      expectMeta(0, 'call_1', 'function1');
      expectMeta(1, 'call_2', 'function2');
    });

    it('should handle interleaved chunks from multiple tool calls', () => {
      let result1 = open('{"param1":');
      let result2 = parser.addChunk(1, '{"param2":', 'call_2', 'function2');

      expect(result1.complete).toBe(false);
      expect(result2.complete).toBe(false);

      result1 = parser.addChunk(0, ' "value1"}');
      result2 = parser.addChunk(1, ' "value2"}');

      expectComplete(result1, { param1: 'value1' });
      expectComplete(result2, { param2: 'value2' });
    });

    it('should maintain separate state for each index', () => {
      open('{"nested": {"deep":');
      parser.addChunk(1, '{"simple":', 'call_2', 'function2');

      expect(parser.getState(0).depth).toBe(2);
      expect(parser.getState(1).depth).toBe(1);

      expect(parser.addChunk(0, ' "value"}}').complete).toBe(true);
      expect(parser.addChunk(1, ' "value"}').complete).toBe(true);
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
        expect(parser.getCompletedToolCalls()).toEqual([
          call(id, 'read_file', { path: 'a.ts' }, index),
        ]);
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
      expect(open('{"param1": "value1"}').complete).toBe(true);

      // Same index, different ID: reassigned to a new index
      const result2 = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result2.complete).toBe(false);

      // Index 0 still holds the first call; the new one sits at index 1
      expect(parser.getBuffer(0)).toBe('{"param1": "value1"}');
      expectMeta(0, 'call_1', 'function1');
      expect(parser.getBuffer(1)).toBe('{"param2":');
      expectMeta(1, 'call_2', 'function2');
    });
  });

  describe('Completed tool calls', () => {
    it('should return completed tool calls', () => {
      open('{"param1": "value1"}');
      parser.addChunk(1, '{"param2": "value2"}', 'call_2', 'function2');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expect(completed[0]).toEqual(
        call('call_1', 'function1', { param1: 'value1' }, 0),
      );
      expect(completed[1]).toEqual(
        call('call_2', 'function2', { param2: 'value2' }, 1),
      );
    });

    it('should handle completed tool calls with repair', () => {
      expectRepairedArgs(
        '{"text": "unclosed',
        { text: 'unclosed' },
        'function1',
      );
    });

    it('should use safeJsonParse as fallback for malformed JSON', () => {
      // JSON.parse fails but jsonrepair fixes it, setting `invalid` to null
      expectRepairedArgs(
        '{"valid": "data", "invalid": }',
        { valid: 'data', invalid: null },
        'function1',
      );
    });

    it('should not return tool calls without function name', () => {
      parser.addChunk(0, '{"param": "value"}', 'call_1'); // No function name
      expect(parser.getCompletedToolCalls()).toHaveLength(0);
    });

    it('should return no-argument tool calls with empty args when buffer is empty', () => {
      // For tools without parameters, some providers stream
      // `arguments: ""` (or omit the field) and never send an argument
      // fragment. The call must survive with empty args, matching the
      // non-streaming path.
      open('');
      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'function1', {}, 0),
      ]);
    });

    it('should return empty args for whitespace-only argument buffers', () => {
      expectRepairedArgs('   ', {}, 'function1');
    });

    it('should not overwrite a completed no-argument tool call when a new call reuses its index', () => {
      // No-argument first call (no fragment ever sent), then a second call
      // with a different ID at the same index: both must survive, the
      // second relocated to a new index.
      open('', 'no_arg_function');
      parser.addChunk(0, '{"param": "value"}', 'call_2', 'function2');

      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'no_arg_function', {}, 0),
        call('call_2', 'function2', { param: 'value' }, 1),
      ]);
    });

    it('should route ID-less argument fragments to a call whose opener streamed empty arguments', () => {
      // Canonical OpenAI-compatible streaming shape: the opener carries
      // id + name + `arguments: ""`, then argument fragments follow at the
      // same index without an ID. Mid-stream, an empty buffer with name
      // metadata must therefore stay continuable at its own index — it is
      // indistinguishable from a completed no-argument call until stream end.
      open('');
      parser.addChunk(0, '{"x":');
      parser.addChunk(0, '1}');

      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'function1', { x: 1 }, 0),
      ]);
    });

    it('should emit empty args for a no-argument call polluted by a stray fragment at its index', () => {
      // If a misbehaving provider reuses a completed no-argument call's
      // index for another call's ID-less fragment, the fragment cannot be
      // re-routed (see canonical-shape test above). The damage must stay
      // bounded: the polluted buffer repairs to a non-object value, which
      // collapses to {} at emit time.
      open('{"key":');
      parser.addChunk(1, '', 'call_2', 'no_arg_function');
      parser.addChunk(1, '"value"}');

      expectArgsById(parser.getCompletedToolCalls(), { call_2: {} });
    });

    it('should collapse null argument buffers to empty args', () => {
      open('null');
      expect(parser.getCompletedToolCalls()[0].args).toEqual({});
    });

    it('should collapse array argument buffers to empty args', () => {
      open('[1,2,3]');
      expect(parser.getCompletedToolCalls()[0].args).toEqual({});
    });

    it('should scan past occupied no-argument slots when relocating a colliding call', () => {
      parser.addChunk(0, '', 'call_a', 'no_arg_a');
      parser.addChunk(1, '', 'call_b', 'no_arg_b');
      // Collision at index 0 must relocate past both occupied no-arg slots
      parser.addChunk(0, '{"x": 1}', 'call_c', 'fn_c');

      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_a', 'no_arg_a', {}, 0),
        call('call_b', 'no_arg_b', {}, 1),
        call('call_c', 'fn_c', { x: 1 }, 2),
      ]);
    });

    it('should not route continuation chunks to a completed no-argument tool call', () => {
      open('{"key":'); // incomplete at index 0
      parser.addChunk(1, '', 'call_2', 'no_arg_function'); // no-arg, index 1
      parser.addChunk(2, '{"x": 1}', 'call_3', 'function3'); // complete, index 2

      // An ID-less continuation at a completed index must go to the
      // incomplete call_1, not to the no-argument call_2
      parser.addChunk(2, '"value"}');

      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'function1', { key: 'value' }, 0),
        call('call_2', 'no_arg_function', {}, 1),
        call('call_3', 'function3', { x: 1 }, 2),
      ]);
    });
  });

  describe('Edge cases', () => {
    const large = { data: 'x'.repeat(10000) };
    let nested: unknown = 'value';
    for (let i = 0; i < 100; i++) nested = { level: nested };
    it.each([
      ['should handle very large JSON objects', JSON.stringify(large), large],
      [
        'should handle deeply nested structures',
        JSON.stringify(nested),
        nested,
      ],
      [
        'should handle JSON with unicode characters',
        '{"emoji": "🚀", "chinese": "你好"}',
        { emoji: '🚀', chinese: '你好' },
      ],
      [
        'should handle JSON with null and boolean values',
        '{"null": null, "bool": true, "false": false}',
        { null: null, bool: true, false: false },
      ],
      [
        'should handle JSON with numbers',
        '{"int": 42, "float": 3.14, "negative": -1, "exp": 1e5}',
        { int: 42, float: 3.14, negative: -1, exp: 1e5 },
      ],
    ])('%s', (_title, json, value) => {
      expectComplete(open(json), value);
    });

    it('should handle whitespace-only chunks', () => {
      expect(open('  \n\t  ').complete).toBe(false);
      expectComplete(parser.addChunk(0, '{"key": "value"}'), { key: 'value' });
    });

    it('should handle chunks with only structural characters', () => {
      expectHeadThenTail('{', { depth: 1 }, '}', {}, 'function1');
    });
  });

  describe('Real-world streaming scenarios', () => {
    it('should handle typical OpenAI streaming pattern', () => {
      // How OpenAI typically streams tool call arguments
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

      expectComplete(result, { query: 'What is the weather in Paris?' });
    });

    it('should handle multiple concurrent tool calls streaming', () => {
      open('{"location":', 'get_weather');
      parser.addChunk(1, '{"query":', 'call_2', 'search_web');
      parser.addChunk(0, ' "New York"}');

      expectComplete(parser.addChunk(1, ' "OpenAI GPT"}'), {
        query: 'OpenAI GPT',
      });

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
      // A stream cut off mid-string
      expectRepairedArgs(
        '{"message": "Hello world',
        { message: 'Hello world' },
        'send_message',
      );
    });
  });

  describe('Tool call ID collision detection and mapping', () => {
    it('should ignore replay chunks after a tool call ID completes', () => {
      expect(open('{"param1": "value1"}').complete).toBe(true);

      // Once the ID has complete JSON, later chunks with the same ID are
      // provider replay and must not mutate the surviving call.
      expect(open('{"param2": "value2"}', 'function2').complete).toBe(false);

      expectMeta(0, 'call_1', 'function1');
      expect(parser.getBuffer(0)).toBe('{"param1": "value1"}');
    });

    it('should ignore replayed openers for a completed no-argument tool call', () => {
      open('', 'list_sessions');
      // Provider replays the same ID's opener with a different name; the
      // surviving call must not be mutated
      open('', 'different_function');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].name).toBe('list_sessions');
      expect(completed[0].args).toEqual({});
    });

    it('should append ID-bearing argument fragments after an empty opener', () => {
      // Some providers repeat the tool call ID on argument fragments. A
      // known-ID chunk carrying argument content is a continuation, not a
      // replay, and must not be swallowed by the replay guard.
      open('');
      parser.addChunk(0, '{"text":"hello', 'call_1');
      parser.addChunk(0, ' ', 'call_1');
      const result = parser.addChunk(0, 'world"}', 'call_1');

      expect(result.complete).toBe(true);
      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'function1', { text: 'hello world' }, 0),
      ]);
    });

    it('should ignore metadata-only replay chunks after a tool call ID completes', () => {
      open('{"file_path": "a.ts"}', 'read_file');

      expect(open('', 'shell').complete).toBe(false);
      expectMeta(0, 'call_1', 'read_file');
      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'read_file', { file_path: 'a.ts' }, 0),
      ]);
    });

    it('should normalize a tool call name before storing it', () => {
      open('{}', ' read_file ');
      expect(parser.getCompletedToolCalls()).toEqual([
        call('call_1', 'read_file', {}, 0),
      ]);
    });

    it('should preserve the first non-empty name for a tool call ID', () => {
      open('{"file_path":', 'read_file');
      parser.addChunk(0, '"a.ts"}', 'call_1', 'shell');

      expect(parser.getCompletedToolCalls()[0]?.name).toBe('read_file');
      expect(parser.hasConflictingToolCallIdentity()).toBe(true);
    });

    it('should detect index collision and find new index', () => {
      open('{"param1": "value1"}');

      // Different ID at the same index: reassigned, then completed
      const result = parser.addChunk(0, '{"param2":', 'call_2', 'function2');
      expect(result.complete).toBe(false);
      expect(parser.addChunk(0, ' "value2"}').complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);

      // Both calls survive under their own IDs
      expect(completed.find((tc) => tc.id === 'call_1')).toBeDefined();
      expect(completed.find((tc) => tc.id === 'call_2')).toBeDefined();
      expectArgsById(completed, {
        call_1: { param1: 'value1' },
        call_2: { param2: 'value2' },
      });
      expect(parser.hasConflictingToolCallIdentity()).toBe(false);
    });

    it('should reject unsafe provider indices', () => {
      const result = parser.addChunk(Number.MAX_SAFE_INTEGER + 1, '   ');

      expect(result.error?.message).toContain('Invalid tool call index');
      expect(parser.hasInvalidToolCallIndex()).toBe(true);
      expect(parser.hasConflictingToolCallIdentity()).toBe(true);
    });

    it('should handle continuation chunks without ID correctly', () => {
      open('{"param":');
      expectComplete(parser.addChunk(0, ' "value"}'), { param: 'value' });
      expectMeta(0, 'call_1', 'function1');
    });

    it('should find most recent incomplete tool call for continuation chunks', () => {
      open('{"param1": "complete"}');
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');
      parser.addChunk(2, '{"param3":', 'call_3', 'function3');

      // An ID-less continuation at index 1 continues the incomplete call there
      expect(parser.addChunk(1, ' "continuation"}').complete).toBe(true);

      expectArgsById(parser.getCompletedToolCalls(), {
        call_2: { param2: 'continuation' },
      });
    });
  });

  describe('Index management and reset functionality', () => {
    it('should reset individual index correctly', () => {
      open('{"partial":');
      expect(parser.getBuffer(0)).toBe('{"partial":');
      expect(parser.getState(0).depth).toBe(1);
      expectMeta(0, 'call_1', 'function1');

      parser.resetIndex(0);

      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getState(0)).toEqual(EMPTY_STATE);
      expect(parser.getToolCallMeta(0)).toEqual({});
    });

    it('should find next available index when all lower indices are occupied', () => {
      // Indices 0, 1, 2 hold complete calls, so a new call goes to index 3
      parser.addChunk(0, '{"param0": "value0"}', 'call_0', 'function0');
      parser.addChunk(1, '{"param1": "value1"}', 'call_1', 'function1');
      parser.addChunk(2, '{"param2": "value2"}', 'call_2', 'function2');

      const result = parser.addChunk(
        0,
        '{"param3": "value3"}',
        'call_3',
        'function3',
      );
      expect(result.complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(4);
      const call3 = completed.find((tc) => tc.id === 'call_3');
      expect(call3).toBeDefined();
      expect(call3?.index).toBe(3);
    });

    it('should reuse incomplete index when available', () => {
      open('{"incomplete":');

      // A new ID reuses the incomplete index and updates its metadata
      const result = parser.addChunk(0, ' "completed"}', 'call_2', 'function2');
      expect(result.complete).toBe(true);
      expectMeta(0, 'call_2', 'function2');
    });
  });

  describe('Repair functionality and flags', () => {
    it('should test repair functionality in getCompletedToolCalls', () => {
      // Repair is primarily used in getCompletedToolCalls, not addChunk
      open('{"message": "unclosed string');

      // addChunk does not complete: depth > 0 and inString = true
      expect(parser.getState(0).depth).toBe(1);
      expect(parser.getState(0).inString).toBe(true);

      // But getCompletedToolCalls repairs it
      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(1);
      expect(completed[0].args).toEqual({ message: 'unclosed string' });
    });

    it('should not set repaired flag for normal parsing', () => {
      const result = open('{"message": "normal"}');

      expect(result.complete).toBe(true);
      expect(result.repaired).toBeUndefined();
      expect(result.value).toEqual({ message: 'normal' });
    });

    it('should not attempt repair when still in nested structure', () => {
      const result = open('{"nested": {"unclosed": "string');

      // No repair attempt because depth > 0
      expect(result.complete).toBe(false);
      expect(result.repaired).toBeUndefined();
      expect(parser.getState(0).depth).toBe(2);
    });

    it('should handle repair failure gracefully', () => {
      // Malformed JSON that can't be repaired at depth 0
      const result = open('{invalid: json}');

      expect(result.complete).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.repaired).toBeUndefined();
    });
  });

  describe('Complex collision scenarios', () => {
    // call_1 completes at index 0, then a complete id-less call reuses index
    // 0 and is remapped; returns that remapped result.
    const remapSecond = () => {
      open('{"first":true}');
      return parser.addChunk(0, '{"second":true}', undefined, 'function2');
    };

    it('does not append continuation fragments to a completed remapped slot', () => {
      const remapped = remapSecond();

      expect(remapped.actualIndex).toBe(1);
      expect(remapped.complete).toBe(true);

      const continuation = parser.addChunk(0, '{"third":true}');

      expect(continuation.actualIndex).not.toBe(remapped.actualIndex);
      expect(parser.getBuffer(remapped.actualIndex!)).toBe('{"second":true}');
    });

    it('associates a late stable ID with its completed remapped slot', () => {
      const remapped = remapSecond();

      const identified = parser.addChunk(0, '', 'call_2');

      expect(identified.actualIndex).toBe(remapped.actualIndex);
      expect(parser.getCompletedToolCalls()).toContainEqual(
        call('call_2', 'function2', { second: true }, remapped.actualIndex),
      );
    });

    it('routes id-less continuation chunks to a slot claimed by a colliding opener delta', () => {
      open('{"a":1}');

      // The provider reuses index 0 for a second tool call whose id and name
      // arrive together on an empty opener delta (the standard OpenAI streaming
      // shape: function: { name, arguments: '' }).
      expect(parser.addChunk(0, '', 'call_2', 'function2').actualIndex).toBe(1);

      // The following id-less argument chunk must land on call_2's slot, not on
      // a fresh orphan slot that would drop the arguments and get the call
      // flagged as malformed.
      expect(parser.addChunk(0, '{"b":2}').actualIndex).toBe(1);

      expect(parser.getCompletedToolCalls()).toContainEqual(
        call('call_2', 'function2', { b: 2 }, 1),
      );
      // call_1's arguments must survive the collision intact.
      expect(parser.getCompletedToolCalls()).toContainEqual(
        call('call_1', 'function1', { a: 1 }, 0),
      );
    });

    it('routes id-less continuations after a content-bearing colliding opener', () => {
      open('{"a":1}');

      // Same collision as above, but call_2's opener already carries a partial
      // arguments fragment alongside its id and name — the line-239 remap-record
      // path, as opposed to the empty-opener early return.
      expect(
        parser.addChunk(0, '{"b":', 'call_2', 'function2').actualIndex,
      ).toBe(1);
      expect(parser.addChunk(0, '2}').actualIndex).toBe(1);

      expect(parser.getCompletedToolCalls()).toContainEqual(
        call('call_2', 'function2', { b: 2 }, 1),
      );
    });

    it('does not let a brand-new tool-call id adopt a remap slot that already has an id', () => {
      // Exercises the added `!toolCallMeta.get(remap)?.id` guard on pending-remap
      // adoption: after call_2 claims the 0->1 remap (with its own id), a third
      // tool call that reuses index 0 with a fresh id must NOT hijack call_2's
      // slot via that remap — it has to fall through to collision handling and
      // get its own slot.
      open('{"a":1}');
      parser.addChunk(0, '', 'call_2', 'function2');
      parser.addChunk(0, '{"b":2}');

      const third = parser.addChunk(0, '{"c":3}', 'call_3', 'function3');
      expect(third.actualIndex).not.toBe(1);

      expectArgsById(parser.getCompletedToolCalls(), {
        call_2: { b: 2 },
        call_3: { c: 3 },
      });
    });

    it('routes an id-less continuation to the newest of three colliding openers', () => {
      // Three tool calls reuse provider index 0 in sequence, each opener remapping
      // to a fresh slot. An id-less continuation after the third opener must land on
      // the third call's slot. Guarding the remap overwrite to keep the *first*
      // mapping would pin the remap at call_2's slot and misroute this chunk.
      open('{"a":1}'); // slot 0
      parser.addChunk(0, '', 'call_2', 'function2'); // opener -> slot 1
      parser.addChunk(0, '{"b":2}'); // call_2 args -> slot 1
      const opener3 = parser.addChunk(0, '', 'call_3', 'function3'); // opener -> slot 2
      expect(opener3.actualIndex).toBe(2);

      const continuation = parser.addChunk(0, '{"c":3}'); // id-less -> must be call_3's slot
      expect(continuation.actualIndex).toBe(2);

      expectArgsById(parser.getCompletedToolCalls(), {
        call_3: { c: 3 },
        call_2: { b: 2 },
      });
    });

    it('should handle rapid tool call switching at same index', () => {
      open('{"step1":');
      open(' "done"}');
      // New tool call immediately at the same index
      parser.addChunk(0, '{"step2":', 'call_2', 'function2');
      parser.addChunk(0, ' "done"}', 'call_2', 'function2');

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expectArgsById(completed, {
        call_1: { step1: 'done' },
        call_2: { step2: 'done' },
      });
    });

    it('should handle interleaved chunks from multiple tool calls with ID mapping', () => {
      open('{"param1":');
      // Tool call 2 starts at index 1 to avoid a collision
      parser.addChunk(1, '{"param2":', 'call_2', 'function2');

      // Each continues at its own index
      expect(parser.addChunk(0, ' "value1"}').complete).toBe(true);
      expect(parser.addChunk(1, ' "value2"}').complete).toBe(true);

      const completed = parser.getCompletedToolCalls();
      expect(completed).toHaveLength(2);
      expectArgsById(completed, {
        call_1: { param1: 'value1' },
        call_2: { param2: 'value2' },
      });
    });
  });

  describe('hasIncompleteToolCalls', () => {
    it('should return false when no tool calls exist', () => {
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should return false when all tool calls have complete JSON', () => {
      open('{"key": "value"}', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should return true when a tool call has depth > 0 (unclosed braces)', () => {
      open('{"file_path": "/tmp/test.txt", "content": "partial', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(true);
    });

    it('should return true when a tool call is inside a string literal', () => {
      // Truncation mid-string: {"file_path": "/tmp/test.txt", "content": "some text
      open('{"file_path": "/tmp/test.txt"', 'write_file');
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
      open('{"key": "value"}', 'func_a'); // complete
      parser.addChunk(1, '{"key": "val', 'call_2', 'func_b'); // incomplete
      expect(parser.hasIncompleteToolCalls()).toBe(true);
    });

    it('should return false after reset', () => {
      open('{"key": "incomplete', 'write_file');
      expect(parser.hasIncompleteToolCalls()).toBe(true);
      parser.reset();
      expect(parser.hasIncompleteToolCalls()).toBe(false);
    });

    it('should detect real-world truncation: write_file with only file_path', () => {
      // Reproduces the actual bug: LLM output truncated mid-JSON, only the
      // file_path key received, content never arrived. Buffer
      // {"file_path": "/path/to/file.cpp" has depth=1 (outer brace unclosed).
      open('{"file_path": "/path/to/file.cpp"', 'write_file');
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
