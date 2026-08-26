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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function cloneContextUsage(value: unknown): ContextUsageV1 | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const breakdown = value['breakdown'];
    if (!isRecord(breakdown)) return undefined;
    const windowSizeTokens = value['window_size_tokens'];
    const compactionReserveTokens = value['compaction_reserve_tokens'];
    const availableBeforeCompactionTokens =
      value['available_before_compaction_tokens'];
    const categoryTokens = Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, breakdown[key]]),
    ) as Record<(typeof CATEGORY_KEYS)[number], unknown>;
    const valid =
      value['version'] === 1 &&
      value['estimated'] === true &&
      Number.isSafeInteger(windowSizeTokens) &&
      (windowSizeTokens as number) > 0 &&
      isNonNegativeFinite(compactionReserveTokens) &&
      (availableBeforeCompactionTokens === undefined ||
        isNonNegativeFinite(availableBeforeCompactionTokens)) &&
      CATEGORY_KEYS.every(
        (key) =>
          Number.isSafeInteger(categoryTokens[key]) &&
          (categoryTokens[key] as number) >= 0,
      );
    if (!valid) return undefined;
    return {
      version: 1,
      window_size_tokens: windowSizeTokens as number,
      breakdown: {
        system_prompt_tokens: categoryTokens.system_prompt_tokens as number,
        builtin_tools_tokens: categoryTokens.builtin_tools_tokens as number,
        mcp_tools_tokens: categoryTokens.mcp_tools_tokens as number,
        memory_files_tokens: categoryTokens.memory_files_tokens as number,
        skills_tokens: categoryTokens.skills_tokens as number,
        messages_tokens: categoryTokens.messages_tokens as number,
      },
      compaction_reserve_tokens: compactionReserveTokens as number,
      ...(availableBeforeCompactionTokens === undefined
        ? {}
        : {
            available_before_compaction_tokens:
              availableBeforeCompactionTokens as number,
          }),
      estimated: true,
    };
  } catch {
    return undefined;
  }
}

export function isValidContextUsage(value: unknown): value is ContextUsageV1 {
  return cloneContextUsage(value) !== undefined;
}

export function normalizeContextUsage(
  snapshot: ContextUsageV1,
  providerTotal: number,
): ContextUsageV1 {
  const validSnapshot = cloneContextUsage(snapshot);
  if (
    !validSnapshot ||
    !Number.isSafeInteger(providerTotal) ||
    providerTotal < 0
  ) {
    return snapshot;
  }

  const providerTotalBigInt = BigInt(providerTotal);
  const fixedSum = FIXED_CATEGORY_KEYS.reduce(
    (sum, key) => sum + BigInt(validSnapshot.breakdown[key]),
    0n,
  );

  let fixed: Record<FixedCategoryKey, number>;
  let messagesTokens: number;
  if (fixedSum > providerTotalBigInt) {
    const allocations = FIXED_CATEGORY_KEYS.map((key, index) => {
      const numerator =
        BigInt(validSnapshot.breakdown[key]) * providerTotalBigInt;
      return {
        key,
        index,
        floor: numerator / fixedSum,
        remainder: numerator % fixedSum,
      };
    });
    let remaining =
      providerTotalBigInt -
      allocations.reduce((sum, item) => sum + item.floor, 0n);
    const rankedAllocations = [...allocations].sort((left, right) => {
      if (left.remainder === right.remainder) {
        return left.index - right.index;
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
    for (const allocation of rankedAllocations) {
      if (remaining === 0n) break;
      allocation.floor += 1n;
      remaining -= 1n;
    }
    fixed = Object.fromEntries(
      allocations.map((allocation) => [
        allocation.key,
        Number(allocation.floor),
      ]),
    ) as Record<FixedCategoryKey, number>;
    messagesTokens = 0;
  } else {
    fixed = Object.fromEntries(
      FIXED_CATEGORY_KEYS.map((key) => [key, validSnapshot.breakdown[key]]),
    ) as Record<FixedCategoryKey, number>;
    messagesTokens = Number(providerTotalBigInt - fixedSum);
  }

  return {
    ...validSnapshot,
    breakdown: {
      ...fixed,
      messages_tokens: messagesTokens,
    },
    available_before_compaction_tokens: Math.max(
      0,
      validSnapshot.window_size_tokens -
        validSnapshot.compaction_reserve_tokens -
        providerTotal,
    ),
  };
}

export function serializeContextUsage(
  contextUsage: unknown,
): string | undefined {
  try {
    const canonical = cloneContextUsage(contextUsage);
    if (!canonical) return undefined;
    const serialized = JSON.stringify(canonical);
    return serialized.length <= MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}
