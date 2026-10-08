/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimatePartChars,
  TOKEN_TO_CHAR_RATIO,
} from '../services/compactionInputSlimming.js';

export interface ToolOutputSize {
  chars: number;
  estimatedTokens: number;
}

export type ToolOutputBudgetSource =
  | 'per_tool'
  | 'global'
  | 'explicit'
  | 'batch';

export interface ToolOutputProvenance {
  callId: string;
  toolName: string;
  promptId: string;
  toolType: 'native' | 'mcp';
  rawSize?: ToolOutputSize;
  persistedOutputFiles?: string[];
  budget?: number;
  budgetSource?: ToolOutputBudgetSource;
  truncated: boolean;
}

const provenanceKey = Symbol('tool-output-provenance');
type MeasuredPart = Part & { [provenanceKey]?: ToolOutputProvenance };

export function measureToolOutput(
  content: PartListUnion,
  imageTokenEstimate = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): ToolOutputSize {
  const parts = (Array.isArray(content) ? content : [content]).map((part) =>
    typeof part === 'string' ? { text: part } : part,
  );
  let chars = 0;
  let estimatedChars = 0;
  for (const part of parts) {
    let partChars = 0;
    let structuredChars = 0;
    if (typeof part.text === 'string') partChars += part.text.length;
    const response = part.functionResponse?.response;
    if (response) {
      for (const value of Object.values(response)) {
        if (typeof value === 'string') {
          partChars += value.length;
          continue;
        }
        let nested = 0;
        try {
          nested = JSON.stringify(value)?.length ?? 0;
        } catch {
          // Unserializable payloads (circular, BigInt) contribute nothing here;
          // the wrapper floor still applies via estimatePartChars.
        }
        partChars += nested;
        structuredChars += nested;
      }
    }
    chars += partChars;
    // ponytail: estimatePartChars bills a structured functionResponse only its
    // wrapper floor, so bill the structured values here instead of changing the
    // estimator that compaction, retention and /context all share.
    estimatedChars +=
      estimatePartChars(part, imageTokenEstimate) + structuredChars;
  }
  return {
    chars,
    estimatedTokens: Math.ceil(estimatedChars / TOKEN_TO_CHAR_RATIO),
  };
}

export function getToolOutputProvenance(
  part: Part,
): ToolOutputProvenance | undefined {
  return (part as MeasuredPart)[provenanceKey];
}

export function attachToolOutputProvenance(
  parts: Part[],
  provenance: ToolOutputProvenance,
): Part[] {
  return parts.map(
    (part): MeasuredPart => ({ ...part, [provenanceKey]: provenance }),
  );
}

export function updateToolOutputBudget(
  parts: Part[],
  budget: number,
  source: ToolOutputBudgetSource,
): void {
  for (const part of parts) {
    const provenance = getToolOutputProvenance(part);
    if (!provenance) continue;
    provenance.truncated = true;
    provenance.budget = budget;
    provenance.budgetSource = source;
  }
}
