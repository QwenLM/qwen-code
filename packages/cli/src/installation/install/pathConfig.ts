/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PATH configuration for Unix systems (macOS, Linux).
 *
 * Detects the user's shell, checks if the install directory is already on
 * PATH, and if not, appends the appropriate export line to the shell RC file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BRAND_CLI_BIN, runLogger } from '@qwen-code/core';
import { detectShell } from './systemInfo.js';

import type { PathConfigResult } from './installTypes.js';

const TAG = '[PathConfig]';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure PATH on Unix by appending to the user's shell RC file.
 *
 * @param localBinDir - The directory to add to PATH (e.g. ~/.local/bin)
 * @returns Result indicating what was done
 */
export async function configurePATHUnix(
  localBinDir: string,
): Promise<PathConfigResult> {
  const detectedShell = detectShell();

  // 1. Check if already on runtime PATH
  const currentPath = process.env['PATH'] || '';
  const pathEntries = currentPath.split(':');
  if (
    pathEntries.some((p) => normalizePath(p) === normalizePath(localBinDir))
  ) {
    runLogger.debug(`${TAG} ${localBinDir} already on runtime PATH`);
    return {
      modified: false,
      skipReason: 'runtime_path_exists',
      detectedShell,
    };
  }

  // 2. Determine RC file
  const rcFile = selectRCFile(detectedShell);
  if (!rcFile) {
    runLogger.debug(`${TAG} No RC file found for shell: ${detectedShell}`);
    return {
      modified: false,
      skipReason: 'error',
      detectedShell,
      errorMessage: `Could not determine RC file for shell: ${detectedShell}`,
    };
  }

  // 3. Check if RC file already contains PATH configuration for this directory
  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, 'utf-8');
    if (isPathAlreadyConfigured(content, localBinDir, detectedShell)) {
      runLogger.debug(
        `${TAG} ${rcFile} already configures PATH for ${localBinDir}`,
      );
      return {
        modified: false,
        skipReason: 'rc_file_configured',
        detectedShell,
        configFile: rcFile,
      };
    }
  }

  // 4. Append PATH configuration
  try {
    const exportLine = buildExportLine(localBinDir, detectedShell);

    // Ensure parent directory exists (for fish config)
    await mkdir(dirname(rcFile), { recursive: true });

    await appendFile(rcFile, exportLine);
    runLogger.debug(`${TAG} Appended PATH export to ${rcFile}`);

    return {
      modified: true,
      detectedShell,
      configFile: rcFile,
      method: 'rc_append',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    runLogger.debug(`${TAG} Failed to modify ${rcFile}: ${errMsg}`);
    return {
      modified: false,
      skipReason: 'error',
      detectedShell,
      configFile: rcFile,
      errorMessage: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RC file selection
// ---------------------------------------------------------------------------

/**
 * Select the appropriate RC file for the detected shell.
 *
 * Priority for bash:
 *   1. ~/.bashrc (if exists) — most common for interactive shells on Linux
 *   2. ~/.bash_profile (if exists) — macOS default login shell config
 *   3. ~/.profile — fallback
 *   Default (if none exist): ~/.bashrc
 *
 * zsh: ~/.zshrc
 * fish: ~/.config/fish/config.fish
 * sh/other: ~/.profile
 */
export function selectRCFile(shell: string): string | null {
  const home = homedir();

  switch (shell) {
    case 'bash': {
      const bashrc = join(home, '.bashrc');
      const bashProfile = join(home, '.bash_profile');
      const profile = join(home, '.profile');

      if (existsSync(bashrc)) return bashrc;
      if (existsSync(bashProfile)) return bashProfile;
      if (existsSync(profile)) return profile;
      // Default to .bashrc if nothing exists
      return bashrc;
    }

    case 'zsh':
      return join(home, '.zshrc');

    case 'fish':
      return join(home, '.config', 'fish', 'config.fish');

    case 'sh':
    default:
      return join(home, '.profile');
  }
}

// ---------------------------------------------------------------------------
// PATH detection in RC files
// ---------------------------------------------------------------------------

/**
 * Check if the RC file content already configures PATH to include the target directory.
 */
function isPathAlreadyConfigured(
  content: string,
  targetDir: string,
  shell: string,
): boolean {
  // Normalize the target for comparison
  const normalizedTarget = normalizePath(targetDir);

  // Replace $HOME and ~ with the actual home directory for matching
  const home = homedir();
  const expandedContent = content.replace(/\$HOME/g, home).replace(/~/g, home);

  if (shell === 'fish') {
    // fish: look for fish_add_path or set containing the directory
    const fishPattern = new RegExp(
      `(fish_add_path|set\\s+.*PATH).*${escapeRegex(normalizedTarget)}`,
      'm',
    );
    return fishPattern.test(expandedContent);
  }

  // bash/zsh/sh: look for export PATH or PATH= containing the directory
  const pathPattern = new RegExp(
    `(export\\s+)?PATH=.*${escapeRegex(normalizedTarget)}`,
    'm',
  );
  return pathPattern.test(expandedContent);
}

// ---------------------------------------------------------------------------
// Export line generation
// ---------------------------------------------------------------------------

/**
 * Build the export line to append to the RC file.
 */
function buildExportLine(targetDir: string, shell: string): string {
  // Use $HOME-relative path for portability
  const home = homedir();
  const displayPath = targetDir.startsWith(home)
    ? targetDir.replace(home, '$HOME')
    : targetDir;

  if (shell === 'fish') {
    // Append (-a) so this legacy install dir sits at the tail of PATH —
    // mirrors the bash/zsh `export PATH="$PATH:${displayPath}"` below and
    // crucially keeps the dispatcher's prepended ~/.qwen/entry first.
    return `\n# Added by ${BRAND_CLI_BIN} install\nfish_add_path -a ${displayPath}\n`;
  }

  // bash/zsh/sh
  return `\n# Added by ${BRAND_CLI_BIN} install\nexport PATH="$PATH:${displayPath}"\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a path for comparison (resolve trailing slashes, etc.)
 */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
