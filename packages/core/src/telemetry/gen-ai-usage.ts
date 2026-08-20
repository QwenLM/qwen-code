/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';

export interface GenAiUsageProvenance {
  cachedInputTokensReported?: boolean;
  cacheCreationInputTokens?: number;
}

const usageProvenance = new WeakMap<
  GenerateContentResponseUsageMetadata,
  GenAiUsageProvenance
>();

export function setGenAiUsageProvenance(
  usage: GenerateContentResponseUsageMetadata,
  provenance: GenAiUsageProvenance,
): void {
  usageProvenance.set(usage, provenance);
}

export function getGenAiUsageProvenance(
  usage: GenerateContentResponseUsageMetadata | undefined,
): GenAiUsageProvenance | undefined {
  return usage ? usageProvenance.get(usage) : undefined;
}
