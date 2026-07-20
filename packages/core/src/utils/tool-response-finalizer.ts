/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { persistAndTruncateToolResult } from './truncation.js';

export interface ToolResponseBudgetEntry {
  callId: string;
  toolName: string;
  responseParts: Part[];
  persistedOutputFiles?: string[];
}

type TextSlot = {
  entryIndex: number;
  partIndex: number;
  field: 'text' | 'output' | 'error';
  text: string;
};

function isBudgetExemptToolName(toolName: string | undefined): boolean {
  return toolName === ToolNames.ENTER_PLAN_MODE;
}

function collectTextSlots(
  entries: ToolResponseBudgetEntry[],
  includeTopLevelText = true,
  excludeBudgetExemptOutput = true,
): TextSlot[] {
  const slots: TextSlot[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    const parts = entry.responseParts;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      if (includeTopLevelText && typeof part.text === 'string') {
        slots.push({
          entryIndex,
          partIndex,
          field: 'text',
          text: part.text,
        });
      }
      const response = part.functionResponse?.response;
      const outputIsExempt = isBudgetExemptToolName(
        part.functionResponse?.name ?? entry.toolName,
      );
      const output = response?.['output'];
      const error = response?.['error'];
      if (
        (!excludeBudgetExemptOutput || !outputIsExempt) &&
        typeof output === 'string'
      ) {
        slots.push({
          entryIndex,
          partIndex,
          field: 'output',
          text: output,
        });
      }
      if (typeof error === 'string') {
        slots.push({
          entryIndex,
          partIndex,
          field: 'error',
          text: error,
        });
      }
    }
  }
  return slots;
}

function allocateTextBudget(lengths: number[], budget: number): number[] {
  const allocations = new Array<number>(lengths.length).fill(0);
  let remaining = Math.max(0, Math.floor(budget));
  let active = lengths.map((_, index) => index);

  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    const fixed = active.filter((index) => lengths[index] <= share);
    if (fixed.length === 0) {
      for (const index of active) {
        allocations[index] = share;
      }
      let remainder = remaining - share * active.length;
      for (const index of active) {
        if (remainder === 0) break;
        allocations[index]++;
        remainder--;
      }
      break;
    }

    const fixedSet = new Set(fixed);
    for (const index of fixed) {
      allocations[index] = lengths[index];
      remaining -= lengths[index];
    }
    active = active.filter((index) => !fixedSet.has(index));
  }

  return allocations;
}

function sliceStartWithoutBrokenSurrogate(
  text: string,
  length: number,
): string {
  let end = Math.min(Math.max(0, length), text.length);
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

function sliceEndWithoutBrokenSurrogate(text: string, length: number): string {
  let start = Math.max(0, text.length - Math.max(0, length));
  if (start < text.length) {
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start++;
  }
  return text.slice(start);
}

function fitText(
  text: string,
  maxChars: number,
  persistedOutputFiles: string[] | undefined,
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';

  const header =
    persistedOutputFiles && persistedOutputFiles.length > 0
      ? persistedOutputFiles.length === 1
        ? `Tool output truncated. Persisted tool-output artifact: ${persistedOutputFiles[0]}`
        : `Tool output truncated. Persisted tool-output artifacts:\n${persistedOutputFiles
            .map((file) => `- ${file}`)
            .join('\n')}`
      : 'Tool output truncated.';
  if (header.length >= maxChars) {
    return sliceStartWithoutBrokenSurrogate(header, maxChars);
  }

  const separator = '\n\n';
  const marker = '\n...\n';
  const previewBudget = maxChars - header.length - separator.length;
  if (previewBudget <= 0) {
    return sliceStartWithoutBrokenSurrogate(header, maxChars);
  }
  if (previewBudget <= marker.length) {
    return `${header}${separator}${sliceStartWithoutBrokenSurrogate(
      text,
      previewBudget,
    )}`;
  }

  const contentBudget = previewBudget - marker.length;
  const headBudget = Math.floor(contentBudget / 5);
  const tailBudget = contentBudget - headBudget;
  return `${header}${separator}${sliceStartWithoutBrokenSurrogate(
    text,
    headBudget,
  )}${marker}${sliceEndWithoutBrokenSurrogate(text, tailBudget)}`;
}

function replaceTextSlots(
  entries: ToolResponseBudgetEntry[],
  slots: TextSlot[],
  allocations: number[],
): ToolResponseBudgetEntry[] {
  const result = entries.map((entry) => ({
    ...entry,
    responseParts: [...entry.responseParts],
  }));

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot.text.length <= allocations[index]) continue;
    const entry = result[slot.entryIndex];
    const part = entry.responseParts[slot.partIndex];
    const replacement = fitText(
      slot.text,
      allocations[index],
      entry.persistedOutputFiles,
    );

    if (slot.field === 'text') {
      entry.responseParts[slot.partIndex] = { ...part, text: replacement };
      continue;
    }

    const functionResponse = part.functionResponse;
    if (!functionResponse) continue;
    entry.responseParts[slot.partIndex] = {
      ...part,
      functionResponse: {
        ...functionResponse,
        response: {
          ...functionResponse.response,
          [slot.field]: replacement,
        },
      },
    };
  }

  return result;
}

