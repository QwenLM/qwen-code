import { execSync } from 'node:child_process';
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { BRAND_CLI_BIN } from '@qwen-code/core';

export function detectShell(): string {
  if (process.platform === 'win32') {
    if (process.env['PSModulePath']) return 'powershell';
    return 'cmd';
  }

  const shell = process.env['SHELL'];
  if (shell) return basename(shell);
  return 'sh';
}

export function detectExistingVersion(binDir: string): string | undefined {
  try {
    const entries = readdirSync(binDir);
    const prefix = `${BRAND_CLI_BIN}-`;
    const versions: string[] = [];

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const version = entry.slice(prefix.length).replace(/\.(exe|bin)$/, '');
      if (version) versions.push(version);
    }

    if (versions.length === 0) return undefined;

    // Return the last one alphabetically (imperfect but good enough for diagnostics)
    versions.sort();
    return versions[versions.length - 1];
  } catch {
    return undefined;
  }
}

export function detectMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // Check for musl dynamic linker
    if (
      existsSync('/lib/ld-musl-x86_64.so.1') ||
      existsSync('/lib/ld-musl-aarch64.so.1')
    ) {
      return true;
    }
    // Fallback: check ldd --version output (musl identifies itself)
    const output = execSync('ldd --version 2>&1 || true', {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    return /musl/i.test(output);
  } catch {
    return false;
  }
}

export function detectDiskSpace(targetDir: string): number | undefined {
  try {
    const stats = statfsSync(targetDir);
    // stats.bavail = available blocks for unprivileged users
    // stats.bsize = block size in bytes
    const availableBytes = stats.bavail * stats.bsize;
    return Math.round(availableBytes / 1024 / 1024);
  } catch {
    // Target directory might not exist yet; try parent
    try {
      const parent = dirname(targetDir);
      if (existsSync(parent)) {
        const stats = statfsSync(parent);
        const availableBytes = stats.bavail * stats.bsize;
        return Math.round(availableBytes / 1024 / 1024);
      }
    } catch {
      // fall through
    }
    return undefined;
  }
}
