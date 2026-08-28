/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  configureContextUsageAttributeLengthLimit,
  isValidContextUsage,
  normalizeContextUsage,
  serializeContextUsage,
  serializeContextUsageForSpanStart,
  type ContextUsageV1,
} from './context-usage.js';

afterEach(() => {
  configureContextUsageAttributeLengthLimit(undefined);
});

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

  it('keeps provider-total normalization exact near the safe-integer limit', () => {
    const providerTotal = 7_499_999_999_999_871;
    const normalized = normalizeContextUsage(
      snapshot({
        system_prompt_tokens: 1_500_000_000_000_000,
        builtin_tools_tokens: 1_500_000_000_000_000,
        mcp_tools_tokens: 1_500_000_000_000_000,
        memory_files_tokens: 1_500_000_000_000_000,
        skills_tokens: 1_500_000_000_000_000,
        messages_tokens: 0,
      }),
      providerTotal,
    );

    expect(
      Object.values(normalized.breakdown).reduce(
        (sum, tokens) => sum + tokens,
        0,
      ),
    ).toBe(providerTotal);
  });

  it('normalizes when individually safe categories have an unsafe sum', () => {
    const providerTotal = 9_000_000_000_000_000;
    const normalized = normalizeContextUsage(
      snapshot({
        system_prompt_tokens: 2_000_000_000_000_000,
        builtin_tools_tokens: 2_000_000_000_000_000,
        mcp_tools_tokens: 2_000_000_000_000_000,
        memory_files_tokens: 2_000_000_000_000_000,
        skills_tokens: 2_000_000_000_000_000,
        messages_tokens: 0,
      }),
      providerTotal,
    );

    expect(
      Object.values(normalized.breakdown).reduce(
        (sum, tokens) => sum + tokens,
        0,
      ),
    ).toBe(providerTotal);
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

  it('rejects missing or malformed nested shapes without throwing', () => {
    for (const invalid of [
      null,
      {},
      { version: 1, estimated: true },
      { version: 1, estimated: true, breakdown: null },
      { version: 1, estimated: true, breakdown: 1 },
    ]) {
      expect(isValidContextUsage(invalid)).toBe(false);
      expect(serializeContextUsage(invalid)).toBeUndefined();
    }
  });

  it('serializes only the fixed versioned schema keys', () => {
    const value = {
      version: 1,
      window_size_tokens: 100,
      breakdown: {
        system_prompt_tokens: 1,
        builtin_tools_tokens: 2,
        mcp_tools_tokens: 3,
        memory_files_tokens: 4,
        skills_tokens: 5,
        messages_tokens: 6,
        debugPrompt: 'nested secret',
      },
      compaction_reserve_tokens: 10,
      estimated: true,
      debugPrompt: 'top-level secret',
    };

    const serialized = serializeContextUsage(value);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain('debugPrompt');
    expect(serialized).not.toContain('secret');
    expect(Object.keys(JSON.parse(serialized!))).toEqual([
      'version',
      'window_size_tokens',
      'breakdown',
      'compaction_reserve_tokens',
      'estimated',
    ]);
  });

  it('reads each canonical field only once before serializing', () => {
    let windowSizeReads = 0;
    let breakdownReads = 0;
    const breakdown = {
      system_prompt_tokens: 1,
      builtin_tools_tokens: 2,
      mcp_tools_tokens: 3,
      memory_files_tokens: 4,
      skills_tokens: 5,
      messages_tokens: 6,
    };
    const value = {
      version: 1,
      get window_size_tokens() {
        windowSizeReads++;
        return windowSizeReads < 3 ? 100 : { debugPrompt: 'secret' };
      },
      get breakdown() {
        breakdownReads++;
        return breakdown;
      },
      compaction_reserve_tokens: 10,
      estimated: true,
    };

    const serialized = serializeContextUsage(value);
    expect(windowSizeReads).toBe(1);
    expect(breakdownReads).toBe(1);
    expect(serialized).toContain('"window_size_tokens":100');
    expect(serialized).not.toContain('secret');
  });

  it('omits JSON that the effective OTel span limit would truncate', () => {
    const value: ContextUsageV1 = {
      version: 1,
      window_size_tokens: Number.MAX_SAFE_INTEGER,
      breakdown: {
        system_prompt_tokens: Number.MAX_SAFE_INTEGER,
        builtin_tools_tokens: Number.MAX_SAFE_INTEGER,
        mcp_tools_tokens: Number.MAX_SAFE_INTEGER,
        memory_files_tokens: Number.MAX_SAFE_INTEGER,
        skills_tokens: Number.MAX_SAFE_INTEGER,
        messages_tokens: Number.MAX_SAFE_INTEGER,
      },
      compaction_reserve_tokens: Number.MAX_SAFE_INTEGER,
      available_before_compaction_tokens: Number.MAX_SAFE_INTEGER,
      estimated: true,
    };

    configureContextUsageAttributeLengthLimit(256);
    expect(serializeContextUsage(value)).toBeUndefined();

    configureContextUsageAttributeLengthLimit(0);
    expect(serializeContextUsage(value)).toBeDefined();
  });

  it('preflights the longest finite available-token spelling', () => {
    const value: ContextUsageV1 = {
      version: 1,
      window_size_tokens: 100,
      breakdown: {
        system_prompt_tokens: 1,
        builtin_tools_tokens: 1,
        mcp_tools_tokens: 1,
        memory_files_tokens: 1,
        skills_tokens: 1,
        messages_tokens: 0,
      },
      compaction_reserve_tokens: 10,
      estimated: true,
    };
    const shorterWorstCase = JSON.stringify({
      ...value,
      breakdown: {
        ...value.breakdown,
        messages_tokens: Number.MAX_SAFE_INTEGER,
      },
      available_before_compaction_tokens: Number.MAX_VALUE,
    });

    configureContextUsageAttributeLengthLimit(shorterWorstCase.length);

    expect(serializeContextUsageForSpanStart(value)).toBeUndefined();
  });
});
