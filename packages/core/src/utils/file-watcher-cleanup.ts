/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

let exitingProcess = false;

/** Only call when the CLI will exit after resource cleanup. */
export function prepareFileWatchersForProcessExit(): void {
  exitingProcess = process.platform === 'darwin';
}

export function closeFileWatcher(
  watcher:
    | {
        close(): void | Promise<void>;
        removeAllListeners(event: string): unknown;
      }
    | undefined,
): Promise<void> {
  if (!watcher) return Promise.resolve();
  if (exitingProcess) {
    // macOS closes rebuild the native FSEvents stream synchronously. During
    // final process exit, the OS can reclaim handles without blocking the
    // writer/lock/subprocess cleanup that still needs to run.
    watcher.removeAllListeners('all');
    watcher.removeAllListeners('change');
    return Promise.resolve();
  }
  return Promise.resolve(watcher.close());
}
