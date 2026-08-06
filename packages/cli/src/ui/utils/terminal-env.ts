/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared terminal/platform environment detection.
 *
 * WSL detection previously lived as a private helper in `voice-availability`
 * and was inlined again in `terminalRedrawOptimizer`; extracting it here keeps
 * the CLI-side marker set consistent. Note: `packages/core` cannot import from
 * `cli`, so `ripgrepUtils.ts` keeps its own narrower `WSL_INTEROP`-only
 * `wslTimeout()` check. #7897.
 */

/** Whether the process is running inside Windows Subsystem for Linux. */
export function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']);
}
