/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeContextUsage,
  serializeContextUsage,
  type ContextUsageV1,
} from './context-usage.js';

describe('normalizeContextUsage', () => {
  function snapshot(breakdown: ContextUsageV1['breakdown']): ContextUsageV1 {
    return {
      version: 1,
      window_size_tokens: 20,
      breakdown,
      compaction_reserve_tokens: 3,
      estimated: true,
    };
  }

  it('uses messages as the residual when fixed categories fit', () => {
    const normalized = normalizeContextUsage(
      snapshot({
        system_prompt_tokens: 1,
        builtin_tools_tokens: 1,
        mcp_tools_tokens: 1,
        memory_files_tokens: 1,
        skills_tokens: 1,
        messages_tokens: 99,
      }),
      10,
    );

    expect(normalized.breakdown).toEqual({
      system_prompt_tokens: 1,
      builtin_tools_tokens: 1,
      mcp_tools_tokens: 1,
      memory_files_tokens: 1,
      skills_tokens: 1,
      messages_tokens: 5,
    });
    expect(normalized.available_before_compaction_tokens).toBe(7);
  });

  it('uses deterministic largest-remainder scaling when fixed categories exceed the total', () => {
    const normalized = normalizeContextUsage(
      snapshot({
        system_prompt_tokens: 1,
        builtin_tools_tokens: 1,
        mcp_tools_tokens: 1,
        memory_files_tokens: 1,
        skills_tokens: 1,
        messages_tokens: 99,
      }),
      3,
    );

    expect(normalized.breakdown).toEqual({
      system_prompt_tokens: 1,
      builtin_tools_tokens: 1,
      mcp_tools_tokens: 1,
      memory_files_tokens: 0,
      skills_tokens: 0,
      messages_tokens: 0,
    });
    expect(Object.keys(normalized.breakdown)).toEqual([
      'system_prompt_tokens',
      'builtin_tools_tokens',
      'mcp_tools_tokens',
      'memory_files_tokens',
      'skills_tokens',
      'messages_tokens',
    ]);
    expect(
      Object.values(normalized.breakdown).reduce(
        (sum, tokens) => sum + tokens,
        0,
      ),
    ).toBe(3);
  });
});

describe('serializeContextUsage', () => {
  it('emits compact JSON and rejects invalid category values', () => {
    const valid: ContextUsageV1 = {
      version: 1,
      window_size_tokens: 100,
      breakdown: {
        system_prompt_tokens: 1,
        builtin_tools_tokens: 2,
        mcp_tools_tokens: 3,
        memory_files_tokens: 4,
        skills_tokens: 5,
        messages_tokens: 6,
      },
      compaction_reserve_tokens: 10,
      estimated: true,
    };

    const serialized = serializeContextUsage(valid);
    expect(serialized).toBe(JSON.stringify(valid));
    expect(serialized).not.toContain('\n');
    expect(
      serializeContextUsage({
        ...valid,
        breakdown: { ...valid.breakdown, messages_tokens: -1 },
      }),
    ).toBeUndefined();
  });
});
