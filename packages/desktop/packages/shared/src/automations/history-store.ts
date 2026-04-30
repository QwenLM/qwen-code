/**
 * History Store — single source of truth for automations-history.jsonl writes
 * and compaction.
 *
 * Provides:
 * - `appendAutomationHistoryEntry()` — serialized append, triggers compaction at the global cap
 * - `compactAutomationHistory()` — async two-tier retention (runtime, under mutex)
 * - `compactAutomationHistorySync()` — sync two-tier retention (startup, no mutex needed)
 *
 * Both sync and async compaction share the same pure algorithm (`compactEntries`).
 * All history writes should go through `appendAutomationHistoryEntry` so the mutex
 * prevents concurrent file corruption.
 */

import { appendFile, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import {
  AUTOMATIONS_HISTORY_FILE,
  AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  AUTOMATION_HISTORY_MAX_ENTRIES,
} from './constants.ts';

const log = createLogger('history-store');

// ============================================================================
// Per-workspace mutex — serializes writes to avoid corruption
// ============================================================================

const mutexes = new Map<string, Promise<void>>();

function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  mutexes.set(key, next.then(() => {}, () => {}));
  return next;
}

// ============================================================================
// Append
// ============================================================================

/**
 * Appends since startup per workspace. Startup compaction guarantees ≤ MAX_ENTRIES,
 * so this counter tells us when the file has grown enough to need compaction again.
 */
const appendCounters = new Map<string, number>();

/**
 * Append a history entry to the JSONL file.
 * Triggers compaction when appends since startup reach the global cap.
 *
 * The entry must already be a fully-formed history object (use `createWebhookHistoryEntry`
 * or `createPromptHistoryEntry` from `webhook-utils.ts` to build one).
 */
export async function appendAutomationHistoryEntry(
  workspaceRootPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);

  await withMutex(workspaceRootPath, async () => {
    await appendFile(historyPath, JSON.stringify(entry) + '\n', 'utf-8');

    const count = (appendCounters.get(workspaceRootPath) ?? 0) + 1;
    appendCounters.set(workspaceRootPath, count);

    if (count >= AUTOMATION_HISTORY_MAX_ENTRIES) {
      appendCounters.set(workspaceRootPath, 0);
      await runCompaction(historyPath);
    }
  });
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * Compact the history file asynchronously (runtime path, under mutex).
 */
export async function compactAutomationHistory(
  workspaceRootPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): Promise<void> {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);

  await withMutex(workspaceRootPath, () => runCompaction(historyPath, maxPerMatcher, maxTotal));
}

/**
 * Compact the history file synchronously (startup path).
 * Safe to call without the mutex — startup is single-threaded and runs
 * before any async appends.
 */
export function compactAutomationHistorySync(
  workspaceRootPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): void {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);
  if (!existsSync(historyPath)) return;

  let content: string;
  try { content = readFileSync(historyPath, 'utf-8'); } catch { return; }

  const result = compactEntries(content, maxPerMatcher, maxTotal);
  if (!result) return;

  writeFileSync(historyPath, result, 'utf-8');
  log.debug(`[HistoryStore] Startup compaction complete`);
}

/**
 * Internal async compaction — must be called inside withMutex.
 */
async function runCompaction(
  historyPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): Promise<void> {
  let content: string;
  try {
    if (!existsSync(historyPath)) return;
    content = await readFile(historyPath, 'utf-8');
  } catch {
    return;
  }

  const result = compactEntries(content, maxPerMatcher, maxTotal);
  if (!result) return;

  await writeFile(historyPath, result, 'utf-8');
  log.debug(`[HistoryStore] Compacted history`);
}

// ============================================================================
// Pure compaction algorithm — shared by sync and async paths
// ============================================================================

/**
 * Apply two-tier retention to JSONL content:
 * 1. Per-automation cap: keep last `maxPerMatcher` entries per automation ID
 * 2. Global cap: keep last `maxTotal` entries overall
 *
 * Also drops malformed JSON lines.
 *
 * Returns the compacted output string, or `null` if no compaction was needed.
 */
function compactEntries(
  content: string,
  maxPerMatcher: number,
  maxTotal: number,
): string | null {
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  // Parse all lines, dropping malformed ones
  const entries: Array<{ raw: string; id: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push({ raw: line, id: parsed.id ?? '' });
    } catch {
      // Drop malformed lines
    }
  }

  // Track original line count (including malformed) for dirty-check
  const originalLineCount = lines.length;

  // 1) Per-automation cap: keep only last N per ID
  const byId = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]!.id;
    let group = byId.get(id);
    if (!group) {
      group = [];
      byId.set(id, group);
    }
    group.push(i);
  }

  const keepIndices = new Set<number>();
  for (const indices of byId.values()) {
    const kept = indices.slice(-maxPerMatcher);
    for (const idx of kept) {
      keepIndices.add(idx);
    }
  }

  let trimmed = entries.filter((_, i) => keepIndices.has(i));

  // 2) Global cap: if still over limit, drop oldest globally
  if (trimmed.length > maxTotal) {
    trimmed = trimmed.slice(-maxTotal);
  }

  if (trimmed.length === originalLineCount) return null;

  return trimmed.map(e => e.raw).join('\n') + '\n';
}
