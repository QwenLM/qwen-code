/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clears `QWEN_HOME` for the caller and hands back a restore function.
 *
 * `packages/cli/test-setup.ts` pins `QWEN_HOME` to a per-worker temp dir so a
 * developer's real `~/.qwen` cannot leak into this suite. A test file that
 * resolves its fixtures against a mocked `os.homedir()` instead has to drop
 * that pin, and deleting the variable outright leaves the un-pinned state
 * behind: `process.env` is process-global, so the deletion outlives the file
 * whenever the module registry is shared (`vitest --no-isolate`). A later file
 * in that worker then resolves `Storage.getGlobalQwenDir()` against the real
 * home, and the next settings save rewrites the operator's actual
 * `~/.qwen/settings.json` (#15267).
 *
 * Register the returned function in `afterAll` so the pin is back before the
 * next file runs. Idempotent, and restoring a variable that was absent leaves
 * it absent rather than defined as an empty string.
 */
export function clearQwenHomePin(): () => void {
  const previous = process.env['QWEN_HOME'];
  delete process.env['QWEN_HOME'];
  return () => {
    if (previous === undefined) {
      delete process.env['QWEN_HOME'];
      return;
    }
    process.env['QWEN_HOME'] = previous;
  };
}
