/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { ClearContextOnIdleSettings } from '../../config/config.js';
import {
  collectResidentMemoryBodies,
  microcompactHistory,
  MICROCOMPACT_CLEARED_MESSAGE,
} from './microcompact.js';
import {
  content,
  fnCall,
  fnResponse,
} from '../../test-utils/model-fixtures.js';

function makeToolResult(name: string, output: string): Content {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response: { output } } }],
  };
}

function makeMemoryResult(
  ref: string,
  content: string,
  mtimeMs = 1,
  range = { start: 0, end: content.length, total: content.length },
): Content {
  return makeToolResult(
    'search_memory',
    JSON.stringify({
      mode: 'fetch',
      results: [{ ref, version: mtimeMs, content, range }],
    }),
  );
}

function makeMemorySearchResult(
  ref: string,
  content: string,
  range = { start: 0, end: content.length, total: content.length + 1 },
): Content {
  return makeToolResult(
    'search_memory',
    JSON.stringify({
      mode: 'search',
      results: [
        {
          ref,
          version: 1,
          content,
          range,
        },
      ],
    }),
  );
}

function makeBridgedToolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          id,
          name: 'tool_call',
          args: { name, arguments: args },
        },
      },
    ],
  };
}

function makeBridgedToolResult(id: string, output: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id,
          name: 'tool_call',
          response: { output },
        },
      },
    ],
  };
}

const bridge = (id: string, name: unknown, file = '/proj/a.ts') =>
  content(
    'model',
    fnCall('tool_call', { name, arguments: { file_path: file } }, id),
  );
const result = (id: string, output: string, name = 'tool_call') =>
  content('user', fnResponse(name, { output }, id));
const fileCall = (id: string, name: string, file: string) =>
  content('model', fnCall(name, { file_path: file }, id));
const idle = (history: Content[]) =>
  microcompactHistory(history, Date.now() - 2 * 60 * 60 * 1000, {
    toolResultsThresholdMinutes: 5,
    toolResultsNumToKeep: 1,
  });
const sized = (history: Content[]) =>
  microcompactHistory(history, Date.now(), {
    toolResultsThresholdMinutes: 60,
    toolResultsNumToKeep: 0,
    toolResultsTotalCharsThreshold: 100,
  });

