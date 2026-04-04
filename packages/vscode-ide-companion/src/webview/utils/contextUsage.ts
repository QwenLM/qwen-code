/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelInfo } from '@agentclientprotocol/sdk';
import type { ContextUsage } from '@qwen-code/webui';
import type { UsageStatsPayload } from '../../types/chatTypes.js';

export function computeContextUsage(
  usageStats: UsageStatsPayload | null,
  modelInfo: ModelInfo | null,
): ContextUsage | null {
  if (!usageStats && !modelInfo) {
    return null;
  }

  const metaLimitRaw = modelInfo?._meta?.['contextLimit'];
  const metaLimit =
    typeof metaLimitRaw === 'number' || metaLimitRaw === null
      ? metaLimitRaw
      : undefined;
  const limit = usageStats?.tokenLimit ?? metaLimit;
  const used =
    usageStats?.usage?.inputTokens ?? usageStats?.usage?.promptTokens ?? 0;

  if (typeof limit !== 'number' || limit <= 0 || used < 0) {
    return null;
  }

  const percentLeft = Math.max(
    0,
    Math.min(100, Math.round(((limit - used) / limit) * 100)),
  );

  return {
    percentLeft,
    usedTokens: used,
    tokenLimit: limit,
  };
}
