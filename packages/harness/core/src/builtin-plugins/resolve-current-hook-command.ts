/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { BRAND_CLI_BIN } from '../config/brand.js';
import { GLOBAL_CONFIG_DIR } from '../utils/paths.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function isBunVirtualPath(value: string): boolean {
  return value.startsWith('/$bunfs/') || value.startsWith('\\$bunfs\\');
}

function getManagedBinDir(): string {
  return path.join(homedir(), GLOBAL_CONFIG_DIR, 'bin', BRAND_CLI_BIN);
}

function getStableManagedBinPath(): string {
  if (process.platform === 'win32') {
    return path.join(getManagedBinDir(), `${BRAND_CLI_BIN}.exe`);
  }
  return path.join(homedir(), '.local', 'bin', BRAND_CLI_BIN);
}

function isManagedVersionedBinaryPath(value: string): boolean {
  const resolved = path.resolve(value);
  if (path.dirname(resolved) !== getManagedBinDir()) {
    return false;
  }

  const executableSuffix = process.platform === 'win32' ? '(?:\\.exe)?' : '';
  const versionedBinaryPattern = new RegExp(
    `^${escapeRegExp(BRAND_CLI_BIN)}-\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9][A-Za-z0-9.+-]*)?${executableSuffix}$`,
  );
  return versionedBinaryPattern.test(path.basename(resolved));
}

function getNpmStartHookCommand(): readonly string[] | null {
  const lifecycleEvent = process.env['npm_lifecycle_event'];
  const packageJsonPath = process.env['npm_package_json'];
  if (
    !lifecycleEvent ||
    !packageJsonPath ||
    (lifecycleEvent !== 'start' && !lifecycleEvent.startsWith('start:'))
  ) {
    return null;
  }

  const npmExecPath = process.env['npm_execpath'];
  const packageRoot = path.dirname(packageJsonPath);
  if (npmExecPath && path.isAbsolute(npmExecPath)) {
    return [
      resolveFromCwd(process.execPath),
      npmExecPath,
      '--prefix',
      packageRoot,
      'run',
      lifecycleEvent,
      '--',
    ];
  }

  return ['npm', '--prefix', packageRoot, 'run', lifecycleEvent, '--'];
}

export function resolveCurrentHookCommand(): readonly string[] {
  const resolvedExecPath = resolveFromCwd(process.execPath);
  const entry = process.argv[1] || '';

  if (isManagedVersionedBinaryPath(resolvedExecPath)) {
    return [getStableManagedBinPath()];
  }

  if (isBunVirtualPath(entry) || process.env['IS_BINARY'] === 'true') {
    return [resolvedExecPath];
  }

  const npmStartCommand = getNpmStartHookCommand();
  if (npmStartCommand) {
    return npmStartCommand;
  }

  if (!entry) {
    return [resolvedExecPath];
  }

  const resolvedEntry = resolveFromCwd(entry);
  if (resolvedEntry === resolvedExecPath) {
    return [resolvedExecPath];
  }

  return [resolvedExecPath, resolvedEntry];
}
