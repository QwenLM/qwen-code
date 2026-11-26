/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone-binary detection utilities.
 *
 * The CLI can be distributed as:
 *  1. A **Bun-compiled** standalone executable (embeddedFiles, /$bunfs/ paths).
 *  2. A **Node SEA** (Single Executable Application) built by build_binary.js.
 *  3. A plain Node.js script (development / npm-installed).
 *
 * Each packaging mode has slightly different runtime behaviour (argv layout,
 * native-module extraction, TTY polyfills, etc.). The helpers below let call
 * sites pick the right granularity:
 *
 *  - `isInBundledMode()`    → Bun-compiled binary only (Bun-specific quirks).
 *  - `isNodeSEA()`          → Node SEA binary only.
 *  - `isStandaloneBinary()` → *any* standalone binary (shared packaging logic).
 */

// Minimal Bun type declarations for bundled-mode detection.
// We don't depend on @types/bun; only the subset used here is declared.
declare const Bun:
  | {
      embeddedFiles?: unknown[];
      spawn?: (...args: unknown[]) => unknown;
    }
  | undefined;

/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.sh/guides/util/detect-bun
  return process.versions['bun'] !== undefined;
}

/** Bun exposes compiled entry modules through its virtual /$bunfs/ tree. */
export function isBunVirtualPath(value: string | undefined): boolean {
  return value?.startsWith('/$bunfs/') ?? false;
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 *
 * Embedded files are the strongest signal, but a compiled executable can have
 * an empty embedded-file table. In that case Bun still exposes argv[1] through
 * /$bunfs/.
 */
export function isInBundledMode(): boolean {
  return (
    isRunningWithBun() &&
    ((typeof Bun !== 'undefined' &&
      Array.isArray(Bun.embeddedFiles) &&
      Bun.embeddedFiles.length > 0) ||
      isBunVirtualPath(process.argv[1]))
  );
}

/**
 * Detects if running as a Node SEA (Single Executable Application).
 * sea-launch.cjs sets `IS_BINARY=true` before importing the main bundle.
 */
export function isNodeSEA(): boolean {
  return process.env['IS_BINARY'] === 'true' && !isInBundledMode();
}

/**
 * Detects if running as any kind of standalone binary (Bun-compiled or Node SEA).
 * Use this for logic that is common to all packaged distributions (e.g.
 * installation-info detection) rather than Bun-specific quirks.
 */
export function isStandaloneBinary(): boolean {
  return isInBundledMode() || isNodeSEA();
}

export function getBinaryRuntime(): 'bun' | 'node-sea' | undefined {
  if (isInBundledMode()) return 'bun';
  if (isNodeSEA()) return 'node-sea';
  return undefined;
}
