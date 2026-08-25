/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const CONTEXT_USAGE_ATTRIBUTE = 'qwen-code.context.usage';
const MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH = 1024;

const FIXED_CATEGORY_KEYS = [
  'system_prompt_tokens',
  'builtin_tools_tokens',
  'mcp_tools_tokens',
  'memory_files_tokens',
  'skills_tokens',
] as const;
const CATEGORY_KEYS = [...FIXED_CATEGORY_KEYS, 'messages_tokens'] as const;

type FixedCategoryKey = (typeof FIXED_CATEGORY_KEYS)[number];

export interface ContextUsageV1 {
  version: 1;
  window_size_tokens: number;
  breakdown: {
    system_prompt_tokens: number;
    builtin_tools_tokens: number;
    mcp_tools_tokens: number;
    memory_files_tokens: number;
    skills_tokens: number;
    messages_tokens: number;
  };
  compaction_reserve_tokens: number;
  available_before_compaction_tokens?: number;
  estimated: true;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function isValidContextUsage(value: ContextUsageV1): boolean {
  return (
    value.version === 1 &&
    value.estimated === true &&
    Number.isSafeInteger(value.window_size_tokens) &&
    value.window_size_tokens > 0 &&
    isNonNegativeFinite(value.compaction_reserve_tokens) &&
    (value.available_before_compaction_tokens === undefined ||
      isNonNegativeFinite(value.available_before_compaction_tokens)) &&
    CATEGORY_KEYS.every((key) => {
      const tokens = value.breakdown[key];
      return Number.isSafeInteger(tokens) && tokens >= 0;
    })
  );
}

export function normalizeContextUsage(
  snapshot: ContextUsageV1,
  providerTotal: number,
): ContextUsageV1 {
  if (
    !isValidContextUsage(snapshot) ||
    !Number.isSafeInteger(providerTotal) ||
    providerTotal < 0
  ) {
    return snapshot;
  }

  const fixedSum = FIXED_CATEGORY_KEYS.reduce(
    (sum, key) => sum + snapshot.breakdown[key],
    0,
  );
  if (!Number.isSafeInteger(fixedSum)) return snapshot;

  let fixed: Record<FixedCategoryKey, number>;
  let messagesTokens: number;
  if (fixedSum > providerTotal) {
    const allocations = FIXED_CATEGORY_KEYS.map((key, index) => {
      const exact = (snapshot.breakdown[key] * providerTotal) / fixedSum;
      const floor = Math.floor(exact);
      return { key, index, floor, remainder: exact - floor };
    });
    let remaining =
      providerTotal - allocations.reduce((sum, item) => sum + item.floor, 0);
    const rankedAllocations = [...allocations].sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    );
    for (const allocation of rankedAllocations) {
      if (remaining === 0) break;
      allocation.floor++;
      remaining--;
    }
    fixed = Object.fromEntries(
      allocations.map((allocation) => [allocation.key, allocation.floor]),
    ) as Record<FixedCategoryKey, number>;
    messagesTokens = 0;
  } else {
    fixed = Object.fromEntries(
      FIXED_CATEGORY_KEYS.map((key) => [key, snapshot.breakdown[key]]),
    ) as Record<FixedCategoryKey, number>;
    messagesTokens = providerTotal - fixedSum;
  }

  return {
    ...snapshot,
    breakdown: {
      ...fixed,
      messages_tokens: messagesTokens,
    },
    available_before_compaction_tokens: Math.max(
      0,
      snapshot.window_size_tokens -
        snapshot.compaction_reserve_tokens -
        providerTotal,
    ),
  };
}

export function serializeContextUsage(
  contextUsage: ContextUsageV1 | undefined,
): string | undefined {
  if (!contextUsage || !isValidContextUsage(contextUsage)) return undefined;
  try {
    const serialized = JSON.stringify(contextUsage);
    return serialized.length <= MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}