describe('microcompaction identity and file residency', () => {
  beforeEach(() => vi.stubEnv('QWEN_MC_KEEP_RECENT', undefined));
  afterEach(() => vi.unstubAllEnvs());

  it('size-compacts old skill output while keeping the latest instructions', () => {
    const compacted = microcompactHistory(
      [
        content('model', fnCall('skill', { name: 'old' }, 'old')),
        result('old', 'old skill instructions '.repeat(20), 'skill'),
        content('model', fnCall('skill', { name: 'new' }, 'new')),
        result('new', 'recent skill instructions', 'skill'),
      ],
      Date.now(),
      {
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 1,
        toolResultsTotalCharsThreshold: 100,
      },
    );
    expect(compacted.meta).toMatchObject({
      triggerReason: 'size',
      toolsCleared: 1,
      toolsKept: 1,
    });
    expect(compacted.history[1]!.parts![0]!.functionResponse!.response).toEqual(
      {
        output: MICROCOMPACT_CLEARED_MESSAGE,
      },
    );
    expect(compacted.history[3]!.parts![0]!.functionResponse!.response).toEqual(
      {
        output: 'recent skill instructions',
      },
    );
  });

  it.each(['grep_search', 42])(
    'preserves ambiguous bridged history with sibling target %s',
    (target) => {
      const history = [
        bridge('reused', 'read_file'),
        bridge('reused', target),
        result('reused', 'ambiguous output'.repeat(100)),
      ];
      const compacted = sized(history);
      expect(compacted.meta).toBeUndefined();
      expect(compacted.history).toBe(history);
    },
  );

  it('clears a bridged read and reports its inner path for cache invalidation', () => {
    const compacted = idle([
      bridge('old', 'read_file'),
      result('old', 'old '.repeat(100)),
      bridge('new', 'web_fetch'),
      result('new', 'recent'),
    ]);
    expect(compacted.meta).toMatchObject({
      toolsCleared: 1,
      evictedReadPaths: ['/proj/a.ts'],
      unresolvedEvictedReads: 0,
    });
    expect(compacted.history[1]!.parts![0]!.functionResponse!.response).toEqual(
      {
        output: MICROCOMPACT_CLEARED_MESSAGE,
      },
    );
  });

  it.each([
    { keptTool: 'read_file', evicted: ['/proj/a.ts'] },
    { keptTool: 'edit', evicted: ['/proj/a.ts'] },
    { keptTool: 'write_file', evicted: [] },
  ])(
    'only a kept full write proves residency: $keptTool',
    ({ keptTool, evicted }) => {
      const compacted = idle([
        fileCall('old', 'read_file', '/proj/a.ts'),
        result('old', 'old '.repeat(100), 'read_file'),
        fileCall('keep', keptTool, '/proj/a.ts'),
        result('keep', 'recent', keptTool),
      ]);
      expect(compacted.meta).toMatchObject({
        toolsCleared: 1,
        evictedReadPaths: evicted,
        unresolvedEvictedReads: 0,
      });
    },
  );

  it('disarms every candidate path when a reused id spans two files', () => {
    const compacted = idle([
      fileCall('dup', 'read_file', '/proj/a.ts'),
      result('dup', 'old '.repeat(100), 'read_file'),
      fileCall('dup', 'read_file', '/proj/b.ts'),
      result('dup', 'kept', 'read_file'),
    ]);
    expect(compacted.meta).toMatchObject({
      toolsCleared: 1,
      unresolvedEvictedReads: 0,
    });
    expect([...compacted.meta!.evictedReadPaths].sort()).toEqual([
      '/proj/a.ts',
      '/proj/b.ts',
    ]);
  });

  it('does not let a pending cache-hit placeholder protect an evicted full read', () => {
    const history = [
      fileCall('old', 'read_file', '/proj/a.ts'),
      result('old', 'full bytes '.repeat(100), 'read_file'),
      fileCall('keep', 'read_file', '/proj/b.ts'),
      result('keep', 'recent', 'read_file'),
      fileCall('pending', 'read_file', '/proj/a.ts'),
    ];
    const compacted = microcompactHistory(
      history,
      Date.now(),
      {
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 1,
        toolResultsTotalCharsThreshold: 100,
      },
      {
        sizeOnly: true,
        pendingContent: result(
          'pending',
          '[File a.ts unchanged since last read in this session]',
          'read_file',
        ),
      },
    );
    expect(compacted.meta).toMatchObject({
      triggerReason: 'size',
      toolsCleared: 1,
      evictedReadPaths: ['/proj/a.ts'],
      unresolvedEvictedReads: 0,
    });
    expect(
      compacted.history[1]!.parts![0]!.functionResponse!.response?.['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
  });
});

describe('microcompactHistory memory body eviction', () => {
  const settings: ClearContextOnIdleSettings = {
    toolResultsThresholdMinutes: 60,
    toolResultsNumToKeep: 1,
  };

  it.each([false, true])(
    'reports a cleared memory ref through the tool bridge: %s',
    (bridged) => {
      const history = [
        makeMemoryResult('project:old.md', 'old body'),
        makeMemoryResult('project:new.md', 'new body'),
      ];
      if (bridged) {
        const output = history[0]!.parts![0]!.functionResponse!.response![
          'output'
        ] as string;
        history.splice(
          0,
          1,
          makeBridgedToolCall('memory-call', 'search_memory'),
          makeBridgedToolResult('memory-call', output),
        );
      }
      expect(collectResidentMemoryBodies(history)).toContainEqual({
        memoryRef: 'project:old.md',
        mtimeMs: 1,
      });

      const result = microcompactHistory(history, Date.now(), settings, {
        force: true,
      });

      expect(result.meta?.evictedMemoryBodies).toEqual([
        { memoryRef: 'project:old.md', mtimeMs: 1 },
      ]);
    },
  );

  it('reports an unresolved memory body when result JSON is not intact', () => {
    const corrupted = makeMemoryResult('project:old.md', 'old body');
    const response = corrupted.parts?.[0]?.functionResponse?.response;
    if (response) {
      response['output'] =
        `${response['output']}\n\n<system-reminder>hook</system-reminder>`;
    }

    const result = microcompactHistory(
      [corrupted, makeMemoryResult('project:new.md', 'new body')],
      Date.now(),
      settings,
      { force: true },
    );

    expect(result.meta?.unresolvedEvictedMemoryBodies).toBe(1);
  });

  it('keeps a ref resident when another body result remains in history', () => {
    const history = [
      makeMemoryResult('project:same.md', 'old window'),
      makeMemoryResult('project:same.md', 'new window'),
    ];

    const result = microcompactHistory(history, Date.now(), settings, {
      force: true,
    });

    expect(result.meta?.evictedMemoryBodies).toEqual([]);
  });

  it('distinguishes old and current versions of the same ref', () => {
    const history = [
      makeMemoryResult('project:same.md', 'old version', 1),
      makeMemoryResult('project:same.md', 'current version', 2),
    ];

    const result = microcompactHistory(history, Date.now(), settings, {
      force: true,
    });

    expect(result.meta?.evictedMemoryBodies).toEqual([
      { memoryRef: 'project:same.md', mtimeMs: 1 },
    ]);
  });

  it('does not count an uncommitted pending body result as resident', () => {
    const old = makeMemoryResult('project:same.md', 'x'.repeat(100), 1);
    const pending = makeMemoryResult('project:same.md', 'current body', 1);

    const result = microcompactHistory(
      [old, makeMemoryResult('project:other.md', 'recent body', 1)],
      Date.now(),
      {
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 1,
        toolResultsTotalCharsThreshold: 10,
      },
      { sizeOnly: true, pendingContent: pending },
    );

    expect(result.meta?.evictedMemoryBodies).toEqual([
      { memoryRef: 'project:same.md', mtimeMs: 1 },
    ]);
  });

  it('does not treat a search window as a resident full body', () => {
    const result = microcompactHistory(
      [
        makeMemoryResult('project:same.md', 'full body'),
        makeMemorySearchResult('project:same.md', 'search window'),
      ],
      Date.now(),
      settings,
      { force: true },
    );

    expect(result.meta?.evictedMemoryBodies).toEqual([
      { memoryRef: 'project:same.md', mtimeMs: 1 },
    ]);
  });

  it('requires resident fetch windows to cover the complete body', () => {
    const result = microcompactHistory(
      [
        makeMemoryResult('project:same.md', 'first', 1, {
          start: 0,
          end: 5,
          total: 10,
        }),
        makeMemoryResult('project:other.md', 'recent'),
      ],
      Date.now(),
      settings,
      { force: true },
    );

    expect(result.meta?.evictedMemoryBodies).toEqual([
      { memoryRef: 'project:same.md', mtimeMs: 1 },
    ]);
  });

  it('combines contiguous fetch windows into a resident body', () => {
    const history = [
      makeMemoryResult('project:same.md', 'first', 1, {
        start: 0,
        end: 5,
        total: 10,
      }),
      makeMemoryResult('project:same.md', 'second', 1, {
        start: 5,
        end: 10,
        total: 10,
      }),
    ];

    expect(collectResidentMemoryBodies(history)).toEqual([
      { memoryRef: 'project:same.md', mtimeMs: 1 },
    ]);
  });

  it('does not combine fetch windows with a gap', () => {
    const history = [
      makeMemoryResult('project:same.md', 'first', 1, {
        start: 0,
        end: 4,
        total: 10,
      }),
      makeMemoryResult('project:same.md', 'second', 1, {
        start: 5,
        end: 10,
        total: 10,
      }),
    ];

    expect(collectResidentMemoryBodies(history)).toEqual([]);
  });
});
