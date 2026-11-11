/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide memoization for workflow script loading.
 *
 * The slash-command catalog is rebuilt in full on every reload, and each
 * rebuild constructs a fresh `WorkflowRegistry` that re-reads and re-parses
 * every workflow script from disk. `parseWorkflowScript` runs a complete acorn
 * AST parse, so that is the dominant per-rebuild cost. The same scan also runs
 * on every system-prompt assembly.
 *
 * Two independent memos, deliberately kept separate:
 *
 * - the file read is keyed by file identity (path + projectRoot + mtimeMs +
 *   size), so edits, adds and deletes are picked up on the very next call —
 *   no TTL, no watcher, no staleness contract to negotiate;
 * - the meta parse is keyed by the script text, because `parseWorkflowScript`
 *   is a pure function of it. Keying by text also covers built-in and
 *   plugin-inline scripts, which never touch the filesystem at all.
 *
 * The memoization deliberately lives here and not inside `parseWorkflowScript`
 * itself: that function is public API, and putting a cache inside it would
 * impose the "shared, frozen result" contract on every external caller.
 * `workflow-tool.ts` in particular stores parsed meta into run manifests and
 * must keep getting fresh, mutable objects.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseWorkflowScript } from './workflow-parser.js';
import { readWorkflowScriptFile } from './workflow-storage.js';
import { isFsTouchUnsafePath } from '../utils/pathShape.js';
import type { WorkflowMeta } from './workflow-types.js';

/**
 * Retained-bytes budget for each memo. Bounding by entry count would be wrong:
 * a single script may be up to WORKFLOW_MAX_SCRIPT_BYTES (512KB), so an
 * entry-count cap gives a worst case in the hundreds of megabytes.
 */
const DEFAULT_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

let cacheBudgetBytes = DEFAULT_CACHE_BUDGET_BYTES;

interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
  script: string;
  scriptPath: string;
}

// Both maps rely on Map preserving insertion order for oldest-first eviction.
const readCache = new Map<string, ReadCacheEntry>();
let readCacheBytes = 0;

const metaCache = new Map<string, WorkflowMeta>();
let metaCacheBytes = 0;

function evictReadCache(): void {
  while (readCacheBytes > cacheBudgetBytes && readCache.size > 0) {
    const oldestKey = readCache.keys().next().value as string;
    const oldest = readCache.get(oldestKey);
    readCache.delete(oldestKey);
    readCacheBytes -= oldest?.script.length ?? 0;
  }
}

function evictMetaCache(): void {
  while (metaCacheBytes > cacheBudgetBytes && metaCache.size > 0) {
    const oldestKey = metaCache.keys().next().value as string;
    metaCache.delete(oldestKey);
    metaCacheBytes -= oldestKey.length;
  }
}

/**
 * Reads a workflow script, reusing the cached contents when the file's
 * mtime and size are unchanged.
 *
 * `fs.stat` still runs on every call — it is far cheaper than a read plus an
 * AST parse, and it is what keeps the cache free of any staleness window.
 * ENOENT propagates unchanged so callers can keep using their existing
 * "file not found" branches.
 */
export async function readWorkflowScriptFileCached(
  scriptPath: string,
  projectRoot: string,
): Promise<{ script: string; scriptPath: string }> {
  const resolvedPath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(projectRoot, scriptPath);
  const key = `${resolvedPath}\0${projectRoot}`;

  // SECURITY: the inversion is deliberate — do NOT simplify it away. Stat'ing a
  // network path here would perform the SMB handshake before
  // readWorkflowScriptFile (workflow-storage.ts) gets to refuse it, so such a
  // path must reach that guard unprobed.
  if (!isFsTouchUnsafePath(scriptPath)) {
    const stats = await fs.stat(resolvedPath);
    const cached = readCache.get(key);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size
    ) {
      return { script: cached.script, scriptPath: cached.scriptPath };
    }

    const result = await readWorkflowScriptFile(scriptPath, projectRoot);
    const previous = readCache.get(key);
    if (previous) {
      readCacheBytes -= previous.script.length;
      readCache.delete(key);
    }
    readCache.set(key, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      script: result.script,
      scriptPath: result.scriptPath,
    });
    readCacheBytes += result.script.length;
    evictReadCache();
    return result;
  }

  return readWorkflowScriptFile(scriptPath, projectRoot);
}

function deepFreezeMeta(meta: WorkflowMeta): WorkflowMeta {
  if (Array.isArray(meta.phases)) {
    for (const phase of meta.phases) {
      if (phase && typeof phase === 'object') Object.freeze(phase);
    }
    Object.freeze(meta.phases);
  }
  if (meta.inputSchema && typeof meta.inputSchema === 'object') {
    Object.freeze(meta.inputSchema);
  }
  return Object.freeze(meta);
}

/**
 * Parses a workflow script's `meta`, memoized by script text.
 *
 * Only successful parses are cached, so an invalid script is re-read and
 * re-parsed on every call and keeps producing its diagnostic — and a fix is
 * picked up immediately.
 *
 * The returned meta is frozen: it is shared across every registry, every
 * `listAvailable()` call and every source identity, so it must not be mutated.
 * Per-source metadata (source, pluginName, the `pluginName:` prefix) is applied
 * by the caller after this lookup, never baked in here.
 */
export function parseWorkflowMetaCached(script: string): WorkflowMeta {
  const cached = metaCache.get(script);
  if (cached) return cached;

  const meta = deepFreezeMeta(parseWorkflowScript(script).meta);
  metaCache.set(script, meta);
  metaCacheBytes += script.length;
  evictMetaCache();
  return meta;
}

/** Test-only: clears both memos. */
export function resetWorkflowScriptCaches(): void {
  readCache.clear();
  readCacheBytes = 0;
  metaCache.clear();
  metaCacheBytes = 0;
}

/**
 * Test-only: shrinks the retained-bytes budget so eviction can be exercised
 * without allocating ~17 half-megabyte fixtures. Pass no argument to restore
 * the production default.
 */
export function setWorkflowScriptCacheBudgetForTesting(bytes?: number): void {
  cacheBudgetBytes = bytes ?? DEFAULT_CACHE_BUDGET_BYTES;
  evictReadCache();
  evictMetaCache();
}

/** Test-only: retained bytes per memo, for budget assertions. */
export function getWorkflowScriptCacheBytesForTesting(): {
  read: number;
  meta: number;
} {
  return { read: readCacheBytes, meta: metaCacheBytes };
}
