/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bundled Mode Detection Utilities
 *
 * Detects if the current runtime is running as:
 * 1. Bun-compiled standalone executable (native binary)
 * 2. Bun runtime (bun command)
 * 3. Node.js runtime (node command)
 *
 * This affects:
 * - Which optimizations can be used (Bun.YAML, Bun.spawn, etc.)
 * - How files are accessed (embedded vs filesystem)
 * - Timeout handling for network requests
 */

/**
 * Check if Running with Bun runtime (bun command or compiled binary).
 */
export function isRunningWithBun(): boolean {
  // https://bun.sh/guides/util/detect-bun
  return process.versions['bun'] !== undefined;
}

/**
 * Check if running as a Bun-compiled standalone executable.
 * This checks for embedded files which are present in compiled binaries.
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  );
}

/**
 * Check if running in development/source mode.
 */
export function isDevelopmentMode(): boolean {
  return !isInBundledMode() && process.env['NODE_ENV'] !== 'production';
}

/**
 * Get runtime identifier for analytics.
 */
export function getRuntimeMode(): 'native' | 'bun' | 'node' | 'unknown' {
  if (isInBundledMode()) return 'native';
  if (isRunningWithBun()) return 'bun';
  if (process.versions.node) return 'node';
  return 'unknown';
}

/**
 * Get build target for conditional behavior.
 */
export function getBuildTarget(): 'native' | 'node' | 'browser' | 'unknown' {
  const target = process.env['BUILD_TARGET'];
  if (target === 'native' || isInBundledMode()) return 'native';
  if (target === 'browser') return 'browser';
  if (target === 'node') return 'node';
  return 'unknown';
}

/**
 * Embedded files access helper.
 * In bundled mode, files are accessed via Bun.embeddedFiles.
 * In source mode, files are read from filesystem.
 */
export async function getEmbeddedFile(path: string): Promise<string | null> {
  if (!isInBundledMode()) {
    // Fallback to filesystem
    try {
      const fs = await import('fs/promises');
      return await fs.readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }

  // Access embedded file
  const file = Bun.embeddedFiles.find((f: { name: string }) => f.name === path);
  if (!file) return null;

  return await file.text();
}

/**
 * List all embedded files.
 */
export function listEmbeddedFiles(): string[] {
  if (!isInBundledMode()) return [];
  return Bun.embeddedFiles.map((f: { name: string }) => f.name);
}
