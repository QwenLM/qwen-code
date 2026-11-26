/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativePaths } from '../nativeVersionStore.js';

export function getQwenPaths(): NativePaths & {
  dataDir: string;
  pauseFile: string;
  lockFile: string;
} {
  const dataDir = join(homedir(), '.qwen');
  const binDir = join(dataDir, 'bin', 'qwen');
  return {
    dataDir,
    binaryName: 'qwen',
    binDir,
    linkPath:
      process.platform === 'win32'
        ? join(binDir, 'qwen.exe')
        : join(homedir(), '.local', 'bin', 'qwen'),
    pauseFile: join(dataDir, 'auto-update-paused-until'),
    lockFile: join(dataDir, 'update.lock'),
  };
}

/** Baked into release binaries; local builds have no implicit production source. */
export function getQwenReleaseBaseURL(): string {
  // @ts-expect-error Bun replaces this exact dot-notation expression.
  const value = process.env.QWEN_CODE_RELEASE_BASE_URL?.trim();
  if (!value)
    throw new Error('This Qwen build has no release source configured.');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('Qwen release source must be an HTTPS base URL.');
  }
  return value.replace(/\/+$/, '');
}
