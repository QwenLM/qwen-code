/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System and environment information collection for the install subcommand.
 *
 * Gathers platform, hardware, and environment details for install
 * diagnostics and troubleshooting.
 */

import { cpus, totalmem, release as osRelease } from 'node:os';
import { existsSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import {
  BRAND_CLI_BIN,
  detectContainer,
  detectRosetta,
} from '@qwen-code/core';

import type { SystemInfo } from './installTypes.js';
import { getWindowsAvx2Support, hasAVX2 } from '../update/manifest.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect comprehensive system information for diagnostics.
 *
 * All detection is best-effort — failures in individual checks do not
 * propagate; they default to safe/unknown values.
 */
export async function collectSystemInfo(binDir: string): Promise<SystemInfo> {
  const os = process.platform;
  const arch = process.arch;

  return {
    os,
    osVersion: detectOSVersion(),
    arch,
    hasAvx2: detectAvx2Support(),
    cpuCores: cpus().length,
    totalMemMb: Math.round(totalmem() / 1024 / 1024),
    shell: detectShell(),
    termProgram: process.env['TERM_PROGRAM'] || undefined,
    isRosetta: detectRosetta(),
    isWsl: detectWSL(),
    isDocker: detectContainer(),
    isCi: detectCI(),
    isSsh: detectSSH(),
    isRoot: detectRoot(),
    locale: process.env['LANG'] || process.env['LC_ALL'] || undefined,
    timezone: detectTimezone(),
    hasExistingBinary: hasExistingBinary(binDir),
    existingVersion: detectExistingVersion(binDir),
    isMusl: detectMusl(),
    diskSpaceMb: detectDiskSpace(binDir),
    nodeVersion: process.version?.replace(/^v/, '') || undefined,
    bunVersion:
      (process.versions as Record<string, string>)['bun'] || undefined,
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect AVX2 support for install diagnostics. Windows binary selection no
 * longer depends on this probe because Bun 1.4+ x64 releases are baseline
 * compatible.
 */
export function detectAvx2Support(): boolean {
  if (process.platform === 'win32') {
    return getWindowsAvx2Support() === true;
  }
  return hasAVX2();
}

/**
 * Detect OS version string.
 */
function detectOSVersion(): string {
  try {
    if (process.platform === 'darwin') {
      return execSync('sw_vers -productVersion', {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true,
      }).trim();
    }

    if (process.platform === 'linux') {
      if (existsSync('/etc/os-release')) {
        const content = readFileSync('/etc/os-release', 'utf-8');
        const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (match) return match[1];
        const versionMatch = content.match(/^VERSION_ID="?([^"\n]+)"?/m);
        if (versionMatch) return versionMatch[1];
      }
      return 'linux';
    }

    if (process.platform === 'win32') {
      return osRelease();
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Detect the user's default shell.
 */
export function detectShell(): string {
  if (process.platform === 'win32') {
    if (process.env['PSModulePath']) return 'powershell';
    return 'cmd';
  }

  const shell = process.env['SHELL'];
  if (shell) return basename(shell);
  return 'sh';
}

/**
 * Detect if running inside Windows Subsystem for Linux.
 */
function detectWSL(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    if (existsSync('/proc/version')) {
      const version = readFileSync('/proc/version', 'utf-8');
      return /microsoft/i.test(version);
    }
  } catch {
    // fall through
  }
  return !!process.env['WSL_DISTRO_NAME'];
}

/**
 * Detect if running in a CI/CD environment.
 */
function detectCI(): boolean {
  return !!(
    process.env['CI'] ||
    process.env['GITHUB_ACTIONS'] ||
    process.env['JENKINS_URL'] ||
    process.env['GITLAB_CI'] ||
    process.env['CIRCLECI'] ||
    process.env['TRAVIS'] ||
    process.env['BUILDKITE'] ||
    process.env['CODEBUILD_BUILD_ID'] ||
    process.env['TF_BUILD']
  );
}

/**
 * Detect if running over SSH.
 */
function detectSSH(): boolean {
  return !!(
    process.env['SSH_CONNECTION'] ||
    process.env['SSH_CLIENT'] ||
    process.env['SSH_TTY']
  );
}

/**
 * Detect if running as root/administrator.
 */
function detectRoot(): boolean {
  if (process.platform === 'win32') return false;
  try {
    return process.getuid?.() === 0;
  } catch {
    return false;
  }
}

/**
 * Detect timezone from environment or system.
 */
function detectTimezone(): string | undefined {
  if (process.env['TZ']) return process.env['TZ'];
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Check if an existing binary is installed in the bin directory.
 */
function hasExistingBinary(binDir: string): boolean {
  try {
    const entries = readdirSync(binDir);
    const prefix = `${BRAND_CLI_BIN}-`;
    return entries.some((e) => e.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Detect the version of the most recent existing binary.
 */
function detectExistingVersion(binDir: string): string | undefined {
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

/**
 * Detect if the system uses musl libc (Alpine Linux, container environments).
 * Checks for the musl dynamic linker or ldd output.
 * @internal Shared platform probe for native artifact selection.
 */
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

/**
 * Detect available disk space on the volume containing the target directory.
 * Returns available space in MB, or undefined if detection fails.
 */
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
