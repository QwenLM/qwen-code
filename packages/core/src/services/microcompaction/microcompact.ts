/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

import type { MicrocompactionSettings } from '../../config/config.js';
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

// --- Config resolution ---

interface MicrocompactionConfig {
  enabled: boolean;
  gapThresholdMinutes: number;
  keepRecent: number;
}

const DEFAULTS: MicrocompactionConfig = {
  enabled: true,
  gapThresholdMinutes: 60,
  keepRecent: 5,
};

/**
 * Resolve microcompaction config. Priority:
 * 1. Environment variables (for E2E testing)
 * 2. Settings from settings.json (context.microcompaction)
 * 3. Hardcoded defaults
 */
function getMicrocompactionConfig(
  settings?: MicrocompactionSettings,
): MicrocompactionConfig {
  const envEnabled = process.env['QWEN_MC_ENABLED'];
  const envGap = process.env['QWEN_MC_GAP_THRESHOLD_MINUTES'];
  const envKeep = process.env['QWEN_MC_KEEP_RECENT'];

  return {
    enabled:
      envEnabled !== undefined
        ? envEnabled === 'true'
        : (settings?.enabled ?? DEFAULTS.enabled),
    gapThresholdMinutes:
      envGap !== undefined && Number.isFinite(Number(envGap))
        ? Number(envGap)
        : (settings?.gapThresholdMinutes ?? DEFAULTS.gapThresholdMinutes),
    keepRecent:
      envKeep !== undefined && Number.isFinite(Number(envKeep))
        ? Number(envKeep)
        : (settings?.keepRecent ?? DEFAULTS.keepRecent),
  };
}

// --- Trigger evaluation ---

/**
 * Check whether the time-based trigger should fire.
 *
 * Returns the measured gap (ms) and config when the trigger fires,
 * or null when it doesn't (disabled, gap under threshold, no prior
 * API completion).
 */
export function evaluateTimeBasedTrigger(
  lastApiCompletionTimestamp: number | null,
  settings?: MicrocompactionSettings,
): { gapMs: number; config: MicrocompactionConfig } | null {
  const config = getMicrocompactionConfig(settings);
  if (!config.enabled) {
    return null;
  }
  if (lastApiCompletionTimestamp === null) {
    return null;
  }
  const gapMs = Date.now() - lastApiCompletionTimestamp;
  if (!Number.isFinite(gapMs) || gapMs < config.gapThresholdMinutes * 60_000) {
    return null;
  }
  return { gapMs, config };
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
  settings?: MicrocompactionSettings,
): { history: Content[]; meta?: MicrocompactMeta } {
  const trigger = evaluateTimeBasedTrigger(
    lastApiCompletionTimestamp,
    settings,
  );
  if (!trigger) {
    return { history };
  }
  const { gapMs, config } = trigger;

  const allRefs = collectCompactablePartRefs(history);
  const keepRecent = Math.max(1, config.keepRecent);
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

  return {
    history: result,
    meta: {
      gapMinutes: Math.round(gapMs / 60_000),
      thresholdMinutes: config.gapThresholdMinutes,
      toolsCleared,
      toolsKept: allRefs.length - clearRefs.length,
      keepRecent: config.keepRecent,
      tokensSaved,
    },
  };
}
