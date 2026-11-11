/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LRU-based file state cache for tracking file read states.
 *
 * Normalizes all path keys before access to ensure consistent cache hits
 * regardless of path format (relative vs absolute, redundant segments,
 * mixed separators on Windows).
 *
 * Stores content, read ranges, and modification times for Read deduplication
 * and Edit/Write baselines. Attachment caches retain content for change detection.
 */

import { LRUCache } from 'lru-cache';
import { normalize } from 'node:path';
import { createHash } from 'node:crypto';

export interface FileState {
  content: string;
  contentHash?: string;
  contentLength?: number;
  keepContent?: boolean;
  contentNotInModelContext?: boolean;
  /** Oversized changed version already announced; timestamp still belongs to content. */
  changeNoticeMtime?: number;
  /** Recorded by a CodeMode script the model never saw; direct Edit/Write treat the file as unread. */
  readByScriptOnly?: boolean;
  /**
   * Disk mtime in whole milliseconds, recorded by a model Read.
   * Unlike timestamp, this is not populated from transcript message timestamps.
   */
  readMtimeMs?: number;
  timestamp: number;
  offset: number | undefined;
  limit: number | undefined;
  /**
   * True when this entry was populated by auto-injection and the injected
   * content did not match disk (stripped HTML comments, truncated content, etc.).
   * The model has only seen a partial view; Edit/Write must require a
   * complete baseline or permitted Edit recovery. Retained `content` represents
   * the disk content used for diffing, not necessarily what the model saw.
   */
  isPartialView?: boolean;
  /**
   * Keep this entry even if the file is currently missing. Used for injected
   * entrypoint files that may be created later, so normal changed-file detection
   * can surface the first write.
   */
  retainIfMissing?: boolean;
}

/** Default max entries for read file state caches. */
export const READ_FILE_STATE_CACHE_SIZE = 100;
export const TOOL_FILE_STATE_CACHE_SIZE = 5000;

/** Retained-content budget (25 MiB), excluding keys and record metadata. */
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024;

export function normalizeFileStateContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
}

function fileContentHash(content: string): string {
  return createHash('sha256')
    .update(normalizeFileStateContent(content))
    .digest('hex');
}

export function isFullFileRead(state: FileState): boolean {
  if ((state.offset ?? 1) > 1 || state.isPartialView) return false;
  if (state.limit === undefined) return true;
  return state.content !== '' && state.content.split('\n').length < state.limit;
}

export function isFileContentInContext(state: FileState | undefined): boolean {
  return (
    state !== undefined &&
    isFullFileRead(state) &&
    !state.contentNotInModelContext
  );
}

export function isSameFileContent(state: FileState, content: string): boolean {
  return state.contentHash !== undefined
    ? state.contentHash === fileContentHash(content)
    : normalizeFileStateContent(state.content) ===
        normalizeFileStateContent(content);
}

export class FileStateCache {
  private cache: LRUCache<string, FileState>;

  constructor(
    maxEntries: number,
    maxSizeBytes: number,
    readonly compactContent = false,
  ) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: (value) => Math.max(1, Buffer.byteLength(value.content)),
    });
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key));
  }

  set(key: string, value: FileState): this {
    const normalizedKey = normalize(key);
    if (!this.compactContent) {
      this.cache.set(normalizedKey, { ...value });
      return this;
    }
    const previous = this.cache.peek(normalizedKey);
    const keepContent = value.keepContent ?? previous?.keepContent;
    const contentHash = value.contentHash ?? fileContentHash(value.content);
    const contentLength =
      value.contentLength ?? normalizeFileStateContent(value.content).length;
    const content =
      keepContent &&
      value.content === '' &&
      contentHash === previous?.contentHash
        ? previous.content
        : value.content;
    this.cache.set(normalizedKey, {
      ...value,
      keepContent,
      contentHash,
      contentLength,
      content: !keepContent && Buffer.byteLength(content) > 4096 ? '' : content,
    });
    return this;
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key));
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key));
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get max(): number {
    return this.cache.max;
  }

  get maxSize(): number {
    return this.cache.maxSize;
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize;
  }

  keys(): Generator<string> {
    return this.cache.keys();
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries();
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump();
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries.map(([key, entry]) => [normalize(key), { ...entry, value: { ...entry.value } }]));
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRU eviction to prevent memory bloat from large file contents.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
  compactContent = false,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes, compactContent);
}

/** A session's tool baseline cache; attachment diff caches retain their bodies. */
export function createToolFileStateCache(): FileStateCache {
  return createFileStateCacheWithSizeLimit(
    TOOL_FILE_STATE_CACHE_SIZE,
    DEFAULT_MAX_CACHE_SIZE_BYTES,
    true,
  );
}

/** Clone a FileStateCache, preserving size limit configuration. */
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(
    cache.max,
    cache.maxSize,
    cache.compactContent,
  );
  cloned.load(cache.dump());
  return cloned;
}

/**
 * Merge two file state caches, with more recent entries (by timestamp)
 * overriding older ones.
 */
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first);
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath);
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState);
    }
  }
  return merged;
}

/** Execution-only metadata. Kept outside ToolResult so it never enters SDK output. */
const resultBaselines = new WeakMap<
  object,
  { cache: FileStateCache; path: string; state: FileState }
>();
export function trackFileStateResult<T extends object>(
  result: T,
  cache: FileStateCache,
  path: string,
): T {
  const state = cache.get(path);
  if (state) resultBaselines.set(result, { cache, path, state });
  return result;
}
export function getFileStateResult(result: object) {
  return resultBaselines.get(result);
}
/** Patches the baseline a result recorded, unless a later operation replaced it. */
function patchFileStateResult(
  result: object,
  patch: (state: FileState) => Partial<FileState>,
): void {
  const effect = resultBaselines.get(result);
  if (!effect || effect.cache.get(effect.path) !== effect.state) return;
  effect.cache.set(effect.path, { ...effect.state, ...patch(effect.state) });
  effect.state = effect.cache.get(effect.path)!;
}
export function markFileStateResultPartial(result: object, partialView = true): void {
  patchFileStateResult(result, (state) => ({
    isPartialView: partialView || state.isPartialView,
    contentNotInModelContext: true,
  }));
}

/** A programmatic result reached a script, not the model. */
export function markFileStateResultScriptOnly(result: object): void {
  patchFileStateResult(result, () => ({
    contentNotInModelContext: true,
    readByScriptOnly: true,
  }));
}

/** The read baseline a caller may rely on; script-only baselines count only for scripts. */
export function readBaselineFor(
  state: FileState | undefined,
  consumption: 'model' | 'programmatic' | undefined,
): FileState | undefined {
  return state?.readByScriptOnly && consumption !== 'programmatic'
    ? undefined
    : state;
}
