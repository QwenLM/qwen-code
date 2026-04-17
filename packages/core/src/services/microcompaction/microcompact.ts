/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

import type { ClearContextOnIdleSettings } from '../../config/config.js';
import { ToolNames } from '../../tools/tool-names.js';

export const MICROCOMPACT_CLEARED_MESSAGE = '[Old tool result content cleared]';

const COMPACTABLE_TOOLS = new Set<string>([
  ToolNames.READ_FILE,
  ToolNames.SHELL,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.WEB_FETCH,
  ToolNames.WEB_SEARCH,
  ToolNames.EDIT,
  ToolNames.WRITE_FILE,
]);

// --- Trigger evaluation ---

/**
 * Check whether the time-based trigger should fire.
 *
 * A toolResultsThresholdMinutes of -1 means disabled (never clear).
 */
export function evaluateTimeBasedTrigger(
  lastApiCompletionTimestamp: number | null,
  settings: ClearContextOnIdleSettings,
): { gapMs: number } | null {
  const thresholdMin = settings.toolResultsThresholdMinutes ?? 60;
  // -1 means disabled
  if (thresholdMin < 0) {
    return null;
  }
  if (lastApiCompletionTimestamp === null) {
    return null;
  }
  const thresholdMs = thresholdMin * 60_000;
  const gapMs = Date.now() - lastApiCompletionTimestamp;
  if (!Number.isFinite(gapMs) || gapMs < thresholdMs) {
    return null;
  }
  return { gapMs };
}

// --- Collection ---

/** Pointer to a single compactable functionResponse part. */
interface PartRef {
  contentIndex: number;
  partIndex: number;
}

/**
 * Collect references to individual compactable functionResponse parts
 * across the history, in encounter order. This counts per-part (not
 * per-Content-entry) so keepRecent applies to individual tool results
 * even when multiple results are batched into one Content message.
 */
function collectCompactablePartRefs(history: Content[]): PartRef[] {
  const refs: PartRef[] = [];
  for (let ci = 0; ci < history.length; ci++) {
    const content = history[ci]!;
    if (content.role !== 'user' || !content.parts) continue;
    for (let pi = 0; pi < content.parts.length; pi++) {
      const part = content.parts[pi]!;
      if (
        part.functionResponse?.name &&
        COMPACTABLE_TOOLS.has(part.functionResponse.name)
      ) {
        refs.push({ contentIndex: ci, partIndex: pi });
      }
    }
  }
  return refs;
}

// --- Helpers ---

/** True when the functionResponse carries an error (not a success output). */
function isErrorResponse(part: Part): boolean {
  return part.functionResponse?.response?.['error'] !== undefined;
}

function estimatePartTokens(part: Part): number {
  if (!part.functionResponse?.response) return 0;
  const output = part.functionResponse.response['output'];
  if (typeof output !== 'string') return 0;
  return Math.ceil(output.length / 4);
}

function isAlreadyCleared(part: Part): boolean {
  return (
    part.functionResponse?.response?.['output'] === MICROCOMPACT_CLEARED_MESSAGE
  );
}

// --- Main entry point ---

export interface MicrocompactMeta {
  gapMinutes: number;
  thresholdMinutes: number;
  toolsCleared: number;
  toolsKept: number;
  keepRecent: number;
  tokensSaved: number;
}

/**
 * Microcompact history: clear old compactable tool results when the
 * time-based trigger fires.
 *
 * Returns the (potentially modified) history and optional metadata
 * about what was cleared (for logging by the caller).
 */
export function microcompactHistory(
  history: Content[],
  lastApiCompletionTimestamp: number | null,
  settings: ClearContextOnIdleSettings,
): { history: Content[]; meta?: MicrocompactMeta } {
  const trigger = evaluateTimeBasedTrigger(
    lastApiCompletionTimestamp,
    settings,
  );
  if (!trigger) {
    return { history };
  }
  const { gapMs } = trigger;

  const envKeep = process.env['QWEN_MC_KEEP_RECENT'];
  const rawKeepRecent =
    envKeep !== undefined && Number.isFinite(Number(envKeep))
      ? Number(envKeep)
      : (settings.toolResultsNumToKeep ?? 5);
  const keepRecent = Number.isFinite(rawKeepRecent)
    ? Math.max(1, rawKeepRecent)
    : 5;

  const allRefs = collectCompactablePartRefs(history);
  const keepRefs = new Set(
    allRefs.slice(-keepRecent).map((r) => `${r.contentIndex}:${r.partIndex}`),
  );
  const clearRefs = allRefs.filter(
    (r) => !keepRefs.has(`${r.contentIndex}:${r.partIndex}`),
  );

  if (clearRefs.length === 0) {
    return { history };
  }

  // Build a lookup: contentIndex → Set of partIndices to clear
  const clearMap = new Map<number, Set<number>>();
  for (const ref of clearRefs) {
    let parts = clearMap.get(ref.contentIndex);
    if (!parts) {
      parts = new Set();
      clearMap.set(ref.contentIndex, parts);
    }
    parts.add(ref.partIndex);
  }

  let tokensSaved = 0;
  let toolsCleared = 0;

  const result: Content[] = history.map((content, ci) => {
    const partsToClean = clearMap.get(ci);
    if (!partsToClean || !content.parts) return content;

    let touched = false;
    const newParts = content.parts.map((part, pi) => {
      if (
        partsToClean.has(pi) &&
        part.functionResponse?.name &&
        COMPACTABLE_TOOLS.has(part.functionResponse.name) &&
        !isAlreadyCleared(part) &&
        !isErrorResponse(part)
      ) {
        tokensSaved += estimatePartTokens(part);
        toolsCleared++;
        touched = true;
        return {
          functionResponse: {
            ...part.functionResponse,
            response: { output: MICROCOMPACT_CLEARED_MESSAGE },
          },
        };
      }
      return part;
    });

    if (!touched) return content;
    return { ...content, parts: newParts };
  });

  if (tokensSaved === 0) {
    return { history };
  }

  const thresholdMinutes = settings.toolResultsThresholdMinutes ?? 60;

  return {
    history: result,
    meta: {
      gapMinutes: Math.round(gapMs / 60_000),
      thresholdMinutes,
      toolsCleared,
      toolsKept: allRefs.length - clearRefs.length,
      keepRecent,
      tokensSaved,
    },
  };
}
