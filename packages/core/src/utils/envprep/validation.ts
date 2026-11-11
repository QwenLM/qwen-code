/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CRITICAL_GIT_FILES } from './types.js';

/**
 * Structural validation: checks that all critical files exist and are non-empty.
 * Used immediately after extraction to confirm 7z produced the expected output.
 * Does NOT execute binaries (which can fail due to AV scanning on Windows).
 * Returns `null` if valid, or an error message describing what is missing.
 */
export function validateGitBashFiles(
  installDir: string,
): string | null {
  for (const relPath of CRITICAL_GIT_FILES) {
    const fullPath = path.join(installDir, relPath);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile() || stat.size === 0) {
        return `critical file empty or not a file: ${relPath}`;
      }
    } catch {
      return `critical file missing: ${relPath}`;
    }
  }
  return null;
}

/**
 * Full functional validation: structural check + verifies executables can run.
 * Used to determine if an installation is *usable* (gates shell tool usage).
 * Should NOT be called immediately after extraction — Windows Defender may
 * temporarily lock freshly-extracted .exe files for scanning.
 * Returns `null` if valid, or an error message describing what failed.
 */
export function validateGitBashInstallation(
  installDir: string,
): string | null {
  const fileError = validateGitBashFiles(installDir);
  if (fileError) return fileError;

  try {
    execFileSync(path.join(installDir, 'bin', 'bash.exe'), ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch {
    return 'bin/bash.exe --version failed';
  }

  try {
    execFileSync(path.join(installDir, 'cmd', 'git.exe'), ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch {
    return 'cmd/git.exe --version failed';
  }

  return null;
}
