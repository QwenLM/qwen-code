/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import {
  microcompactHistory,
  MICROCOMPACT_CLEARED_MESSAGE,
} from './microcompact.js';
import {
  content,
  fnCall,
  fnResponse,
} from '../../test-utils/model-fixtures.js';

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
