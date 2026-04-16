/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, afterEach } from 'vitest';
import type { Content } from '@google/genai';
import type { ClearContextOnIdleSettings } from '../../config/config.js';

import {
  evaluateTimeBasedTrigger,
  microcompactHistory,
  MICROCOMPACT_CLEARED_MESSAGE,
} from './microcompact.js';

function clearEnv() {
  delete process.env['QWEN_MC_KEEP_RECENT'];
}

function makeToolCall(name: string): Content {
  return {
    role: 'model',
    parts: [{ functionCall: { name, args: {} } }],
  };
}

function makeToolResult(name: string, output: string): Content {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response: { output } } }],
  };
}

function makeUserMessage(text: string): Content {
  return { role: 'user', parts: [{ text }] };
}

function makeModelMessage(text: string): Content {
  return { role: 'model', parts: [{ text }] };
}

const DEFAULT_SETTINGS: ClearContextOnIdleSettings = {
  thinkingThresholdMinutes: 5,
  toolResultsThresholdMinutes: 5,
  toolResultsNumToKeep: 1,
};

describe('evaluateTimeBasedTrigger', () => {
  it('should return null when disabled (-1)', () => {
    const result = evaluateTimeBasedTrigger(Date.now() - 2 * 60 * 60 * 1000, {
      ...DEFAULT_SETTINGS,
      toolResultsThresholdMinutes: -1,
    });
    expect(result).toBeNull();
  });

  it('should return null when no prior API completion', () => {
    const result = evaluateTimeBasedTrigger(null, DEFAULT_SETTINGS);
    expect(result).toBeNull();
  });

  it('should return null when gap is under threshold', () => {
    const result = evaluateTimeBasedTrigger(
      Date.now() - 1 * 60 * 1000,
      DEFAULT_SETTINGS,
    );
    expect(result).toBeNull();
  });

  it('should fire when gap exceeds threshold', () => {
    const result = evaluateTimeBasedTrigger(
      Date.now() - 10 * 60 * 1000,
      DEFAULT_SETTINGS,
    );
    expect(result).not.toBeNull();
    expect(result!.gapMs).toBeGreaterThan(5 * 60 * 1000);
  });

  it('should respect custom threshold', () => {
    const result = evaluateTimeBasedTrigger(Date.now() - 10 * 1000, {
      ...DEFAULT_SETTINGS,
      toolResultsThresholdMinutes: 0.1,
    });
    expect(result).not.toBeNull();
  });

  it('should return null for non-finite gap', () => {
    const result = evaluateTimeBasedTrigger(NaN, DEFAULT_SETTINGS);
    expect(result).toBeNull();
  });
});

describe('microcompactHistory', () => {
  afterEach(clearEnv);

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  it('should return history unchanged when trigger does not fire', () => {
    const history: Content[] = [
      makeUserMessage('hello'),
      makeModelMessage('hi'),
    ];
    const result = microcompactHistory(history, Date.now(), DEFAULT_SETTINGS);
    expect(result.history).toBe(history);
    expect(result.meta).toBeUndefined();
  });

  it('should clear old compactable tool results and keep recent', () => {
    const history: Content[] = [
      makeUserMessage('msg1'),
      makeModelMessage('resp1'),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'old file content that is very long'),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent file content'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1);
    expect(result.meta!.toolsKept).toBe(1);

    expect(
      result.history[3]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
    expect(
      result.history[5]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('recent file content');
  });

  it('should not clear non-compactable tools', () => {
    const history: Content[] = [
      makeToolCall('ask_user_question'),
      makeToolResult('ask_user_question', 'user answer'),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'file content'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, {
      ...DEFAULT_SETTINGS,
      toolResultsNumToKeep: 0,
    });

    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('user answer');
    // keepRecent floored to 1 — only 1 compactable, so it's kept
    expect(result.meta).toBeUndefined();
  });

  it('should skip already-cleared results', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', MICROCOMPACT_CLEARED_MESSAGE),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'new content'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);
    expect(result.meta).toBeUndefined();
  });

  it('should handle keepRecent > compactable count (no-op)', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', 'only result'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, {
      ...DEFAULT_SETTINGS,
      toolResultsNumToKeep: 5,
    });

    expect(result.meta).toBeUndefined();
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('only result');
  });

  it('should floor keepRecent to 1', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', 'old content'),
      makeToolCall('grep_search'),
      makeToolResult('grep_search', 'grep results'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, {
      ...DEFAULT_SETTINGS,
      toolResultsNumToKeep: 0,
    });

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1);
    expect(result.meta!.toolsKept).toBe(1);

    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
    expect(
      result.history[3]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('grep results');
  });

  it('should preserve non-functionResponse parts in cleared Content', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'some text' },
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'file content' },
            },
          },
        ],
      },
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(result.meta).toBeDefined();
    expect(result.history[0]!.parts![0]!.text).toBe('some text');
    expect(
      result.history[0]!.parts![1]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
  });

  it('should preserve functionResponse name after clearing', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', 'content'),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(result.history[1]!.parts![0]!.functionResponse!.name).toBe(
      'read_file',
    );
  });

  it('should count per-part not per-Content for batched tool results', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: {} } },
          { functionCall: { name: 'read_file', args: {} } },
          { functionCall: { name: 'read_file', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'file-a' },
            },
          },
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'file-b' },
            },
          },
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'file-c' },
            },
          },
        ],
      },
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(2);
    expect(result.meta!.toolsKept).toBe(1);

    const parts = result.history[1]!.parts!;
    expect(parts[0]!.functionResponse!.response!['output']).toBe(
      MICROCOMPACT_CLEARED_MESSAGE,
    );
    expect(parts[1]!.functionResponse!.response!['output']).toBe(
      MICROCOMPACT_CLEARED_MESSAGE,
    );
    expect(parts[2]!.functionResponse!.response!['output']).toBe('file-c');
  });

  it('should handle mixed batched and separate tool results', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', 'old-single'),
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: {} } },
          { functionCall: { name: 'grep_search', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'batched-read' },
            },
          },
          {
            functionResponse: {
              name: 'grep_search',
              response: { output: 'batched-grep' },
            },
          },
        ],
      },
    ];

    const result = microcompactHistory(history, twoHoursAgo, {
      ...DEFAULT_SETTINGS,
      toolResultsNumToKeep: 2,
    });

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1);
    expect(result.meta!.toolsKept).toBe(2);

    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
    expect(
      result.history[3]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('batched-read');
    expect(
      result.history[3]!.parts![1]!.functionResponse!.response!['output'],
    ).toBe('batched-grep');
  });

  it('should not clear tool error responses', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { error: 'File not found: /missing.txt' },
            },
          },
        ],
      },
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent content'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['error'],
    ).toBe('File not found: /missing.txt');
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBeUndefined();
  });

  it('should estimate tokens saved', () => {
    const longContent = 'x'.repeat(400);
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', longContent),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent'),
    ];

    const result = microcompactHistory(history, twoHoursAgo, DEFAULT_SETTINGS);

    expect(result.meta).toBeDefined();
    expect(result.meta!.tokensSaved).toBe(100);
  });
});
