/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileWatcherOptions, WatchRequest } from './types.js';

/** Runtime detection is shared by native selection and Chokidar defaults. */
export function isInsideBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/** Select runtimes whose native recursive watcher is safe for startup. */
function supportsNativeRecursive(): boolean {
  // Windows: fs.watch(recursive: true) uses ReadDirectoryChangesW;
  // one handle covers the entire subtree, no per-directory handles.
  if (process.platform === 'win32') return true;
  if (process.platform !== 'darwin') return false;
  // Bun's fs.watch() can block synchronously while registering with FSEvents,
  // so use bounded polling instead of delaying resource startup.
  return !isInsideBun();
}

/** Select native signals without creating watchers or inspecting the filesystem. */
export function shouldUseNativeSignals(
  request: WatchRequest,
  options: FileWatcherOptions,
  nativeSignalDisabled: boolean,
): boolean {
  const preferred = request.preferNativeRecursive && supportsNativeRecursive();
  return Boolean(
    request.signal &&
      request.logicalRoot &&
      request.recursive !== false &&
      (preferred || request.depth === undefined) &&
      !nativeSignalDisabled &&
      options.usePolling !== true &&
      (preferred || !isInsideBun()) &&
      (process.platform === 'darwin' || process.platform === 'win32'),
  );
}
