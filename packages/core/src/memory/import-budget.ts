/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { estimateTextTokens } from '../utils/request-tokenizer/textTokenizer.js';

export const MEMORY_IMPORT_BUDGET = {
  maxCalls: 32,
  maxReservedTokens: 512_000,
  batchSections: 8,
  sourceBytes: 65_536,
  contextBytes: 32_768,
  outputTokens: 8192,
  promptBytes: 32_768,
} as const;

export function packMemoryImportSections<
  T extends { id: string; content: string; groupId: string; scope?: string },
>(sections: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const section of [...sections].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const key = `${section.scope ?? ''}:${section.groupId}`;
    const group = groups.get(key) ?? [];
    group.push(section);
    groups.set(key, group);
  }
  const batches: T[][] = [];
  for (const group of groups.values()) {
    let batch: T[] = [];
    let bytes = 0;
    for (const section of group) {
      const size = Buffer.byteLength(section.content);
      if (
        batch.length &&
        (batch.length === MEMORY_IMPORT_BUDGET.batchSections ||
          bytes + size > MEMORY_IMPORT_BUDGET.sourceBytes)
      ) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(section);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

export function estimateMemoryImport(
  sections: Array<{
    id: string;
    content: string;
    groupId: string;
    scope?: string;
  }>,
) {
  const batches = packMemoryImportSections(sections);
  const sourceTokens = sections.reduce(
    (n, section) => n + estimateTextTokens(section.content),
    0,
  );
  const reservedTokens = batches.reduce(
    (n, batch) =>
      n +
      Buffer.byteLength(
        JSON.stringify(batch.map(({ id, content }) => ({ id, content }))),
      ) +
      MEMORY_IMPORT_BUDGET.contextBytes +
      MEMORY_IMPORT_BUDGET.promptBytes +
      MEMORY_IMPORT_BUDGET.outputTokens +
      1024,
    0,
  );
  return {
    basis: 'source-only-with-context-reserve' as const,
    modelCalls: batches.length,
    sourceTokens,
    maxOutputTokens: batches.length * MEMORY_IMPORT_BUDGET.outputTokens,
    reservedTokens,
    exceedsBudget:
      batches.length > MEMORY_IMPORT_BUDGET.maxCalls ||
      reservedTokens > MEMORY_IMPORT_BUDGET.maxReservedTokens,
    limits: MEMORY_IMPORT_BUDGET,
  };
}
