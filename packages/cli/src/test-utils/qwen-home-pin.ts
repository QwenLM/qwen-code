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
 * whenever the module registry is shared (`vitest --no-isolate`).
 *
 * Register the returned function in `afterAll` so the pin is back when the file
 * finishes. A file that is imported but then skipped (Vitest imports every
 * dispatched file before applying `-t`, and a skipped file never reaches
 * `afterAll`), or that throws at module scope before the hook is registered,
 * restores nothing — the guarantee covers a normal run, not those two shapes.
 * That stops the state from outliving the file, which is one half of #15267; it
 * does not close the issue, because the reporter traced the destructive write
 * to the un-pinned window inside that same file. Idempotent, and restoring a
 * variable that was absent leaves it absent rather than defined as an empty
 * string.
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
