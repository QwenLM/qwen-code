/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseReasoningEffortLevel,
  type ReasoningEffortLevel,
} from '../../config/model-values.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface ParsedModelEfforts {
  efforts: ReasoningEffortLevel[];
  defaultEffort?: ReasoningEffortLevel;
  supportsDisabled: boolean;
}

export function normalizeModelEfforts(
  raw: unknown,
): ReasoningEffortLevel[] | undefined {
  return normalizeModelEffortMetadata(raw)?.efforts;
}

function readDefaultEffortFlag(value: unknown): boolean {
  const record = asRecord(value);
  return record?.['is_default'] === true || record?.['isDefault'] === true;
}

function normalizeEffortValues(
  values: readonly unknown[],
): ReasoningEffortLevel[] | undefined {
  if (values.length === 0) return undefined;

  const out: ReasoningEffortLevel[] = [];
  const seen = new Set<ReasoningEffortLevel>();
  for (const value of values) {
    const effort = parseReasoningEffortLevel(value);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeModelEffortMetadata(
  raw: unknown,
): ParsedModelEfforts | undefined {
  if (Array.isArray(raw)) {
    const efforts = normalizeEffortValues(raw);
    return efforts ? { efforts, supportsDisabled: false } : undefined;
  }

  if (typeof raw === 'string') {
    const efforts = normalizeEffortValues(raw.split(/[,\s]+/));
    return efforts ? { efforts, supportsDisabled: false } : undefined;
  }

  const record = asRecord(raw);
  if (!record) return undefined;

  const efforts = normalizeEffortValues(Object.keys(record));
  if (!efforts) return undefined;

  let defaultEffort: ReasoningEffortLevel | undefined;
  for (const [key, value] of Object.entries(record)) {
    const effort = parseReasoningEffortLevel(key);
    if (!effort || !readDefaultEffortFlag(value)) continue;
    defaultEffort = effort;
    break;
  }

  return defaultEffort
    ? { efforts, defaultEffort, supportsDisabled: false }
    : { efforts, supportsDisabled: false };
}

export function getSupportedReasoningEfforts(model: {
  efforts?: readonly string[] | null;
  supports_disabled?: boolean | null;
  supportsDisabled?: boolean | null;
}): ReasoningEffortLevel[] {
  const efforts = normalizeModelEfforts(model.efforts ?? []) ?? [];
  if (model.supports_disabled !== true && model.supportsDisabled !== true) {
    return efforts;
  }
  return efforts.includes('none') ? efforts : [...efforts, 'none'];
}
