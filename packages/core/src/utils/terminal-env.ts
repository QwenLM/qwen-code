/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WSL detection shared by the CLI's terminal-sensitive paths (the redraw
 * optimizer skip and the voice preflight).
 *
 * `ripgrepUtils.wslTimeout()` deliberately uses a narrower check (`platform ===
 * 'linux' && WSL_INTEROP` only); do not widen it to this marker set, which
 * would lengthen the ripgrep timeout for every WSL process.
 */

/** Whether the process is running inside Windows Subsystem for Linux. */
export function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']);
}
