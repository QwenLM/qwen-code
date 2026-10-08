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
    estimatedChars += estimatePartChars(part, imageTokenEstimate);
    if (typeof part.text === 'string') chars += part.text.length;
    const response = part.functionResponse?.response;
    if (response) {
      for (const value of Object.values(response)) {
        chars +=
          typeof value === 'string'
            ? value.length
            : (JSON.stringify(value)?.length ?? 0);
      }
    }
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
