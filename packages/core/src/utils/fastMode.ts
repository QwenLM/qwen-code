/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fast Mode Utilities
 *
 * Fast mode provides optimized performance for certain operations
 * when running in native/bundled mode.
 */

import { isRunningWithBun } from './bundledMode.js';
import { feature } from './bundle-features.js';

/**
 * Check if fast mode is available.
 * Requires native binary or Bun runtime.
 */
export function isFastModeAvailable(): boolean {
  if (!feature('FAST_MODE')) {
    return false;
  }

  // Fast mode requires Bun runtime for optimizations
  return isRunningWithBun();
}

/**
 * Get fast mode unavailable reason.
 */
export function getFastModeUnavailableReason(): string | null {
  if (!feature('FAST_MODE')) {
    return 'Fast mode is not enabled in this build';
  }

  if (!isRunningWithBun()) {
    return 'Fast mode requires Bun runtime';
  }

  return null;
}

/**
 * Spawn process with Bun's optimized subprocess API.
 */
export async function fastSpawn(
  command: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!isRunningWithBun()) {
    // Fallback to Node.js spawn
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      proc.on('close', (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 }),
      );
      proc.on('error', reject);
    });
  }

  // Bun's optimized spawn
  const proc = Bun.spawn({
    cmd: command,
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return {
    stdout,
    stderr,
    exitCode: proc.exitCode,
  };
}

/**
 * Fast file read using Bun's optimized API.
 */
export async function fastReadFile(path: string): Promise<string> {
  if (!isRunningWithBun()) {
    const fs = await import('fs/promises');
    return await fs.readFile(path, 'utf-8');
  }

  const file = Bun.file(path);
  return await file.text();
}

/**
 * Fast file write using Bun's optimized API.
 */
export async function fastWriteFile(
  path: string,
  content: string,
): Promise<void> {
  if (!isRunningWithBun()) {
    const fs = await import('fs/promises');
    return await fs.writeFile(path, content, 'utf-8');
  }

  await Bun.write(path, content);
}
