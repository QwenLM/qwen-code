/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Deletion is `unlink`; native signal mode coalesces all operations into `change`. */
export type FileChangeOperation = 'add' | 'change' | 'unlink';

export interface FileChangeEvent {
  path: string;
  operation: FileChangeOperation;
}

export type FileChangeListener = (
  event: FileChangeEvent,
) => void | Promise<void>;

export interface WatchRequest {
  path: string;
  recursive?: boolean;
  /**
   * Maximum depth below this target, matching Chokidar. Omitted means
   * unlimited; invalid values fall back to 2; 0 observes direct children.
   * Limits traversal except with preferNativeRecursive, where it filters events.
   */
  depth?: number;
  /**
   * Prefer native recursive signals on supported runtimes. macOS uses native
   * signals under Node and bounded polling under Bun; Windows supports native
   * recursion. Requires signal mode and logicalRoot. Depth and ignored directory
   * names filter events instead of limiting the OS watch. Descendant symlinks
   * or native failures fall back to depth-bounded polling.
   */
  preferNativeRecursive?: boolean;
  /**
   * Coarse invalidation mode. On supported runtimes native watchers
   * observe only the resolved target and the flat entry guards needed for
   * deletion/recreation. Consumers reload their snapshot instead of relying
   * on a precise filesystem operation.
   */
  signal?: boolean;
  /**
   * Highest caller-visible ancestor whose child entries should stay
   * observable. Ancestors are watched flat; this never makes `logicalRoot`
   * a recursive watch.
   */
  logicalRoot?: string;
  /**
   * Ignore these path segments below this target; the target and its
   * ancestors remain observable.
   */
  ignoredDirectoryNames?: readonly string[];
}

export interface FileWatcherOptions {
  /** Trailing debounce per path+operation. Default 300ms. */
  debounceMs?: number;
  /** Window for suppressing self-triggered events. Default 5000ms. */
  internalWriteWindowMs?: number;
  /** Wait for writes to stabilize. Pass false to disable (tests). */
  awaitWriteFinish?:
    | false
    | { stabilityThreshold: number; pollInterval: number };
  /**
   * True forces polling. Otherwise native opt-in is preferred when supported;
   * Chokidar defaults to polling under Bun. Native opt-in failures always
   * fall back to polling.
   */
  usePolling?: boolean;
  /**
   * Polling interval for files and directories, including binary files.
   * Missing or invalid values default to 2000ms.
   */
  pollingIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface FileWatcher {
  readonly isNoop: boolean;
  watch(request: WatchRequest, listener: FileChangeListener): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
