/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { partitionToolCalls, type ToolResolver } from './tool-orchestration.js';
import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import type { AnyDeclarativeTool } from './tools.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from './tool-names.js';

/** Helper: build a minimal ToolCallRequestInfo stub. */
function makeRequest(name: string, callId?: string): ToolCallRequestInfo {
  return {
    callId: callId ?? `call-${name}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    args: {},
    prompt_id: 'test',
  };
}

/** Helper: build a minimal AnyDeclarativeTool stub with concurrency control. */
function makeTool(name: string, isSafe: boolean): AnyDeclarativeTool {
  return {
    name,
    isConcurrencySafe: vi.fn().mockReturnValue(isSafe),
  } as unknown as AnyDeclarativeTool;
}

/** Helper: build a ToolResolver from a map of tool stubs. */
function makeResolver(tools: Record<string, AnyDeclarativeTool>): ToolResolver {
  return (name: string) => tools[name];
}

describe('partitionToolCalls', () => {
  it('returns empty array for empty input', () => {
    const resolver = makeResolver({});
    const result = partitionToolCalls([], resolver);
    expect(result).toEqual([]);
  });

  it('groups consecutive safe tools into a single concurrent batch', () => {
    const tools = {
      [GLOB_TOOL_NAME]: makeTool(GLOB_TOOL_NAME, true),
      [GREP_TOOL_NAME]: makeTool(GREP_TOOL_NAME, true),
      [READ_FILE_TOOL_NAME]: makeTool(READ_FILE_TOOL_NAME, true),
    };
    const resolver = makeResolver(tools);
    const requests = [
      makeRequest(GLOB_TOOL_NAME),
      makeRequest(GREP_TOOL_NAME),
      makeRequest(READ_FILE_TOOL_NAME),
    ];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(1);
    expect(result[0].isConcurrent).toBe(true);
    expect(result[0].requests).toHaveLength(3);
    expect(result[0].requests[0].name).toBe(GLOB_TOOL_NAME);
    expect(result[0].requests[1].name).toBe(GREP_TOOL_NAME);
    expect(result[0].requests[2].name).toBe(READ_FILE_TOOL_NAME);
  });

  it('puts each non-safe tool in its own serial batch', () => {
    const tools = {
      shell: makeTool('shell', false),
      [WRITE_FILE_TOOL_NAME]: makeTool(WRITE_FILE_TOOL_NAME, false),
    };
    const resolver = makeResolver(tools);
    const requests = [makeRequest('shell'), makeRequest(WRITE_FILE_TOOL_NAME)];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(2);
    expect(result[0].isConcurrent).toBe(false);
    expect(result[0].requests).toHaveLength(1);
    expect(result[0].requests[0].name).toBe('shell');
    expect(result[1].isConcurrent).toBe(false);
    expect(result[1].requests).toHaveLength(1);
    expect(result[1].requests[0].name).toBe(WRITE_FILE_TOOL_NAME);
  });

  it('interleaves concurrent and serial batches correctly', () => {
    // [Glob, Grep, Shell, ReadFile, ReadFile]
    // -> [{concurrent: Glob,Grep}, {serial: Shell}, {concurrent: ReadFile,ReadFile}]
    const tools = {
      [GLOB_TOOL_NAME]: makeTool(GLOB_TOOL_NAME, true),
      [GREP_TOOL_NAME]: makeTool(GREP_TOOL_NAME, true),
      shell: makeTool('shell', false),
      [READ_FILE_TOOL_NAME]: makeTool(READ_FILE_TOOL_NAME, true),
    };
    const resolver = makeResolver(tools);
    const requests = [
      makeRequest(GLOB_TOOL_NAME),
      makeRequest(GREP_TOOL_NAME),
      makeRequest('shell'),
      makeRequest(READ_FILE_TOOL_NAME, 'read1'),
      makeRequest(READ_FILE_TOOL_NAME, 'read2'),
    ];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(3);

    expect(result[0].isConcurrent).toBe(true);
    expect(result[0].requests.map((r) => r.name)).toEqual([
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
    ]);

    expect(result[1].isConcurrent).toBe(false);
    expect(result[1].requests.map((r) => r.name)).toEqual(['shell']);

    expect(result[2].isConcurrent).toBe(true);
    expect(result[2].requests.map((r) => r.name)).toEqual([
      READ_FILE_TOOL_NAME,
      READ_FILE_TOOL_NAME,
    ]);
  });

  it('treats unknown tools as non-safe (serial)', () => {
    const resolver = makeResolver({}); // no tools registered
    const requests = [makeRequest('unknown_tool')];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(1);
    expect(result[0].isConcurrent).toBe(false);
    expect(result[0].requests[0].name).toBe('unknown_tool');
  });

  it('unknown tool breaks a concurrent batch', () => {
    const tools = {
      [GLOB_TOOL_NAME]: makeTool(GLOB_TOOL_NAME, true),
      [GREP_TOOL_NAME]: makeTool(GREP_TOOL_NAME, true),
    };
    const resolver = makeResolver(tools);
    const requests = [
      makeRequest(GLOB_TOOL_NAME),
      makeRequest('mystery'), // unknown — serial
      makeRequest(GREP_TOOL_NAME),
    ];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(3);
    expect(result[0].isConcurrent).toBe(true);
    expect(result[0].requests[0].name).toBe(GLOB_TOOL_NAME);
    expect(result[1].isConcurrent).toBe(false);
    expect(result[1].requests[0].name).toBe('mystery');
    expect(result[2].isConcurrent).toBe(true);
    expect(result[2].requests[0].name).toBe(GREP_TOOL_NAME);
  });

  it('single safe tool forms a concurrent batch of one', () => {
    const tools = { [GLOB_TOOL_NAME]: makeTool(GLOB_TOOL_NAME, true) };
    const resolver = makeResolver(tools);
    const requests = [makeRequest(GLOB_TOOL_NAME)];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(1);
    expect(result[0].isConcurrent).toBe(true);
    expect(result[0].requests).toHaveLength(1);
  });

  it('single non-safe tool forms a serial batch of one', () => {
    const tools = { shell: makeTool('shell', false) };
    const resolver = makeResolver(tools);
    const requests = [makeRequest('shell')];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(1);
    expect(result[0].isConcurrent).toBe(false);
    expect(result[0].requests).toHaveLength(1);
  });

  it('passes request args to isConcurrencySafe', () => {
    const tool = makeTool('shell', false);
    const resolver = makeResolver({ shell: tool });
    const args = { command: 'ls -la' };
    const request = { ...makeRequest('shell'), args };

    partitionToolCalls([request], resolver);

    expect(tool.isConcurrencySafe).toHaveBeenCalledWith(args);
  });

  it('handles mixed pattern: safe, safe, unsafe, unsafe, safe', () => {
    const tools = {
      read: makeTool('read', true),
      write: makeTool('write', false),
      exec: makeTool('exec', false),
      grep: makeTool('grep', true),
    };
    const resolver = makeResolver(tools);
    const requests = [
      makeRequest('read', 'r1'),
      makeRequest('read', 'r2'),
      makeRequest('write'),
      makeRequest('exec'),
      makeRequest('grep'),
    ];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(
      expect.objectContaining({
        isConcurrent: true,
        requests: expect.arrayContaining([
          expect.objectContaining({ name: 'read' }),
        ]),
      }),
    );
    expect(result[0].requests).toHaveLength(2);
    expect(result[1].isConcurrent).toBe(false);
    expect(result[1].requests[0].name).toBe('write');
    expect(result[2].isConcurrent).toBe(false);
    expect(result[2].requests[0].name).toBe('exec');
    expect(result[3].isConcurrent).toBe(true);
    expect(result[3].requests[0].name).toBe('grep');
  });

  it('preserves request ordering within batches', () => {
    const tools = {
      a: makeTool('a', true),
      b: makeTool('b', true),
      c: makeTool('c', true),
    };
    const resolver = makeResolver(tools);
    const requests = [
      makeRequest('a', 'id-1'),
      makeRequest('b', 'id-2'),
      makeRequest('c', 'id-3'),
    ];

    const result = partitionToolCalls(requests, resolver);

    expect(result).toHaveLength(1);
    expect(result[0].requests.map((r) => r.callId)).toEqual([
      'id-1',
      'id-2',
      'id-3',
    ]);
  });
});
