/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { ToolArtifact } from '../tools/tools.js';
import { getPlanModeLifecyclePrefix } from '../core/plan-mode-entry-policy.js';
import { createDebugLogger } from './debugLogger.js';
import {
  observeToolResultBoundary,
  toolResultBoundaryArtifact,
  toolResultPartDiagnosticValues,
  type ToolResultBoundaryStage,
} from './tool-result-boundary-diagnostics.js';
import {
  extractAnchoredStubDigest,
  extractPersistedStubDigest,
  FULL_OUTPUT_DIGEST_LABEL,
  normalizeToolResultCallId,
  persistAndTruncateToolResult,
} from './truncation.js';

const debugLogger = createDebugLogger('TOOL_RESPONSE_FINALIZER');

export interface ToolResponseBudgetEntry {
  callId: string;
  toolName: string;
  responseParts: Part[];
  persistedOutputFiles?: string[];
  artifacts?: ToolArtifact[];
}

const associatedFinalizerResponses = new WeakSet<Part[]>();

function consumeAssociatedFinalizerEntries(
  entries: ToolResponseBudgetEntry[],
): Set<number> {
  const associated = new Set<number>();
  for (let index = 0; index < entries.length; index++) {
    const responseParts = entries[index].responseParts;
    if (associatedFinalizerResponses.has(responseParts)) {
      associated.add(index);
      associatedFinalizerResponses.delete(responseParts);
    }
  }
  return associated;
}

function associateFinalizerEntries(
  entries: ToolResponseBudgetEntry[],
  indexes: ReadonlySet<number>,
): void {
  for (const index of indexes) {
    associatedFinalizerResponses.add(entries[index].responseParts);
  }
}

function observeFinalizerEntries(
  config: Config,
  stage: Extract<
    ToolResultBoundaryStage,
    'finalizer_input' | 'finalizer_output'
  >,
  entries: ToolResponseBudgetEntry[],
  mutatedEntryIndexes: ReadonlySet<number>,
  promptIds?: ReadonlyMap<string, string>,
  entryIndexes?: ReadonlySet<number>,
): void {
  for (let index = 0; index < entries.length; index++) {
    if (entryIndexes && !entryIndexes.has(index)) continue;
    const entry = entries[index];
    try {
      observeToolResultBoundary({
        stage,
        sessionId: config.getSessionId?.(),
        promptId: promptIds?.get(entry.callId),
        toolCallId: entry.callId,
        toolName: entry.toolName,
        mutated: mutatedEntryIndexes.has(index),
        artifacts: [
          toolResultBoundaryArtifact(
            entry.persistedOutputFiles,
            entry.artifacts,
          ),
        ],
        values: () => toolResultPartDiagnosticValues(entry.responseParts),
      });
    } catch {
      // Diagnostics must not affect response finalization.
    }
  }
}

