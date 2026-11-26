/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  homedir,
  getCompatibilityWarnings,
  isFsTouchUnsafePath,
  isNetworkShapedPath,
  WarningPriority,
  type StartupWarning,
  BRAND_CLI_NAME,
} from '@qwen-code/core';
import type { Settings } from '../config/settingsSchema.js';
import {
  isFolderTrustEnabled,
  isWorkspaceTrusted,
} from '../config/trustedFolders.js';

type WarningCheck = {
  id: string;
  check: (
    workspaceRoot: string,
    settings: Settings,
    workingDirectories: readonly string[],
  ) => Promise<string | null>;
  priority: WarningPriority;
};

// Individual warning checks
const homeDirectoryCheck: WarningCheck = {
  id: 'home-directory',
  priority: WarningPriority.Low,
  check: async (workspaceRoot: string, settings: Settings) => {
    if (settings.ui?.showHomeDirectoryWarning === false) {
      return null;
    }

    // A network location is never the home directory, and realpath on it would
    // only repeat a handshake the launch already performed — or throw and
    // report a spurious "could not verify" warning.
    if (isFsTouchUnsafePath(workspaceRoot)) {
      return null;
    }

    try {
      const [workspaceRealPath, homeRealPath] = await Promise.all([
        fs.realpath(workspaceRoot),
        fs.realpath(homedir()),
      ]);

      if (workspaceRealPath === homeRealPath) {
        // If folder trust is enabled and the user trusts the home directory, don't show the warning.
        if (
          isFolderTrustEnabled(settings) &&
          isWorkspaceTrusted(settings).isTrusted
        ) {
          return null;
        }

        return `Warning you are running ${BRAND_CLI_NAME} in your home directory.\nThis warning can be disabled in /settings`;
      }
      return null;
    } catch {
      return 'Could not verify the current directory due to a file system error.';
    }
  },
};

const rootDirectoryCheck: WarningCheck = {
  id: 'root-directory',
  priority: WarningPriority.High,
  check: async (workspaceRoot: string, _settings: Settings) => {
    // See homeDirectoryCheck: a network location is never a filesystem root.
    if (isFsTouchUnsafePath(workspaceRoot)) {
      return null;
    }

    try {
      const workspaceRealPath = await fs.realpath(workspaceRoot);
      const errorMessage = `Warning: You are running ${BRAND_CLI_NAME} in the root directory. Your entire folder structure will be used for context. It is strongly recommended to run in a project-specific directory.`;

      // Check for Unix root directory
      if (path.dirname(workspaceRealPath) === workspaceRealPath) {
        return errorMessage;
      }

      return null;
    } catch {
      return 'Could not verify the current directory due to a file system error.';
    }
  },
};

const networkWorkingDirectoryCheck: WarningCheck = {
  id: 'network-working-directory',
  priority: WarningPriority.High,
  check: async (
    workspaceRoot: string,
    _settings: Settings,
    workingDirectories: readonly string[],
  ) => {
    const networkRoots = [workspaceRoot, ...workingDirectories].filter(
      (directory) => isNetworkShapedPath(directory),
    );
    if (networkRoots.length === 0) {
      return null;
    }

    const listed = networkRoots.map((directory) => `  ${directory}`).join('\n');
    return (
      `Working directory is a network location:\n${listed}\n` +
      `Opening it sends your Windows credentials to the host it names. ` +
      `File and shell access under it follows the current permission mode.`
    );
  },
};

// All warning checks
const WARNING_CHECKS: readonly WarningCheck[] = [
  homeDirectoryCheck,
  rootDirectoryCheck,
  networkWorkingDirectoryCheck,
];

export async function getUserStartupWarnings(
  settings: Settings,
  workspaceRoot: string = process.cwd(),
  options?: {
    isAlternateBuffer?: boolean;
    workingDirectories?: readonly string[];
  },
): Promise<StartupWarning[]> {
  const workingDirectories = options?.workingDirectories ?? [];
  const results = await Promise.all(
    WARNING_CHECKS.map(async (check) => {
      const message = await check.check(
        workspaceRoot,
        settings,
        workingDirectories,
      );
      if (message) {
        return {
          id: check.id,
          message,
          priority: check.priority,
        };
      }
      return null;
    }),
  );
  const warnings = results.filter((w): w is StartupWarning => w !== null);

  if (settings.ui?.showCompatibilityWarnings !== false) {
    warnings.push(
      ...getCompatibilityWarnings({
        isAlternateBuffer: options?.isAlternateBuffer,
      }),
    );
  }

  return warnings;
}
