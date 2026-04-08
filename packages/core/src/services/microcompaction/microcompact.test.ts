/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';

import {
  evaluateTimeBasedTrigger,
  microcompactHistory,
} from './microcompact.js';
import { MICROCOMPACT_CLEARED_MESSAGE } from './microcompact.js';

// Helper to set env vars for testing
function setEnv(vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

function clearEnv() {
  delete process.env['QWEN_MC_ENABLED'];
  delete process.env['QWEN_MC_GAP_THRESHOLD_MINUTES'];
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

describe('evaluateTimeBasedTrigger', () => {
  beforeEach(() => {
    setEnv({
      QWEN_MC_ENABLED: 'true',
      QWEN_MC_GAP_THRESHOLD_MINUTES: '60',
    });
  });

  afterEach(clearEnv);

  it('should return null when disabled', () => {
    setEnv({ QWEN_MC_ENABLED: 'false' });
    const result = evaluateTimeBasedTrigger(Date.now() - 2 * 60 * 60 * 1000);
    expect(result).toBeNull();
  });

  it('should return null when no prior API completion', () => {
    const result = evaluateTimeBasedTrigger(null);
    expect(result).toBeNull();
  });

  it('should return null when gap is under threshold', () => {
    // 5 minutes ago
    const result = evaluateTimeBasedTrigger(Date.now() - 5 * 60 * 1000);
    expect(result).toBeNull();
  });

  it('should fire when gap exceeds threshold', () => {
    // 2 hours ago
    const result = evaluateTimeBasedTrigger(Date.now() - 2 * 60 * 60 * 1000);
    expect(result).not.toBeNull();
    expect(result!.config.gapThresholdMinutes).toBe(60);
    expect(result!.gapMs).toBeGreaterThan(60 * 60 * 1000);
  });

  it('should respect custom threshold from env', () => {
    setEnv({ QWEN_MC_GAP_THRESHOLD_MINUTES: '0.1' }); // 6 seconds
    // 10 seconds ago
    const result = evaluateTimeBasedTrigger(Date.now() - 10 * 1000);
    expect(result).not.toBeNull();
  });

  it('should return null for non-finite gap', () => {
    const result = evaluateTimeBasedTrigger(NaN);
    expect(result).toBeNull();
  });
});

describe('microcompactHistory', () => {
  beforeEach(() => {
    setEnv({
      QWEN_MC_ENABLED: 'true',
      QWEN_MC_GAP_THRESHOLD_MINUTES: '0.001', // ~60ms for testing
      QWEN_MC_KEEP_RECENT: '1',
    });
  });

  afterEach(clearEnv);

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  it('should return history unchanged when trigger does not fire', () => {
    const history: Content[] = [
      makeUserMessage('hello'),
      makeModelMessage('hi'),
    ];
    const result = microcompactHistory(history, Date.now()); // recent timestamp
    expect(result.history).toBe(history); // same reference
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

    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1);
    expect(result.meta!.toolsKept).toBe(1);

    // Old result should be cleared
    const oldResult = result.history[3]!;
    expect(oldResult.parts![0]!.functionResponse!.response!['output']).toBe(
      MICROCOMPACT_CLEARED_MESSAGE,
    );

    // Recent result should be preserved
    const recentResult = result.history[5]!;
    expect(recentResult.parts![0]!.functionResponse!.response!['output']).toBe(
      'recent file content',
    );
  });

  it('should not clear non-compactable tools', () => {
    const history: Content[] = [
      makeToolCall('ask_user_question'),
      makeToolResult('ask_user_question', 'user answer'),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'file content'),
    ];

    setEnv({ QWEN_MC_KEEP_RECENT: '0' }); // clear all compactable
    const result = microcompactHistory(history, twoHoursAgo);

    // ask_user_question should be preserved (not compactable)
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe('user answer');

    // read_file with keepRecent floored to 1 — only 1 compactable tool, so it's kept
    expect(result.meta).toBeUndefined(); // clearSet is empty since keepRecent floors to 1
  });

  it('should skip already-cleared results', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', MICROCOMPACT_CLEARED_MESSAGE),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'new content'),
    ];

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    // First result was already cleared, tokensSaved should be 0 → no-op
    expect(result.meta).toBeUndefined();
  });

  it('should handle keepRecent > compactable count (no-op)', () => {
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', 'only result'),
    ];

    setEnv({ QWEN_MC_KEEP_RECENT: '5' });
    const result = microcompactHistory(history, twoHoursAgo);

    // Only 1 compactable, keepRecent=5, clearSet is empty
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

    setEnv({ QWEN_MC_KEEP_RECENT: '0' }); // should floor to 1
    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1);
    expect(result.meta!.toolsKept).toBe(1);

    // First (old) should be cleared
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
    // Second (recent) should be kept
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

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    // Text part should be preserved
    expect(result.history[0]!.parts![0]!.text).toBe('some text');
    // functionResponse should be cleared
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

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    // Name should still be 'read_file' on cleared result
    expect(result.history[1]!.parts![0]!.functionResponse!.name).toBe(
      'read_file',
    );
  });

  it('should count per-part not per-Content for batched tool results', () => {
    // 3 tool results batched in a single Content entry (parallel tool calls)
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

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    // keepRecent=1 means keep only the last 1 part, clear the other 2
    expect(result.meta!.toolsCleared).toBe(2);
    expect(result.meta!.toolsKept).toBe(1);

    const parts = result.history[1]!.parts!;
    // First two should be cleared
    expect(parts[0]!.functionResponse!.response!['output']).toBe(
      MICROCOMPACT_CLEARED_MESSAGE,
    );
    expect(parts[1]!.functionResponse!.response!['output']).toBe(
      MICROCOMPACT_CLEARED_MESSAGE,
    );
    // Last one (most recent) should be preserved
    expect(parts[2]!.functionResponse!.response!['output']).toBe('file-c');
  });

  it('should handle mixed batched and separate tool results', () => {
    const history: Content[] = [
      // Turn 1: single read
      makeToolCall('read_file'),
      makeToolResult('read_file', 'old-single'),
      // Turn 2: batched reads (2 results in one Content)
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

    // keepRecent=2: keep the 2 most recent parts (batched-read + batched-grep)
    setEnv({ QWEN_MC_KEEP_RECENT: '2' });
    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    expect(result.meta!.toolsCleared).toBe(1); // old-single cleared
    expect(result.meta!.toolsKept).toBe(2); // batched-read + batched-grep kept

    // Single result cleared
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBe(MICROCOMPACT_CLEARED_MESSAGE);
    // Batched results preserved
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

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    // Error response should be preserved (not cleared)
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['error'],
    ).toBe('File not found: /missing.txt');
    // No output field should have been added
    expect(
      result.history[1]!.parts![0]!.functionResponse!.response!['output'],
    ).toBeUndefined();
  });

  it('should estimate tokens saved', () => {
    const longContent = 'x'.repeat(400); // ~100 tokens at 4 chars/token
    const history: Content[] = [
      makeToolCall('read_file'),
      makeToolResult('read_file', longContent),
      makeToolCall('read_file'),
      makeToolResult('read_file', 'recent'),
    ];

    setEnv({ QWEN_MC_KEEP_RECENT: '1' });
    const result = microcompactHistory(history, twoHoursAgo);

    expect(result.meta).toBeDefined();
    expect(result.meta!.tokensSaved).toBe(100);
  });
});
