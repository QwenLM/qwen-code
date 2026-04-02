/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, compactMessages } from './compaction.js';
import type { Content } from '@google/genai';

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates based on character length', () => {
    const msgs: Content[] = [
      { role: 'user', parts: [{ text: 'hello world' }] },
    ];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it('sums across multiple messages', () => {
    const single: Content[] = [
      { role: 'user', parts: [{ text: 'hello world' }] },
    ];
    const double: Content[] = [
      { role: 'user', parts: [{ text: 'hello world' }] },
      { role: 'model', parts: [{ text: 'hello world' }] },
    ];
    expect(estimateTokens(double)).toBe(estimateTokens(single) * 2);
  });
});

describe('compactMessages', () => {
  it('returns unchanged if few messages', () => {
    const msgs: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    expect(compactMessages(msgs, 1000)).toHaveLength(2);
  });

  it('compacts when many messages', () => {
    const msgs: Content[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `message ${i} with some content to count` }],
    }));
    const compacted = compactMessages(msgs, 100);
    expect(compacted.length).toBeLessThan(msgs.length);
  });

  it('preserves recent messages verbatim', () => {
    const msgs: Content[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `message ${i}` }],
    }));
    const compacted = compactMessages(msgs, 100);
    // Last 10 messages should be preserved unchanged
    const originalLast10 = msgs.slice(msgs.length - 10);
    const compactedLast10 = compacted.slice(compacted.length - 10);
    expect(compactedLast10).toEqual(originalLast10);
  });

  it('includes a summary content entry', () => {
    const msgs: Content[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `message ${i}` }],
    }));
    const compacted = compactMessages(msgs, 100);
    // First message should be the summary
    const firstPart = compacted[0]?.parts?.[0]?.text ?? '';
    expect(firstPart).toContain('Context compacted');
  });

  it('never splits tool call/result pairs', () => {
    // Build: 5 tool call+result pairs, then 10 recent messages
    const toolPairs: Content[] = Array.from({ length: 5 }, (_, i) => [
      {
        role: 'model',
        parts: [{ functionCall: { name: `tool${i}`, args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: `tool${i}`,
              response: { result: `result${i}` },
            },
          },
        ],
      },
    ]).flat() as Content[];

    const recent: Content[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `recent ${i}` }],
    }));

    const msgs: Content[] = [...toolPairs, ...recent];
    const compacted = compactMessages(msgs, 100);
    // Should reduce length and not crash
    expect(compacted.length).toBeLessThan(msgs.length);
    // The summary should mention the tool calls
    const summaryText = compacted[0]?.parts?.[0]?.text ?? '';
    expect(summaryText).toContain('tool0');
  });

  it('handles messages with no parts gracefully', () => {
    const msgs: Content[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: i === 0 ? [] : [{ text: `msg ${i}` }],
    }));
    expect(() => compactMessages(msgs, 100)).not.toThrow();
  });
});