export function toolResponseTextLength(parts: Part[]): number {
  return collectTextSlots(
    [{ callId: '', toolName: '', responseParts: parts }],
    true,
    false,
  ).reduce((total, slot) => total + slot.text.length, 0);
}

export function enforceFunctionResponseBudget(
  entries: ToolResponseBudgetEntry[],
  budget: number,
): ToolResponseBudgetEntry[] {
  if (!Number.isFinite(budget) || budget <= 0) return entries;
  const slots = collectTextSlots(entries, false);
  const total = slots.reduce((sum, slot) => sum + slot.text.length, 0);
  if (total <= budget) return entries;

  return replaceTextSlots(
    entries,
    slots,
    allocateTextBudget(
      slots.map((slot) => slot.text.length),
      budget,
    ),
  );
}

export async function finalizeToolResponses(
  config: Config,
  entries: ToolResponseBudgetEntry[],
): Promise<ToolResponseBudgetEntry[]> {
  const budget =
    config.getToolOutputBatchBudget?.() ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(budget) || budget <= 0) return entries;

  const slots = collectTextSlots(entries);
  const total = slots.reduce((sum, slot) => sum + slot.text.length, 0);
  if (total <= budget) return entries;

  const allocations = allocateTextBudget(
    slots.map((slot) => slot.text.length),
    budget,
  );
  const entriesToPersist = new Set<number>();
  for (let index = 0; index < slots.length; index++) {
    if (slots[index].text.length > allocations[index]) {
      entriesToPersist.add(slots[index].entryIndex);
    }
  }

  const withPersistence = [...entries];
  const callIdCounts = new Map<string, number>();
  for (const entry of entries) {
    callIdCounts.set(entry.callId, (callIdCounts.get(entry.callId) ?? 0) + 1);
  }
  for (const entryIndex of entriesToPersist) {
    const entry = withPersistence[entryIndex];
    if (entry.persistedOutputFiles !== undefined) continue;
    const content = slots
      .filter((slot) => slot.entryIndex === entryIndex)
      .map((slot) => slot.text)
      .join('\n\n');
    try {
      const persisted = await persistAndTruncateToolResult(
        (callIdCounts.get(entry.callId) ?? 0) > 1
          ? `${entry.callId}-${entryIndex + 1}`
          : entry.callId,
        entry.toolName,
        content,
        config,
      );
      withPersistence[entryIndex] = {
        ...entry,
        persistedOutputFiles: persisted.outputFile
          ? [persisted.outputFile]
          : [],
      };
    } catch {
      withPersistence[entryIndex] = {
        ...entry,
        persistedOutputFiles: [],
      };
    }
  }

  return replaceTextSlots(withPersistence, slots, allocations);
}