type TextSlot = {
  entryIndex: number;
  partIndex: number;
  field: 'text' | 'output' | 'error';
  text: string;
  protectedPrefix?: string;
};

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
      const output = response?.['output'];
      const error = response?.['error'];
      if (typeof output === 'string') {
        const protectedPrefix = excludeBudgetExemptOutput
          ? getPlanModeLifecyclePrefix(
              part.functionResponse?.name ?? entry.toolName,
              output,
            )
          : undefined;
        const budgetedOutput = protectedPrefix
          ? output.slice(protectedPrefix.length)
          : output;
        if (budgetedOutput.length > 0) {
          slots.push({
            entryIndex,
            partIndex,
            field: 'output',
            text: budgetedOutput,
            ...(protectedPrefix ? { protectedPrefix } : {}),
          });
        }
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
      if (share === 0) {
        // Budget smaller than the active-slot count: a zero-char slot fits
        // to '' regardless of content, and hashing that constant would
        // fingerprint every over-budget result identically — a CHANGING
        // board would false-halt on the result-aware guards (issue #9450).
        // Keep every active slot at >= 1 char (digest chars, content-
        // dependent from the first char) even when that overshoots a
        // sub-slot-count budget by less than one char per slot.
        for (const index of active) {
          allocations[index] = 1;
        }
        break;
      }
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

/**
 * First line of the header fitText prepends to every batch-budget fit.
 * Exported so consumers that parse stubs (the loop guards in
 * services/loopDetectionService.ts) recognize the shape with the
 * producer's constant instead of a hand-mirrored literal that can drift.
 */
export const BATCH_BUDGET_FIT_PREFIX = 'Tool output truncated.';

function fitText(
  text: string,
  maxChars: number,
  persistedOutputFiles: string[] | undefined,
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';

  // sha256 of the full pre-fit text (FULL_OUTPUT_DIGEST_LABEL). The header
  // embeds a per-call artifact path, so hashing the fitted output would
  // fingerprint every call uniquely and silently disable the result-aware
  // loop guards for exactly these oversized batch-budget results (issue
  // #9450). The digest sits right after the constant prefix; when even the
  // header does not fit the allocation, the degenerate slice below takes
  // the digest line itself so the fitted text stays content-dependent.
  //
  // Idempotence across nesting: the scheduler persists oversized results
  // BEFORE the batch budget runs, so the text fitted here can itself be an
  // already-persisted stub whose envelope embeds the per-call unique
  // `<toolResultsDir>/<callId>.txt` path. Hashing THAT envelope would
  // fingerprint every poll of an unchanged board uniquely and disable the
  // result-aware guards again (the guards' digest-first reduction would take
  // this header's outer digest), so carry the inner stub's own digest
  // instead — and likewise the digest of a prior batch-budget fit, whose
  // header is per-call unique via its artifact note.
  const digest =
    extractPersistedStubDigest(text) ??
    (text.startsWith(BATCH_BUDGET_FIT_PREFIX)
      ? extractAnchoredStubDigest(text)
      : null) ??
    createHash('sha256').update(text).digest('hex');
  const digestLine = `${FULL_OUTPUT_DIGEST_LABEL}${digest}`;
  const artifactNote =
    persistedOutputFiles && persistedOutputFiles.length > 0
      ? persistedOutputFiles.length === 1
        ? `Persisted tool-output artifact: ${persistedOutputFiles[0]}`
        : `Persisted tool-output artifacts:\n${persistedOutputFiles
            .map((file) => `- ${file}`)
            .join('\n')}`
      : undefined;
  const minimalHeader = `${BATCH_BUDGET_FIT_PREFIX}\n${digestLine}`;
  const header = artifactNote
    ? `${minimalHeader}\n${artifactNote}`
    : minimalHeader;
  if (header.length >= maxChars) {
    // Degenerate allocation: the header does not fit whole. As long as the
    // allocation holds prefix + digest line, slicing the header keeps the
    // full digest (content-dependent). Below that, slicing the header would
    // return only constant text — the prefix plus a fragment of the digest
    // LABEL, whose digest starts at offset
    // BATCH_BUDGET_FIT_PREFIX.length + 1 + FULL_OUTPUT_DIGEST_LABEL.length —
    // so every oversized result would fingerprint identically regardless of
    // content and a CHANGING board would false-halt on
    // consecutive_identical_tool_calls under a small configured
    // toolOutputBatchBudget (issue #9450). Slice the digest line itself
    // instead so any allocation reaching past the label carries
    // content-dependent digest characters. The band at or below the label
    // length is degenerate one notch further: slicing the digest line there
    // yields only (a prefix of) the constant label itself — budget 240 over
    // 12 oversized slots gives exactly FULL_OUTPUT_DIGEST_LABEL.length chars
    // per slot — so carry the digest's own characters instead and every
    // non-zero allocation stays content-dependent (issue #9450).
    if (maxChars >= minimalHeader.length) {
      return sliceStartWithoutBrokenSurrogate(header, maxChars);
    }
    if (maxChars > FULL_OUTPUT_DIGEST_LABEL.length) {
      return sliceStartWithoutBrokenSurrogate(digestLine, maxChars);
    }
    return sliceStartWithoutBrokenSurrogate(digest, maxChars);
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
          [slot.field]: slot.protectedPrefix
            ? `${slot.protectedPrefix}${replacement}`
            : replacement,
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
  promptIds?: ReadonlyMap<string, string>,
  observeBoundary = true,
  associateBoundary = false,
): Promise<ToolResponseBudgetEntry[]> {
  const shouldAssociateBoundary = observeBoundary && associateBoundary;
  const associatedEntryIndexes = observeBoundary
    ? consumeAssociatedFinalizerEntries(entries)
    : new Set<number>();
  const observationIndexes = (mutatedEntryIndexes: ReadonlySet<number>) =>
    new Set(
      entries.flatMap((_, index) =>
        mutatedEntryIndexes.has(index) || !associatedEntryIndexes.has(index)
          ? [index]
          : [],
      ),
    );
  const observeUnchangedEntries = () => {
    if (!observeBoundary) return;
    const unchanged = new Set<number>();
    const indexes = observationIndexes(unchanged);
    observeFinalizerEntries(
      config,
      'finalizer_input',
      entries,
      unchanged,
      promptIds,
      indexes,
    );
    observeFinalizerEntries(
      config,
      'finalizer_output',
      entries,
      unchanged,
      promptIds,
      indexes,
    );
  };
  const budget =
    config.getToolOutputBatchBudget?.() ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(budget) || budget <= 0) {
    observeUnchangedEntries();
    if (shouldAssociateBoundary)
      associateFinalizerEntries(entries, new Set(entries.keys()));
    return entries;
  }

  const slots = collectTextSlots(entries);
  const total = slots.reduce((sum, slot) => sum + slot.text.length, 0);
  if (total <= budget) {
    observeUnchangedEntries();
    if (shouldAssociateBoundary)
      associateFinalizerEntries(entries, new Set(entries.keys()));
    return entries;
  }

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

  const indexes = observationIndexes(entriesToPersist);
  if (observeBoundary)
    observeFinalizerEntries(
      config,
      'finalizer_input',
      entries,
      entriesToPersist,
      promptIds,
      indexes,
    );

  const withPersistence = [...entries];
  const normalizedCallIds = entries.map((entry) =>
    normalizeToolResultCallId(entry.callId),
  );
  const normalizedCallIdCounts = new Map<string, number>();
  for (const callId of normalizedCallIds) {
    if (!callId) continue;
    normalizedCallIdCounts.set(
      callId,
      (normalizedCallIdCounts.get(callId) ?? 0) + 1,
    );
  }
  const reservedCallIds = new Set(
    normalizedCallIds.filter((callId): callId is string => !!callId),
  );
  const usedCallIds = new Set<string>();
  for (const entryIndex of entriesToPersist) {
    const entry = withPersistence[entryIndex];
    if (entry.persistedOutputFiles !== undefined) continue;
    const content = slots
      .filter((slot) => slot.entryIndex === entryIndex)
      .map((slot) => slot.text)
      .join('\n\n');
    try {
      const normalizedCallId = normalizedCallIds[entryIndex];
      let persistenceCallId = entry.callId;
      if (normalizedCallId) {
        if (
          normalizedCallIdCounts.get(normalizedCallId) === 1 &&
          !usedCallIds.has(normalizedCallId)
        ) {
          persistenceCallId = normalizedCallId;
        } else {
          let suffix = 1;
          let candidate = `${normalizedCallId}-${suffix}`;
          while (reservedCallIds.has(candidate) || usedCallIds.has(candidate)) {
            suffix++;
            candidate = `${normalizedCallId}-${suffix}`;
          }
          persistenceCallId = candidate;
        }
        usedCallIds.add(persistenceCallId);
      }
      const persisted = await persistAndTruncateToolResult(
        persistenceCallId,
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

  const finalized = replaceTextSlots(withPersistence, slots, allocations);
  if (observeBoundary)
    observeFinalizerEntries(
      config,
      'finalizer_output',
      finalized,
      entriesToPersist,
      promptIds,
      indexes,
    );
  if (shouldAssociateBoundary) {
    associateFinalizerEntries(finalized, new Set(finalized.keys()));
  }
  const finalizedTotal = collectTextSlots(finalized).reduce(
    (sum, slot) => sum + slot.text.length,
    0,
  );
  debugLogger.info(
    `Tool response budget (${budget} chars): reduced ${entriesToPersist.size} result(s) from ${total} to ${finalizedTotal} chars.`,
  );
  return finalized;
}
