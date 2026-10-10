/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBundleDir } from '../utils/bundlePaths.js';

const moduleFile = fileURLToPath(import.meta.url);
const moduleDirectory = resolveBundleDir(import.meta.url);

export function resolveStdinBridge(requestedPath?: string): string | undefined {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    return undefined;
  try {
    return resolveLandlockRunner(requestedPath);
  } catch {
    return undefined;
  }
}

export function landlockRunnerPath(
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Landlock does not support ${platform}/${arch}.`);
  }
  const inSourceSandbox =
    ['landlock-runner-path.ts', 'landlock-runner-path.js'].includes(
      path.basename(moduleFile),
    ) && moduleDirectory.endsWith(`${path.sep}src${path.sep}sandbox`);
  const levelsUp = !inSourceSandbox ? 0 : moduleFile.endsWith('.ts') ? 2 : 3;
  return path.join(
    moduleDirectory,
    ...Array<string>(levelsUp).fill('..'),
    'vendor',
    'landlock-run',
    `${arch}-linux`,
    'qwen-landlock-run',
  );
}

export function resolveLandlockRunner(requestedPath?: string): string {
  const requested = requestedPath ?? landlockRunnerPath();
  if (!path.isAbsolute(requested))
    throw new Error('Landlock helper path must be absolute.');
  if (!existsSync(requested))
    throw new Error(`Landlock helper is missing: ${requested}`);
  const runner = realpathSync(requested);
  // npm archives strip executable bits from files outside the bin entries.
  if (requestedPath === undefined && (statSync(runner).mode & 0o111) === 0)
    chmodSync(runner, 0o755);
  return runner;
}
