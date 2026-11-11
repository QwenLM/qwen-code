/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { getConfigHomeDir } from '../paths.js';
import { runLogger } from '../runLogger.js';
import { getPlatform } from '../platform.js';
import { validateGitBashInstallation } from './validation.js';

export type GitBashPreparationResult =
  | { ok: true; bashPath: string }
  | { ok: false; error: string };

export type GitBashPreparationState =
  | { status: 'idle'; lastError?: string }
  | { status: 'running'; promise: Promise<GitBashPreparationResult> }
  | { status: 'failed'; lastError: string }
  | { status: 'succeeded'; bashPath: string };

let readPreparationState: (() => GitBashPreparationState) | undefined;

/** Lets an application expose its background installer to shell consumers. */
export function registerGitBashPreparation(
  readState: () => GitBashPreparationState,
): () => void {
  readPreparationState = readState;
  return () => {
    if (readPreparationState === readState) readPreparationState = undefined;
  };
}

export function getGitBashPreparationState(): Readonly<GitBashPreparationState> {
  return readPreparationState?.() ?? { status: 'idle' };
}

export function getManagedGitDirectory(): string {
  return path.join(getConfigHomeDir(), 'bin', 'git');
}

/**
 * Checks for a valid prepared Git Bash installation.
 *
 * @returns
 *  - The absolute path to `bash.exe` if the installation is complete.
 *  - `''` if no prepared installation exists.
 */
export function findPreparedGitPath(): string | '' {
  if (getPlatform() !== 'windows') return '';

  const gitDir = getManagedGitDirectory();
  const bashPath = path.join(gitDir, 'bin', 'bash.exe');

  const validationError = validateGitBashInstallation(gitDir);
  if (validationError === null) {
    runLogger.debug(
      `[envprep] Managed git-bash installation found: ${bashPath}`,
    );
    return bashPath;
  }

  runLogger.debug(
    `[envprep] No valid managed git-bash found at ${gitDir}: ${validationError}`,
  );

  return '';
}
