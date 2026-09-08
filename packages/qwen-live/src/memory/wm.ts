/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryLogger,
} from './config.js';

export interface WmApplyResult {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  nAfter: number;
  malformed: boolean;
  reasons: string[];
  changed: boolean;
  succeeded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeEntry(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  return (
    [...value.trim().replace(/\s+/gu, ' ')]
      .slice(0, maxChars)
      .join('')
      .trim() || undefined
  );
}

export function applyOperations(
  entries: readonly string[],
  operations: unknown,
  config: MemoryConfig['wm'] = DEFAULT_MEMORY_CONFIG.wm,
  log: MemoryLogger = () => {},
): { entries: string[]; result: WmApplyResult } {
  let working = [...entries];
  const result: WmApplyResult = {
    added: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    nAfter: working.length,
    malformed: false,
    reasons: [],
    changed: false,
    succeeded: false,
  };
  if (!isRecord(operations)) {
    result.malformed = true;
    result.reasons.push('operations is not an object');
    log('memory.wm.bad_operations');
    return { entries: working, result };
  }
  const updates = operations['update'];
  const deletes = operations['delete'];
  const adds = operations['add'];
  if (
    ![updates, deletes, adds].some(
      (value) => Array.isArray(value) && value.length,
    )
  ) {
    result.reasons.push('no operations');
    log('memory.wm.noop');
    return { entries: working, result };
  }
  const validIndex = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < working.length;
  const skip = (event: string) => {
    result.skipped++;
    log(event);
  };
  if (Array.isArray(updates)) {
    for (const item of updates as unknown[]) {
      if (!isRecord(item) || !validIndex(item['index'])) {
        skip('memory.wm.index_oob');
        continue;
      }
      const content = sanitizeEntry(item['content'], config.maxEntryChars);
      if (!content) {
        skip('memory.wm.empty_add');
        continue;
      }
      if (working[item['index']] === content) {
        skip('memory.wm.dup_add');
        continue;
      }
      if (
        typeof item['content'] === 'string' &&
        [...item['content']].length > config.maxEntryChars
      )
        log('memory.wm.entry_truncated');
      working[item['index']] = content;
      result.updated++;
    }
  }
  if (Array.isArray(deletes)) {
    const doomed = new Set<number>();
    for (const value of deletes as unknown[]) {
      if (!validIndex(value)) {
        skip('memory.wm.index_oob');
        continue;
      }
      doomed.add(value);
    }
    working = working.filter((_, index) => !doomed.has(index));
    result.deleted = doomed.size;
  }
  if (Array.isArray(adds)) {
    for (const value of adds as unknown[]) {
      const content = sanitizeEntry(value, config.maxEntryChars);
      if (!content) {
        skip('memory.wm.empty_add');
        continue;
      }
      if (working.includes(content)) {
        skip('memory.wm.dup_add');
        continue;
      }
      if (working.length >= config.maxEntries) {
        skip('memory.wm.full');
        continue;
      }
      if (typeof value === 'string' && [...value].length > config.maxEntryChars)
        log('memory.wm.entry_truncated');
      working.push(content);
      result.added++;
    }
  }
  result.nAfter = working.length;
  result.changed = result.added + result.updated + result.deleted > 0;
  result.succeeded = result.changed;
  return { entries: working, result };
}

export function renderEntries(entries: readonly string[]): string {
  return entries.map((entry, index) => `${index}. ${entry.trim()}`).join('\n');
}

export function parseEntries(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
